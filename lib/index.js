/**
 * dsh-search-failover — provider 级搜索池
 * 注册 ctx.web 的 searchProvider + fetchProvider (id: search-pool),
 * 原生 web_search / web_fetch 工具不变, 内部按策略轮询多个后端并做额度感知熔断。
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

/** web_search_from 工具结果的模型可见格式化(纯函数, 不回显内部 live 对象) */
function formatSearchFrom(value) {
  const prov = Array.isArray(value.providers) && value.providers.length
    ? value.providers.join(', ')
    : (value.source ?? 'search-pool')
  const src = Array.isArray(value.sources)
    ? value.sources.map((s, i) => {
        const title = s.title ?? s.url
        return `${i + 1}. [${title}](${s.url})${s.snippet ? `\n   ${s.snippet}` : ''}`
      }).join('\n')
    : ''
  return `[search-pool · ${prov}]${src ? `\n${src}` : ' (无结果)'}${value.truncated ? '\n(结果已截断)' : ''}`
}

export function apply(ctx, config) {
  const base = resolveKeys(ctx, config ?? {})

  // settings 服务存在时注册命名空间: source() 返回实时解析值 (行内 base + user 覆盖)
  const settingsSource = installSearchPoolSettings(ctx, base)

  // provider 每次读取: 行内完整配置 (含 apiKeyEnv 等字段) 合并 settings 的 apiKey/baseURL/priority 覆盖
  const readConfig = () => mergeConfigWithSettings(base, settingsSource())

  const provider = new SearchPoolProvider(readConfig)
  // webServer/settings 是注入服务, apply 阶段同步 ctx.get 拿不到 (dsh-market 同款
  // 写法: ctx.inject 等 service 就绪后再挂 HTTP 路由与读 settings 服务。
  ctx.inject(['webServer', 'settings'], (hostCtx) => {
    mountSearchPoolRoutes(hostCtx, { readConfig, provider, base })
  })
  ctx.on('dispose', () => {})
  ctx.web.registerSearchProvider(provider)
  ctx.web.registerFetchProvider({
    id: SEARCH_POOL_PROVIDER_ID,
    available: () => provider.fetchAvailable(),
    fetch: (request, signal) => provider.fetch(request, signal),
  })

  // 给 AI 一个"显式换源"的工具: AI 觉得结果一般时, 可指定别的引擎再搜/对比。
  // 判断权在 AI 手里; 工具只提供"换引擎的按钮", 默认策略/合并不影响它。
  const tools = ctx.get('tools')
  if (tools !== undefined) {
    const kinds = Object.keys(provider.adapters).join(', ')
    tools.register({
      name: 'web_search_from',
      description: `用指定的搜索后端(引擎)搜索当前信息并返回该源原始结果。当你觉得 web_search 结果不理想/太少/来源单一，想换个引擎再试，或想对比多个引擎时用它。source 可选: ${kinds}。省略 source 则按当前 search-pool 默认策略。`,
      parameters: {
        query: { type: 'string', required: true, description: '搜索关键词' },
        source: { type: 'string', required: false, description: `要用的后端/引擎: ${kinds}。省略=默认策略` },
        maxResults: { type: 'number', required: false, description: '返回条数上限(默认 8)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['sources', 'truncated'],
          properties: {
            source: { type: 'string' },
            content: { type: 'string' },
            providers: { type: 'array', items: { type: 'string' } },
            sources: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['url'],
                properties: {
                  url: { type: 'string' },
                  title: { type: 'string' },
                  snippet: { type: 'string' },
                  publishedAt: { type: 'string' },
                },
              },
            },
            truncated: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: formatSearchFrom(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const a = (args ?? {})
        const query = typeof a.query === 'string' && a.query.trim() ? a.query.trim() : ''
        if (!query) throw new Error('web_search_from: query is required')
        const req = { query }
        const source = typeof a.source === 'string' && a.source.trim() ? a.source.trim() : null
        if (source) req.source = source
        if (Number.isFinite(a.maxResults) && a.maxResults > 0) req.maxResults = a.maxResults
        const result = await provider.search(req, exec.signal)
        return {
          ...(source ? { source } : {}),
          ...(result.content !== undefined ? { content: result.content } : {}),
          ...(result.providers ? { providers: result.providers } : {}),
          sources: (result.sources ?? []).map((x) => ({
            url: x.url,
            ...(x.title !== undefined ? { title: x.title } : {}),
            ...(x.snippet !== undefined ? { snippet: x.snippet } : {}),
            ...(x.publishedAt !== undefined ? { publishedAt: x.publishedAt } : {}),
          })),
          truncated: !!result.truncated,
        }
      },
    })
  }
}

export { SearchPoolProvider, SEARCH_POOL_PROVIDER_ID }
