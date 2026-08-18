/**
 * search-pool settings 接线 (host 运行侧): schemastery schema + settings 服务注册。
 *
 * 采用与 dsh-market / dsh-remote-web-ui 相同的 installSettingsSection 语义
 * (内嵌实现, 不额外依赖 dsh-settings 包):
 *   - entry    = 行内配置的默认值 (base 层)
 *   - user     = 设置页保存的覆盖 (settings.yaml user layer)
 *   - source() = 每次调用返回实时解析值 → provider 每次 search 都读它,
 *                保存后立即生效, 无需重启。
 * settings 服务不存在时静默降级: source() 恒返回行内 entry。
 */
import z from '@deepseek-ai/schemastery'
import { SEARCH_POOL_SETTINGS_NS, normalizeConfig } from './settings.js'

export const BackendEntry = z.object({
  id: z.string(),
  kind: z.string(),
  priority: z.number().default(99),
  apiKey: z.string().default(''),
  baseURL: z.string().default(''),
  weight: z.number().default(1),
})

export const SearchPoolSettings = z.object({
  strategy: z.string().default('failover'),
  timeoutMs: z.number().default(15000),
  maxResults: z.number().default(8),
  backends: z.array(BackendEntry).default([]),
  removed: z.array(z.string()).default([]),
  circuit: z
    .object({
      threshold: z.number().default(3),
      burstWindowMs: z.number().default(300000),
      cooldownMs: z.number().default(60000),
      quotaCooldownMs: z.number().default(3600000),
    })
    .default({}),
}).default({})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} resolved 行内配置 (resolveKeys 之后)
 * @returns {() => object} 每次调用返回 settings 实时解析值 (normalizeConfig 形状)
 */
export function installSearchPoolSettings(ctx, resolved) {
  const entry = normalizeConfig(resolved)
  let source = () => entry
  ctx.inject(['settings'], (sctx) => {
    try {
      const scope = sctx.settings.register(SEARCH_POOL_SETTINGS_NS, SearchPoolSettings, {
        base: entry,
      })
      source = () => scope.get()
      scope.watch(() => {})
    } catch (e) {
      console.warn(`[search-pool] settings register failed: ${e?.message ?? e}`)
    }
  })
  return () => source()
}