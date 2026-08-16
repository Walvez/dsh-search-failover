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
  constructor(resolveConfig, adapterRegistry = backends) {
    this.resolveConfig = resolveConfig
    this.adapters = adapterRegistry
    this.circuit = new CircuitBreaker((resolveConfig() ?? {}).circuit ?? {})
    this.rotateIndex = 0
  }

  get id() { return SEARCH_POOL_PROVIDER_ID }

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
        this.circuit.recordSuccess(backend.id)
        const sources = outcome.sources.slice(0, maxResults)
        return {
          sources,
          truncated: outcome.sources.length > maxResults,
          ...(outcome.content ? { content: outcome.content } : {}),
        }
      } catch (e) {
        lastError = e
        const kind = e?.kind ?? 'transient'
        this.circuit.recordFailure(backend.id, kind)
        if (kind === 'abort') throw e
      }
    }
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
