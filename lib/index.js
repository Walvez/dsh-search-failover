/**
 * dsh-search-failover — provider 级搜索池
 * 注册一个 ctx.web WebSearchProvider, 原生 web_search 工具不变,
 * 内部按策略轮询多个搜索后端并做额度感知熔断。
 */
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { SearchPoolProvider, SEARCH_POOL_PROVIDER_ID } from './provider.js'

export const name = 'search-pool'
export const inject = ['web']

/** 把 apiKeyEnv 解析成 apiKey: 行内 apiKey > launchEnvironment(.env) > process.env */
function resolveKeys(ctx, config) {
  const env = launchEnvironmentOf(ctx)
  const backends = (config.backends ?? []).map((b) => {
    if (b.apiKey || !b.apiKeyEnv) return b
    const value = env.get(b.apiKeyEnv)?.value
      ?? (typeof process !== 'undefined' ? process.env[b.apiKeyEnv] : undefined)
      ?? ''
    return { ...b, apiKey: value }
  })
  return { ...config, backends }
}

export function apply(ctx, config) {
  const resolved = resolveKeys(ctx, config ?? {})
  const provider = new SearchPoolProvider(() => resolved)
  ctx.on('dispose', () => {})
  ctx.web.registerSearchProvider(provider)
}

export { SearchPoolProvider, SEARCH_POOL_PROVIDER_ID }
