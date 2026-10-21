/**
 * search-pool settings 接线 (host 运行侧): 两代 settings 服务的适配层。
 *
 * DSH 0.2.1 删掉了 dsh-settings 的 `settings.register(ns, schema, {base})`，
 * 改成「每个 profile entry 的 Config schema 就是设置命名空间」:
 *   - 可编辑字段必须在 schema 上标 `.volatile()`(schemastery >= 3.18.5); 没有
 *     volatile 字段的 entry 不会被 describe() 收录, 写入报 has no volatile fields
 *   - 读: 入口 Config 的 volatile 字段在运行时是 **引用对象** (`config.x.get()`),
 *     补丁文档写入后由 loader 原位提交, 所以持有引用即可拿到实时值 (无需事件/轮询)
 *   - 写: `settings.mutate(ns, ops, expectedRevision)` → 直接落到 profile 补丁文档
 *     (`cordis.patch.yml`), 由 loader 热应用。ns = profile entry id
 *   - 有自己的设置页时用 `settings.configure({ auto: false })` 关掉自动生成的通用页
 *
 * 为什么读走引用而不是 describe(): describe() 会把 `role('secret')` 字段剥成
 * {hasValue} 占位符, 用它读会把 apiKey 变成空值; 引用 (`fiber.config`) 里是真实值。
 *
 * 两代 API 统一成同一个 store:
 *   read()      当前生效值 (normalizeConfig 形状)
 *   update(pat) 合并写入 (只写 strategy/backends/removed 这些 volatile 字段)
 *   reset()     清掉用户覆盖, 回到 composition 基线
 *   mode        'modern' | 'legacy' | 'none'
 *
 * settings 服务不存在时静默降级: read() 返回行内配置, 写入抛错。
 */
import { SEARCH_POOL_SETTINGS_NS, normalizeConfig } from './settings.js'

let z = null
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch {
  // 离线/单测环境可能未安装 peerDependency @deepseek-ai/schemastery
}

/** schemastery >= 3.18.5 才有 .volatile(); 更老的版本只能失去设置页, 插件照常跑 */
export const SUPPORTS_VOLATILE = Boolean(
  z && typeof z.string === 'function' && typeof z.string().volatile === 'function',
)

/** 标记可写字段; 老 schemastery 上退化成普通字段 (无设置页) */
function vol(schema) {
  return SUPPORTS_VOLATILE ? schema.volatile() : schema
}

/** 由设置页管理的字段: 只有这些标 .volatile() (0.2.1 的可写字段判定) */
export const VOLATILE_FIELDS = ['strategy', 'backends', 'removed']

const BackendEntry = z ? z.object({
  id: z.string(),
  kind: z.string(),
  priority: z.number().default(99),
  apiKey: z.string().role('secret').default(''),
  apiKeyEnv: z.string().default(''),
  baseURL: z.string().default(''),
  weight: z.number().default(1),
}) : null

export const SearchPoolSettings = z ? z.object({
  // ── 设置页可写 (volatile) ──
  strategy: vol(z.string().default('failover')),
  backends: vol(z.array(BackendEntry).default([])),
  removed: vol(z.array(z.string()).default([])),
  // ── 只由 composition 补丁层决定 (非 volatile, 设置页不碰) ──
  timeoutMs: z.number().default(15000),
  maxResults: z.number().default(8),
  mergeThreshold: z.number().default(0),
  circuit: z
    .object({
      threshold: z.number().default(3),
      burstWindowMs: z.number().default(300000),
      cooldownMs: z.number().default(60000),
      quotaCooldownMs: z.number().default(3600000),
    })
    .default({}),
}).default({}) : null

function warn(message) {
  console.warn(`[search-pool] ${message}`)
}

/**
 * 读一个配置值: 0.2.1 的 volatile 字段是引用对象 (`{ get() }`), 0.2.0/单测是普通值。
 * @param {unknown} value 引用或普通值
 * @param {unknown} fallback 引用返回 undefined 时的兜底
 */
export function readValue(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const current = value.get()
    return current === undefined ? fallback : current
  }
  return value === undefined ? fallback : value
}

/**
 * 把入口 Config (含 volatile 引用) 拍平成普通对象, 拿到的就是当前生效值。
 * @param {object} config apply() 收到的 Config
 * @param {object} [fallback] 缺失字段的兜底 (resolveKeys 之后的行内配置)
 */
export function readLiveConfig(config, fallback) {
  const out = { ...(fallback ?? {}) }
  if (config === null || typeof config !== 'object') return out
  for (const key of Object.keys(config)) {
    out[key] = readValue(config[key], fallback?.[key])
  }
  return out
}

/** patch 对象 → settings.mutate 的路径操作 (只认 volatile 字段) */
export function patchToOps(patch) {
  const ops = []
  if (!patch || typeof patch !== 'object') return ops
  for (const key of VOLATILE_FIELDS) {
    if (Object.hasOwn(patch, key) && patch[key] !== undefined) {
      ops.push({ op: 'set', path: [key], value: patch[key] })
    }
  }
  return ops
}

/**
 * 恢复基线用的路径操作。
 *
 * 注意: 这里**不用 unset**。DSH 0.2.1 的 settings 文档就是 profile 的
 * `cordis.patch.yml` 本身 —— 行内配置和"设置页用户层"是同一个文件, `unset`
 * 会把用户手写在补丁文档里的 `backends` 一起删掉 (实测: 点一次重置, 7 个后端
 * 从配置里消失)。改用"把启动时的快照显式写回去", 效果是撤销本次运行期间的
 * 设置页改动, 而不会删除文档里的行内配置。
 *
 * @param {object} [baseline] apply() 时的入口配置快照 (未经 env 解析, 不含密钥)
 */
export function resetOps(baseline) {
  const safe = baseline !== null && typeof baseline === 'object' ? baseline : {}
  const strategy = typeof safe.strategy === 'string' && safe.strategy.length > 0 ? safe.strategy : 'failover'
  const backends = Array.isArray(safe.backends) ? safe.backends : []
  const removed = Array.isArray(safe.removed) ? safe.removed : []
  return [
    { op: 'set', path: ['strategy'], value: strategy },
    { op: 'set', path: ['backends'], value: backends },
    { op: 'set', path: ['removed'], value: removed },
  ]
}

/** 候选 settings 命名空间: entry id 可能被 loader 加前缀, 所以多给几个候选 */
export function entryIdCandidates(ctx) {
  const entry = ctx?.fiber?.entry
  const raw = [entry?.id, entry?.options?.id, SEARCH_POOL_SETTINGS_NS]
  return [...new Set(raw.filter((x) => typeof x === 'string' && x.length > 0))]
}

/**
 * DSH >= 0.2.1: 读引用, 写走 describe()+mutate()。
 * @param {object} ctx cordis context
 * @param {object} settings settings 服务实例
 * @param {() => object} getLive 读当前生效配置
 */
function modernStore(ctx, settings, getLive, getRaw, baseline) {
  const candidates = entryIdCandidates(ctx)
  let warned = false

  const resolveNs = () => {
    let list
    try {
      list = settings.describe()
    } catch (e) {
      warn(`settings describe failed: ${e?.message ?? e}`)
      return { ns: candidates[0], descriptor: undefined }
    }
    for (const ns of candidates) {
      const descriptor = list.find((x) => x.ns === ns)
      if (descriptor !== undefined) return { ns, descriptor }
    }
    if (!warned) {
      warned = true
      const available = list.map((x) => x.ns).slice(0, 12).join(', ')
      warn(
        `settings entry not found for ${candidates.join(' / ')} (available: ${available || 'none'}); `
        + '设置页保存会被拒绝。需要 schemastery >= 3.18.5 的 .volatile() 字段。',
      )
    }
    return { ns: candidates[0], descriptor: undefined }
  }

  const write = async (ops) => {
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { ns, descriptor } = resolveNs()
      try {
        await settings.mutate(ns, ops, descriptor?.revision)
        return
      } catch (e) {
        lastError = e
        // 编辑器里有并发改动 (revision 不匹配) 时重读一次再写
        if (e?.code !== 'SETTINGS_CONFLICT') throw e
      }
    }
    throw lastError
  }

  return {
    mode: 'modern',
    read: () => getLive(),
    raw: () => getRaw(),
    update: async (patch) => {
      const ops = patchToOps(patch)
      if (ops.length === 0) return
      await write(ops)
    },
    reset: async () => {
      if (baseline === undefined) {
        throw new Error('settings baseline unavailable — 请在 cordis.patch.yml 里手动还原')
      }
      await write(resetOps(baseline))
    },
  }
}

/** DSH 0.2.0: 旧的 register() scope 语义 */
function legacyStore(settings, base, getRaw) {
  const scope = settings.register(SEARCH_POOL_SETTINGS_NS, SearchPoolSettings, { base })
  if (typeof scope?.watch === 'function') scope.watch(() => {})
  return {
    mode: 'legacy',
    read: () => scope.get(),
    update: (patch) => scope.update(patch),
    reset: () => (typeof scope.replace === 'function' ? scope.replace({}) : scope.update({})),
  }
}

/**
 * 装好设置接线, 返回可调用对象 (兼容老用法 `const source = install(); source()`)。
 * @param {object} ctx cordis context
 * @param {{ config?: object, fallback?: object, snapshot?: object }} options
 *   config — apply() 收到的入口 Config (0.2.1 起 volatile 字段是引用)
 *   fallback — resolveKeys 之后的行内配置 (settings 服务不可用时的兜底)
 *   snapshot — 未经 env 解析的入口配置快照, reset() 用它把基线写回去
 *              (不能拿 fallback: 那里 apiKey 已被 .env 解析成明文, 写回会泄漏进文档)
 */
export function installSearchPoolSettings(ctx, options = {}) {
  const { config, fallback, snapshot } = options
  const inline = normalizeConfig(fallback ?? config ?? {})
  const getLive = () => normalizeConfig(readLiveConfig(config, fallback))
  // 未经 env 解析的入口配置: 写回文档时用这个, 免得把 .env 解析出的明文 key 落进 git
  const getRaw = () => normalizeConfig(readLiveConfig(config, snapshot ?? {}))

  let store = {
    mode: 'none',
    read: () => inline,
    raw: getRaw,
    update: async () => {
      throw new Error('settings service unavailable: cannot persist search-pool configuration')
    },
    reset: async () => {},
  }

  ctx.inject(['settings'], (sctx) => {
    const settings = sctx?.settings
    if (settings === undefined) return

    // ── >= 0.2.1: entry Config 的 volatile 引用 + describe/mutate ──
    if (typeof settings.describe === 'function' && typeof settings.mutate === 'function') {
      if (!SUPPORTS_VOLATILE) {
        warn('schemastery 缺少 .volatile() (需要 >= 3.18.5): 设置页不可用, 仅使用行内配置')
      }
      store = modernStore(ctx, settings, getLive, getRaw, snapshot)
      // 前端已注册 "搜索池" 设置小节 (settings.section), 关掉自动生成的通用页
      if (typeof settings.configure === 'function') {
        try {
          ctx.effect(() => settings.configure({ auto: false }, ctx.fiber))
        } catch (e) {
          warn(`settings.configure failed: ${e?.message ?? e}`)
        }
      }
      return
    }

    // ── 0.2.0: 每插件 register() 命名空间 ──
    if (typeof settings.register === 'function') {
      try {
        store = legacyStore(settings, inline, getRaw)
      } catch (e) {
        warn(`settings register failed: ${e?.message ?? e}`)
      }
      return
    }

    warn('settings service exposes neither register() nor describe()/mutate()')
  })

  const source = () => store.read()
  source.read = () => store.read()
  source.raw = () => store.raw()
  source.update = (patch) => store.update(patch)
  source.reset = () => store.reset()
  source.live = getLive
  Object.defineProperty(source, 'mode', { get: () => store.mode })
  return source
}
