/**
 * search-pool 配置合并纯逻辑 (无外部依赖, 可单测)。
 * 运行接线见 settings-host.js (schemastery schema + settings 服务注册)。
 */

export const SEARCH_POOL_SETTINGS_NS = 'search-pool'

/** 一个后端可填多个 Key: 换行或逗号分隔, 去空白 */
export function splitKeys(raw) {
  if (raw == null || raw === '') return []
  return String(raw).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
}

/** 结构化: 从行内配置提取 settings 认识的字段 */
export function normalizeConfig(cfg) {
  const resolved = cfg ?? {}
  return {
    strategy: resolved.strategy ?? 'failover',
    timeoutMs: resolved.timeoutMs ?? 15000,
    maxResults: resolved.maxResults ?? 8,
    mergeThreshold: resolved.mergeThreshold ?? 0,
    backends: (resolved.backends ?? []).map((b) => ({
      id: b.id,
      kind: b.kind,
      priority: b.priority ?? 99,
      apiKey: b.apiKey ?? '',
      baseURL: b.baseURL ?? '',
      weight: b.weight ?? 1,
    })),
    circuit: resolved.circuit ?? {},
    removed: resolved.removed ?? [],
  }
}

/** 把 settings 解析值合并回后端对象 (保持与 backends.js 的调用形状一致) */
export function mergeSettingsBackend(base, patch) {
  return {
    ...base,
    ...(patch?.apiKey ? { apiKey: patch.apiKey } : {}),
    ...(patch?.baseURL ? { baseURL: patch.baseURL } : {}),
    ...(patch?.priority !== undefined ? { priority: patch.priority } : {}),
    ...(patch?.weight !== undefined ? { weight: patch.weight } : {}),
  }
}

/**
 * 最终配置 = 行内完整配置 (含 apiKeyEnv 等字段) + settings 覆盖 (apiKey/baseURL/priority/weight) + circuit 合并。
 * - settings.removed 里的 id 从行内配置中剔除 (删除的"内置"后端)
 * - settings 里新增的 id (行内没有的) 视为自定义后端, 追加到队尾, 并打 custom 标记
 * - 标量策略字段 (timeoutMs/maxResults/mergeThreshold) 始终以行内 base 为准:
 *   settings 路由只写 backends/removed/strategy, 从不写这三个字段; 而 settings
 *   服务的 scope.get() 返回的是 schema 全量解析值 (缺省 timeoutMs=15000), 直接
 *   {...base, ...s} 会把行内 90000 用 schema 默认 15000 盖掉, 导致 opencodex
 *   sidecar (实测 40s+) 每次 15s 被掐断。strategy 例外: /search-pool/config
 *   路由允许用户切换, 保留 s 优先。
 * @param {object} base 行内配置 (resolveKeys 之后)
 * @param {object} s    settings 实时解析值 (normalizeConfig 形状, 含 user 覆盖)
 */
export function mergeConfigWithSettings(base, s) {
  const removed = new Set(s?.removed ?? [])
  const known = new Set((base.backends ?? []).map((b) => b.id))
  const backends = (base.backends ?? [])
    .filter((b) => !removed.has(b.id))
    .map((b) => {
      const patch = (s?.backends ?? []).find((x) => x.id === b.id)
      return patch ? mergeSettingsBackend(b, patch) : b
    })
  // 追加自定义后端 (settings 里有、行内没有): 保留完整字段 + custom 标记
  for (const sb of s?.backends ?? []) {
    if (known.has(sb.id)) continue
    backends.push({ ...sb, custom: true })
  }
  return {
    ...base,
    ...s,
    // 行内优先: settings 从不写这些字段, s 里的是 schema 默认, 不能盖行内
    timeoutMs: base.timeoutMs ?? s?.timeoutMs ?? 15000,
    maxResults: base.maxResults ?? s?.maxResults ?? 8,
    mergeThreshold: base.mergeThreshold ?? s?.mergeThreshold ?? 0,
    backends,
    circuit: { ...(base.circuit ?? {}), ...(s?.circuit ?? {}) },
  }
}