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
      const s = this.circuit.stats(b.id)
      const hasKey = Boolean(
        b.apiKey || (b.apiKeyEnv && typeof process !== 'undefined' && process.env[b.apiKeyEnv]),
      )
      return {
        id: b.id,
        kind: b.kind,
        priority: b.priority ?? 99,
        hasKey,
        custom: b.custom ?? false,
        site: this.adapters[b.kind]?.site ?? null,
        state: s.open ? (s.quota ? 'quota-cooldown' : 'open') : 'closed',
        failures: s.failures,
        quota: s.quota,
        cooldownMs: s.cooldownRemainingMs,
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
    const mergeThreshold = config.mergeThreshold ?? 3

    const ordered = [...(config.backends ?? [])]
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    const candidates = ordered.filter((b) => !this.circuit.isOpen(b.id))
    if (candidates.length === 0) {
      this._log('error', 'all backends in cooldown, search failed')
      throw new SearchPoolError('search pool: all backends in cooldown', 'transient')
    }

    const pool = strategy === 'rotate'
      ? weightedRotate(candidates, this.rotateIndex++)
      : candidates

    const tryOne = async (backend) => {
      const adapter = this.adapters[backend.kind]
      if (!adapter) throw new SearchPoolError(`unknown backend kind "${backend.kind}"`, 'transient')
      const t0 = Date.now()
      const apiKey = resolveKey(backend)
      const ctrl = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)
      let outcome
      try {
        outcome = await adapter.search(
          { ...backend, apiKey },
          { query: request.query, maxResults },
          ctrl,
        )
      } catch (e) {
        const ms = Date.now() - t0
        const kind = e?.kind ?? 'transient'
        this.circuit.recordFailure(backend.id, kind)
        if (this.circuit.isOpen(backend.id)) {
          this._log('warn', `circuit opened for ${backend.id} (${kind}, ${ms}ms): ${e?.message?.slice(0, 120)}`)
        } else {
          this._log('warn', `${backend.id} failed (${kind}, ${ms}ms): ${e?.message?.slice(0, 120)}`)
        }
        if (kind === 'abort') throw e
        throw e
      }
      const ms = Date.now() - t0
      this.circuit.recordSuccess(backend.id)
      this._log('info', `ok via ${backend.id} (${outcome.sources.length} sources, ${ms}ms)`)
      return { sources: outcome.sources, outcome }
    }

    // 轮询: 分摊语义 — 命中一个健康后端即可返回, 不跨源合并
    if (strategy === 'rotate') {
      let lastError = null
      for (const backend of pool) {
        try {
          const { sources, outcome } = await tryOne(backend)
          return {
            sources: sources.slice(0, maxResults),
            truncated: sources.length > maxResults,
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

    // failover: 结果质量感知的多源合并 — 当前源结果不足 mergeThreshold 时,
    // 自动依次尝试后续后端并合并去重, 直到凑够或试完所有 (exa 没搜到 → 自动补 serper 等)
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
    const apiKey = resolveKey(backend)
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

function resolveKey(backend) {
  if (backend.apiKey) return backend.apiKey
  if (backend.apiKeyEnv && typeof process !== 'undefined') return process.env[backend.apiKeyEnv] ?? ''
  return ''
}
