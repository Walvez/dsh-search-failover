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
   * @param logger cordis logger (ctx.logger) 或带 info/warn/error/debug 的假对象
   */
  constructor(resolveConfig, adapterRegistry = backends, logger = null) {
    this.resolveConfig = resolveConfig
    this.adapters = adapterRegistry
    this.logger = logger
    this.circuit = new CircuitBreaker((resolveConfig() ?? {}).circuit ?? {})
    this.rotateIndex = 0
  }

  get id() { return SEARCH_POOL_PROVIDER_ID }

  _log(level, msg) { this.logger?.[level]?.(`[search-pool] ${msg}`) }

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

    const ordered = [...(config.backends ?? [])]
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    const candidates = ordered.filter((b) => !this.circuit.isOpen(b.id))
    if (candidates.length === 0) {
      this._log('error', 'all backends in cooldown, search failed')
      throw new SearchPoolError('search pool: all backends in cooldown', 'transient')
    }

    const pool = strategy === 'rotate'
      ? rotateFrom(candidates, this.rotateIndex++)
      : candidates

    let lastError = null
    for (const backend of pool) {
      const adapter = this.adapters[backend.kind]
      if (!adapter) {
        lastError = new SearchPoolError(`unknown backend kind "${backend.kind}"`, 'transient')
        continue
      }
      const t0 = Date.now()
      const apiKey = resolveKey(backend)
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
        this.circuit.recordSuccess(backend.id)
        this._log('info', `ok via ${backend.id} (${outcome.sources.length} sources, ${ms}ms)`)
        const sources = outcome.sources.slice(0, maxResults)
        return {
          sources,
          truncated: outcome.sources.length > maxResults,
          ...(outcome.content ? { content: outcome.content } : {}),
        }
      } catch (e) {
        const ms = Date.now() - t0
        lastError = e
        const kind = e?.kind ?? 'transient'
        this.circuit.recordFailure(backend.id, kind)
        if (this.circuit.isOpen(backend.id)) {
          this._log('warn', `circuit opened for ${backend.id} (${kind}, ${ms}ms): ${e?.message?.slice(0, 120)}`)
        } else {
          this._log('warn', `${backend.id} failed (${kind}, ${ms}ms): ${e?.message?.slice(0, 120)}`)
        }
        if (kind === 'abort') throw e
      }
    }
    this._log('error', `all backends failed: ${lastError?.message ?? 'unknown'}`)
    throw new SearchPoolError(
      `all search backends failed (tried ${pool.length}): ${lastError?.message ?? 'unknown'}`,
      'transient',
    )
  }
}

function rotateFrom(list, index) {
  if (list.length < 2) return list
  const i = index % list.length
  return [...list.slice(i), ...list.slice(0, i)]
}

function resolveKey(backend) {
  if (backend.apiKey) return backend.apiKey
  if (backend.apiKeyEnv && typeof process !== 'undefined') return process.env[backend.apiKeyEnv] ?? ''
  return ''
}
