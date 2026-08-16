/**
 * dsh-search-failover — provider 级搜索池
 * 注册一个 ctx.web WebSearchProvider, 原生 web_search 工具不变,
 * 内部按策略轮询多个搜索后端并做额度感知熔断。
 */
import { SearchPoolProvider, SEARCH_POOL_PROVIDER_ID } from './provider.js'

export const name = 'search-pool'
export const inject = ['web']

export function apply(ctx, config) {
  const resolved = config ?? {}
  const provider = new SearchPoolProvider(() => resolved)
  ctx.on('dispose', () => {})
  ctx.web.registerSearchProvider(provider)
}

export { SearchPoolProvider, SEARCH_POOL_PROVIDER_ID }
