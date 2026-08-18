/**
 * dsh-search-failover — provider 级搜索池
 * 注册一个 ctx.web WebSearchProvider, 原生 web_search 工具不变,
 * 内部按策略轮询多个搜索后端并做额度感知熔断。
 *
 * 配置来源 (优先级由低到高):
 *  1. 行内 config (cordis.patch.yml) + launchEnvironment(.env)/process.env 解析 key
 *  2. settings 服务的 user 覆盖 (设置页保存的 apiKey/baseURL/priority)
 *     每次 search 实时读取 → 保存后立即生效, 无需重启。
 * 另有 /search-pool/* HTTP 路由给设置页提供状态与保存通道。
 */
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { SearchPoolProvider, SEARCH_POOL_PROVIDER_ID } from './provider.js'
import { installSearchPoolSettings } from './settings-host.js'
import { mergeConfigWithSettings } from './settings.js'
import { mountSearchPoolRoutes } from './routes.js'

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
  const base = resolveKeys(ctx, config ?? {})

  // settings 服务存在时注册命名空间: source() 返回实时解析值 (行内 base + user 覆盖)
  const settingsSource = installSearchPoolSettings(ctx, base)

  // provider 每次读取: 行内完整配置 (含 apiKeyEnv 等字段) 合并 settings 的 apiKey/baseURL/priority 覆盖
  const readConfig = () => mergeConfigWithSettings(base, settingsSource())

  const provider = new SearchPoolProvider(readConfig)
  mountSearchPoolRoutes(ctx, { readConfig, provider })
  ctx.on('dispose', () => {})
  ctx.web.registerSearchProvider(provider)
}

export { SearchPoolProvider, SEARCH_POOL_PROVIDER_ID }