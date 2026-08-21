/**
 * SearchPoolProvider — ctx.web 搜索池 provider (id: search-pool)
 * 策略:
 *  - failover: 按 priority 升序尝试, 第一个成功即返回
 *  - rotate:   健康后端轮询 (分散免费额度)
 * 每个后端失败按 kind 记录进熔断器; abort 立即终止; 全部失败抛错。
 */
import { CircuitBreaker } from './circuit.js'
import { backends } from './backends.js'
import { SearchPoolError } from './errors.js'
import { splitKeys } from './settings.js'

export const SEARCH_POOL_PROVIDER_ID = 'search-pool'

export class SearchPoolProvider {
  /**
   * @param resolveConfig 读取配置的函数
   * @param adapterRegistry 后端适配器表 (测试可注入假后端)
   * @param logger 可选日志对象; 缺省用 console (ctx.logger 在 web 运行时
   *              不落终端, 与 auto-memory 插件一样直接 console 输出)
   */
  constructor(resolveConfig, adapterRegistry = backends, logger = null) {
    this.resolveConfig = resolveConfig
    this.adapters = adapterRegistry
    this.logger = logger
    this.circuit = new CircuitBreaker((resolveConfig() ?? {}).circuit ?? {})
    this.rotateIndex = 0
  }

  get id() { return SEARCH_POOL_PROVIDER_ID }

  /** 只读状态快照: 给设置页展示后端 key 有无 / 熔断 / 冷却倒计时 */
  state() {
    const config = this.resolveConfig() ?? {}
    const now = Date.now()
    // UI 显示顺序 = 优先级顺序: ↑↓ 重排通过改写 priority 生效
    const backends = (config.backends ?? [])
      .slice()
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((b) => {
      const keys = keyList(b)
      const cids = circuitIds(b)
      const openStats = cids.map((id) => this.circuit.stats(id))
      const allOpen = openStats.length > 0 && openStats.every((s) => s.open)
      const quota = allOpen && openStats.some((s) => s.quota)
      const cooldownMs = allOpen ? Math.max(0, ...openStats.map((s) => s.cooldownRemainingMs)) : 0
      const failures = openStats.reduce((n, s) => n + s.failures, 0)
      const hasKey = keys.some(Boolean)
      const adapter = this.adapters[b.kind]
      return {
        id: b.id,
        kind: b.kind,
        priority: b.priority ?? 99,
        hasKey,
        keyCount: keys.filter(Boolean).length,
        hasFetch: typeof adapter?.fetch === 'function',
        custom: b.custom ?? false,
        site: adapter?.site ?? null,
        state: allOpen ? (quota ? 'quota-cooldown' : 'open') : 'closed',
        failures,
        quota,
        cooldownMs,
        updatedAt: now,
      }
    })
    return {
      strategy: config.strategy ?? 'failover',
      timeoutMs: config.timeoutMs ?? 15000,
      maxResults: config.maxResults ?? 8,
      kinds: Object.keys(this.adapters),
      circuit: {
        threshold: this.circuit.threshold,
        burstWindowMs: this.circuit.burstWindowMs,
        cooldownMs: this.circuit.cooldownMs,
        quotaCooldownMs: this.circuit.quotaCooldownMs,
      },
      backends,
    }
  }

  _log(level, msg) {
    const line = `[search-pool] ${msg}`
    if (this.logger) this.logger[level]?.(line)
    else if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }

  /** 廉价可用性检查, 不得发网络请求 */
  available() {
    const c = this.resolveConfig() ?? {}
    return Array.isArray(c.backends) && c.backends.length > 0
  }

  async search(request, signal) {
    const config = this.resolveConfig() ?? {}
    const maxResults = request.maxResults ?? config.maxResults ?? 8
    const timeoutMs = config.timeoutMs ?? 15_000
    const strategy = config.strategy ?? 'failover'
    // mergeThreshold: 0(默认)=不跨源合并, 首源成功即返回; >0 时结果不足阈值会自动追加后续源
    const mergeThreshold = Math.max(0, config.mergeThreshold ?? 0)

    const ordered = [...(config.backends ?? [])]
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    const candidates = ordered.filter((b) => !backendFullyOpen(this.circuit, b))
    if (candidates.length === 0) {
      this._log('error', 'all backends in cooldown, search failed')
      throw new SearchPoolError('search pool: all backends in cooldown', 'transient')
    }

    // request.source: AI 可显式指定只用某一个引擎(kind/id), 无视策略与合并, 只搜这一个
    let pool
    if (request.source) {
      const targeted = candidates.find((b) => b.kind === request.source || b.id === request.source)
      if (!targeted) {
        this._log('error', `unknown search source "${request.source}"`)
        throw new SearchPoolError(
          `unknown search source "${request.source}" (available: ${candidates.map((b) => b.kind).join(', ')})`,
          'transient',
        )
      }
      pool = [targeted]
    } else {
      pool = strategy === 'rotate'
        ? weightedRotate(candidates, this.rotateIndex++)
        : candidates
    }

    const tryOne = async (backend) => {
      const adapter = this.adapters[backend.kind]
      if (!adapter) throw new SearchPoolError(`unknown backend kind "${backend.kind}"`, 'transient')
      const keys = usableKeys(this.circuit, backend)
      if (keys.length === 0) throw new SearchPoolError(`${backend.id}: all keys in cooldown`, 'transient')
      let lastError = null
      for (const apiKey of keys) {
        const cid = circuitId(backend, apiKey)
        const t0 = Date.now()
        const ctrl = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs)
        try {
          const outcome = await adapter.search(
            { ...backend, apiKey },
            { query: request.query, maxResults },
            ctrl,
          )
          const ms = Date.now() - t0
          this.circuit.recordSuccess(cid)
          this._log('info', `ok via ${backend.id} (${outcome.sources.length} sources, ${ms}ms)`)
          return { sources: outcome.sources, outcome }
        } catch (e) {
          const ms = Date.now() - t0
          const kind = e?.kind ?? 'transient'
          this.circuit.recordFailure(cid, kind)
          const label = apiKey ? `${backend.id}/${maskKey(apiKey)}` : backend.id
          if (this.circuit.isOpen(cid)) {
            this._log('warn', `circuit opened for ${label} (${kind}, ${ms}ms): ${e?.message?.slice(0, 120)}`)
          } else {
            this._log('warn', `${label} failed (${kind}, ${ms}ms): ${e?.message?.slice(0, 120)}`)
          }
          if (kind === 'abort') throw e
          lastError = e
        }
      }
      throw lastError ?? new SearchPoolError(`${backend.id}: all keys failed`, 'transient')
    }

    // 轮询: 分摊语义 — 命中一个健康后端即可返回, 不跨源合并
    if (strategy === 'rotate' && !request.source) {
      let lastError = null
      for (const backend of pool) {
        try {
          const { sources, outcome } = await tryOne(backend)
          return {
            sources: sources.slice(0, maxResults),
            truncated: sources.length > maxResults,
            providers: [backend.id],
            ...(outcome.content ? { content: outcome.content } : {}),
          }
        } catch (e) {
          lastError = e
          if (e?.kind === 'abort') throw e
        }
      }
      this._log('error', `all backends failed: ${lastError?.message ?? 'unknown'}`)
      throw new SearchPoolError(
        `all search backends failed (tried ${pool.length}): ${lastError?.message ?? 'unknown'}`,
        'transient',
      )
    }

    // failover 默认(mergeThreshold=0): 首源成功即返回 — 是否换源由 AI 自行用 web_search_from 决定
    if (mergeThreshold <= 0) {
      let lastError = null
      for (const backend of pool) {
        try {
          const { sources, outcome } = await tryOne(backend)
          return {
            sources: sources.slice(0, maxResults),
            truncated: sources.length > maxResults,
            providers: [backend.id],
            ...(outcome.content ? { content: outcome.content } : {}),
          }
        } catch (e) {
          lastError = e
          if (e?.kind === 'abort') throw e
        }
      }
      this._log('error', `all backends failed: ${lastError?.message ?? 'unknown'}`)
      throw new SearchPoolError(
        `all search backends failed (tried ${pool.length}): ${lastError?.message ?? 'unknown'}`,
        'transient',
      )
    }

    // 多源合并(显式开启): 当前源结果不足 mergeThreshold 时自动追加后续后端并合并去重
    const collected = []
    let collectedContent = null
    const providers = []
    let lastError = null
    for (const backend of pool) {
      try {
        const { sources, outcome } = await tryOne(backend)
        providers.push(backend.id)
        for (const s of sources) {
          if (!collected.some((x) => x.url === s.url)) collected.push(s)
        }
        if (outcome.content && !collectedContent) collectedContent = outcome.content
        if (collected.length >= mergeThreshold) break
      } catch (e) {
        lastError = e
        if (e?.kind === 'abort') throw e
      }
    }
    if (collected.length === 0) {
      this._log('error', `all backends failed: ${lastError?.message ?? 'unknown'}`)
      throw new SearchPoolError(
        `all search backends failed (tried ${pool.length}): ${lastError?.message ?? 'unknown'}`,
        'transient',
      )
    }
    const sources = collected.slice(0, maxResults)
    return {
      sources,
      truncated: collected.length > maxResults,
      providers,
      ...(collectedContent ? { content: collectedContent } : {}),
    }
  }

  /**
   * 测试连接: 对该后端发起一次真实轻量搜索 (1 条) — 设置页「测试」按钮用。
   * 注意会消耗该后端 1 次配额; 失败时抛错 (message 含原因)。
   */
  async probe(id) {
    const config = this.resolveConfig() ?? {}
    const backend = (config.backends ?? []).find((b) => b.id === id)
    if (!backend) throw new SearchPoolError(`unknown backend id "${id}"`, 'transient')
    const adapter = this.adapters[backend.kind]
    if (!adapter) throw new SearchPoolError(`unknown backend kind "${backend.kind}"`, 'transient')
    const t0 = Date.now()
    const apiKey = usableKeys(this.circuit, backend)[0] ?? ''
    const result = await adapter.search(
      { ...backend, apiKey },
      { query: 'search pool connectivity test', maxResults: 1 },
      AbortSignal.timeout(10_000),
    )
    return {
      ok: true,
      sources: (result?.sources ?? []).length,
      ms: Date.now() - t0,
    }
  }

  /** 廉价可用性检查, 不得发网络请求 — fetch 与 search 共用同一池 */
  fetchAvailable() {
    const c = this.resolveConfig() ?? {}
    return (c.backends ?? []).some((b) => typeof this.adapters[b.kind]?.fetch === 'function')
  }

  /**
   * 网页抓取: 只走声明了 fetch() 的适配器 (jina/exa/tavily/firecrawl)。
   * 熔断与多 Key 轮换与 search 共用。
   */
  async fetch(request, signal) {
    const config = this.resolveConfig() ?? {}
    const timeoutMs = config.timeoutMs ?? 15_000
    const strategy = config.strategy ?? 'failover'
    const ordered = [...(config.backends ?? [])]
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .filter((b) => typeof this.adapters[b.kind]?.fetch === 'function')
      .filter((b) => !backendFullyOpen(this.circuit, b))
    if (ordered.length === 0) {
      throw new SearchPoolError('search pool: no fetch-capable backends available', 'transient')
    }
    const pool = strategy === 'rotate'
      ? weightedRotate(ordered, this.rotateIndex++)
      : ordered
    let lastError = null
    for (const backend of pool) {
      const adapter = this.adapters[backend.kind]
      const keys = usableKeys(this.circuit, backend)
      if (keys.length === 0) continue
      for (const apiKey of keys) {
        const cid = circuitId(backend, apiKey)
        const t0 = Date.now()
        const ctrl = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs)
        try {
          const outcome = await adapter.fetch({ ...backend, apiKey }, { url: request.url }, ctrl)
          const ms = Date.now() - t0
          this.circuit.recordSuccess(cid)
          this._log('info', `fetch ok via ${backend.id} (${ms}ms)`)
          const content = outcome?.content ?? ''
          return {
            url: outcome?.url || request.url,
            statusCode: 200,
            body: { kind: 'text', content },
            truncated: !!outcome?.truncated,
          }
        } catch (e) {
          const ms = Date.now() - t0
          const kind = e?.kind ?? 'transient'
          this.circuit.recordFailure(cid, kind)
          this._log('warn', `fetch ${backend.id}/${maskKey(apiKey)} failed (${kind}, ${ms}ms): ${e?.message?.slice(0, 120)}`)
          if (kind === 'abort') throw e
          lastError = e
        }
      }
    }
    throw new SearchPoolError(
      `all fetch backends failed: ${lastError?.message ?? 'unknown'}`,
      'transient',
    )
  }
}

/** 加权轮询: 按 weight 展开后整体轮转 (weight 1..10, 默认 1) */
function weightedRotate(list, index) {
  if (list.length < 2) return list
  const expanded = []
  for (const b of list) {
    const w = Math.max(1, Math.min(10, Math.floor(b.weight ?? 1)))
    for (let i = 0; i < w; i++) expanded.push(b)
  }
  const i = index % expanded.length
  return [...expanded.slice(i), ...expanded.slice(0, i)]
}

function keyList(backend) {
  const fromField = splitKeys(backend.apiKey)
  if (fromField.length) return fromField
  if (backend.apiKeyEnv && typeof process !== 'undefined') {
    const envVal = process.env[backend.apiKeyEnv] ?? ''
    const fromEnv = splitKeys(envVal)
    if (fromEnv.length) return fromEnv
  }
  // 无 key 的后端 (tavily keyless / ddg / searxng) 仍给一个空串占位, 让适配器自己决定
  return ['']
}

function circuitId(backend, apiKey) {
  const keys = keyList(backend).filter(Boolean)
  if (keys.length <= 1) return backend.id
  if (!apiKey) return backend.id
  const tag = apiKey.length <= 8 ? apiKey : `${apiKey.slice(0, 4)}…${apiKey.slice(-3)}`
  return `${backend.id}#${tag}`
}

function circuitIds(backend) {
  return keyList(backend).map((k) => circuitId(backend, k))
}

function backendFullyOpen(circuit, backend) {
  const ids = circuitIds(backend)
  return ids.length > 0 && ids.every((id) => circuit.isOpen(id))
}

function usableKeys(circuit, backend) {
  return keyList(backend).filter((k) => !circuit.isOpen(circuitId(backend, k)))
}

function maskKey(apiKey) {
  if (!apiKey) return 'anon'
  if (apiKey.length <= 8) return '***'
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-3)}`
}
