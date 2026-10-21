/**
 * dsh-search-failover — provider 级搜索池
 * 注册 ctx.web 的 searchProvider + fetchProvider (id: search-pool),
 * 原生 web_search / web_fetch 工具不变, 内部按策略轮询多个后端并做额度感知熔断。
 *
 * 配置来源 (优先级由低到高):
 *  1. 行内 config (cordis.patch.yml) + launchEnvironment(.env)/process.env 解析 key
 *  2. 设置页保存的覆盖 (strategy/backends/removed 这些 volatile 字段)
 *     每次 search 实时读取 → 保存后立即生效, 无需重启。
 *     DSH 0.2.0 走 settings.register 的 user 层; >= 0.2.1 走 entry Config 的
 *     describe()/mutate() (落到 profile 补丁文档), 差异封装在 settings-host.js。
 * 另有 /search-pool/* HTTP 路由给设置页提供状态与保存通道。
 */
import { SearchPoolProvider, SEARCH_POOL_PROVIDER_ID } from './provider.js'
import { SearchPoolSettings, installSearchPoolSettings, readLiveConfig } from './settings-host.js'
import { mergeConfigWithSettings } from './settings.js'
import { mountSearchPoolRoutes } from './routes.js'

let launchEnvironmentOf = null
try {
  launchEnvironmentOf = (await import('@deepseek-ai/dsh-launch-environment')).launchEnvironmentOf
} catch {
  // 离线/单测环境可能未安装 peerDependency @deepseek-ai/dsh-launch-environment
}

let defineTool = null
try {
  defineTool = (await import('@deepseek-ai/dsh-tools')).defineTool
} catch {
  // 离线/单测环境可能未安装 @deepseek-ai/dsh-tools
}

export const name = 'search-pool'
export const inject = ['web']
export const Config = SearchPoolSettings

/** 把 apiKeyEnv 解析成 apiKey: 行内 apiKey > launchEnvironment(.env) > process.env */
function resolveKeys(ctx, config) {
  const env = launchEnvironmentOf ? launchEnvironmentOf(ctx) : null
  const backends = (config.backends ?? []).map((b) => {
    if (b.apiKey || !b.apiKeyEnv) return b
    const value = env?.get(b.apiKeyEnv)?.value
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
  // 0.2.1 起入口 Config 的 volatile 字段是引用对象 (config.x.get()), 拍平才拿得到
  // 真实值 (describe() 会把 role('secret') 剥成占位符, 不能用来读 apiKey)。
  const raw = readLiveConfig(config, {})
  const base = resolveKeys(ctx, raw)

  // 设置接线 (两代 settings API 统一成 store): read() 返回实时解析值
  const settingsStore = installSearchPoolSettings(ctx, { config, fallback: base, snapshot: raw })

  // provider 每次读取: 入口 Config 实时值 (含 volatile 补丁) + 环境变量解析 + 设置覆盖
  const readConfig = () => mergeConfigWithSettings(
    resolveKeys(ctx, readLiveConfig(config, base)),
    settingsStore.read(),
  )

  const provider = new SearchPoolProvider(readConfig)
  // webServer/settings 是注入服务, apply 阶段同步 ctx.get 拿不到 (dsh-market 同款
  // 写法: ctx.inject 等 service 就绪后再挂 HTTP 路由与读 settings 服务。
  ctx.inject(['webServer', 'settings'], (hostCtx) => {
    mountSearchPoolRoutes(hostCtx, { readConfig, provider, base, settingsStore })
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
    const execute = async (args, exec) => {
      const a = (args ?? {})
      const query = typeof a.query === 'string' && a.query.trim() ? a.query.trim() : ''
      if (!query) throw new Error('web_search_from: query is required')
      const req = { query }
      const source = typeof a.source === 'string' && a.source.trim() ? a.source.trim() : null
      if (source) req.source = source
      if (Number.isFinite(a.maxResults) && a.maxResults > 0) req.maxResults = a.maxResults
      const result = await provider.search(req, exec?.signal)
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
    }

    const toolDef = defineTool
      ? defineTool({
          name: 'web_search_from',
          description: `用指定的搜索后端(引擎)搜索当前信息并返回该源原始结果。当你觉得 web_search 结果不理想/太少/来源单一，想换个引擎再试，或想对比多个引擎时用它。source 可选: ${kinds}。省略 source 则按当前 search-pool 默认策略。引擎取舍: opencodex 是 AI 侧搜(慢, 40~150s, 仅长超时会话可用, 被掐断就换 exa); exa/tavily/serper 秒级, 工具超时 60s 的会话优先用它们; ddg 仅兜底且经常无结果; 不在 source 列表里的引擎不可用, 不要编造。`,
          parameters: {
            query: { type: 'string', required: true, description: '搜索关键词' },
            source: { type: 'string', description: `要用的后端/引擎: ${kinds}。省略=默认策略(opencodex 优先)。opencodex 慢, 60s 会话慎用; 求快用 exa` },
            maxResults: { type: 'number', description: '返回条数上限(默认 8)' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source: { type: 'string' },
                content: { type: 'string' },
                providers: { type: 'array', items: { type: 'string' } },
                sources: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      url: { type: 'string', required: true },
                      title: { type: 'string' },
                      snippet: { type: 'string' },
                      publishedAt: { type: 'string' },
                    },
                  },
                },
                truncated: { type: 'boolean', required: true },
              },
            },
            render: (_args, value) => [{ type: 'text', text: formatSearchFrom(value) }],
          },
          isConcurrencySafe: () => true,
          execute,
        })
      : {
          name: 'web_search_from',
          description: `用指定的搜索后端(引擎)搜索当前信息并返回该源原始结果。当你觉得 web_search 结果不理想/太少/来源单一，想换个引擎再试，或想对比多个引擎时用它。source 可选: ${kinds}。省略 source 则按当前 search-pool 默认策略。引擎取舍: opencodex 是 AI 侧搜(慢, 40~150s, 仅长超时会话可用, 被掐断就换 exa); exa/tavily/serper 秒级, 工具超时 60s 的会话优先用它们; ddg 仅兜底且经常无结果; 不在 source 列表里的引擎不可用, 不要编造。`,
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string', description: '搜索关键词' },
              source: { type: 'string', description: `要用的后端/引擎: ${kinds}。省略=默认策略(opencodex 优先)。opencodex 慢, 60s 会话慎用; 求快用 exa` },
              maxResults: { type: 'number', description: '返回条数上限(默认 8)' },
            },
            required: ['query'],
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
          execute,
        }

    tools.register(toolDef)
  }
}

export { SearchPoolProvider, SEARCH_POOL_PROVIDER_ID }
