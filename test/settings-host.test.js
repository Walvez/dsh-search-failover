import test from 'node:test'
import assert from 'node:assert/strict'
import {
  installSearchPoolSettings,
  patchToOps,
  readValue,
  readLiveConfig,
  entryIdCandidates,
  resetOps,
  sameAsBaseline,
  cleanBackend,
  SearchPoolSettings,
  SUPPORTS_VOLATILE,
} from '../lib/settings-host.js'

/** 造一个够用的 cordis ctx: inject 立刻回调, effect 记录下来, fiber.entry 带 id */
function makeCtx(settings, entryId = 'search-pool') {
  const ctx = {
    fiber: { uid: 1, entry: { id: entryId, options: { id: entryId } } },
    effects: [],
    inject: (names, cb) => cb({ ...ctx, settings }),
    on: () => () => {},
    effect: (cb) => {
      ctx.effects.push(cb())
      return () => {}
    },
  }
  return ctx
}

/** 造 0.2.1 形状的 volatile 引用: 只有 get(), loader 会原位提交新值 */
function ref(value) {
  const box = { value }
  return {
    get: () => box.value,
    set: (next) => {
      box.value = next
    },
  }
}

/** 0.2.1 形状的假 settings 服务: describe 给 revision, mutate 写补丁文档 */
function makeModernSettings({ value = {}, revision = 3 } = {}) {
  const state = { value, revision, writes: [], conflicts: 0, configured: [] }
  return {
    state,
    describe: () => [{ ns: 'search-pool', value: state.value, revision: state.revision }],
    mutate: async (ns, ops, expectedRevision) => {
      state.writes.push({ ns, ops, expectedRevision })
      if (state.conflicts > 0) {
        state.conflicts -= 1
        const error = new Error('stale revision')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
      state.revision += 1
    },
    configure: (presentation, owner) => {
      state.configured.push({ presentation, owner })
      return () => {}
    },
  }
}

/** 模拟一个 0.2.1 入口 Config: volatile 字段是引用, 其余是普通值 */
function makeEntryConfig(initial) {
  const refs = {
    strategy: ref(initial.strategy ?? 'failover'),
    backends: ref(initial.backends ?? []),
    removed: ref(initial.removed ?? []),
  }
  return {
    refs,
    config: {
      ...refs,
      timeoutMs: initial.timeoutMs ?? 15000,
      maxResults: 8,
      mergeThreshold: 0,
      circuit: {},
    },
  }
}

test('schemastery >= 3.18.5 时恰好三个字段可写 (volatile)', () => {
  assert.equal(SUPPORTS_VOLATILE, true)
  const meta = (key) => SearchPoolSettings.dict[key].meta
  assert.equal(meta('strategy').volatile, true)
  assert.equal(meta('backends').volatile, true)
  assert.equal(meta('removed').volatile, true)
  // 只由 composition 决定的字段不能被设置页写
  assert.equal(meta('timeoutMs').volatile, undefined)
  assert.equal(meta('maxResults').volatile, undefined)
})

test('readValue/readLiveConfig: 引用取值, 普通值原样, 缺省走兜底', () => {
  assert.equal(readValue(ref('rotate'), 'failover'), 'rotate')
  assert.equal(readValue('plain', 'fallback'), 'plain')
  assert.equal(readValue(ref(undefined), 'fallback'), 'fallback')
  assert.equal(readValue(undefined, 'fallback'), 'fallback')

  const live = readLiveConfig(
    { strategy: ref('rotate'), timeoutMs: 1200 },
    { strategy: 'failover', backends: [{ id: 'exa', kind: 'exa' }] },
  )
  assert.equal(live.strategy, 'rotate')
  assert.equal(live.timeoutMs, 1200)
  assert.equal(live.backends[0].id, 'exa', '兜底字段保留')
})

test('entryIdCandidates: entry id 优先, 末尾兜底 search-pool, 去重', () => {
  assert.deepEqual(entryIdCandidates(makeCtx(undefined, 'search-pool')), ['search-pool'])
  assert.deepEqual(
    entryIdCandidates(makeCtx(undefined, 'web.search-pool')),
    ['web.search-pool', 'search-pool'],
  )
  assert.deepEqual(entryIdCandidates({}), ['search-pool'])
})

test('modern: read() 返回入口 Config 引用的实时值 (含 secret, 不经过 describe 脱敏)', () => {
  const { config, refs } = makeEntryConfig({
    strategy: 'failover',
    backends: [{ id: 'exa', kind: 'exa', apiKey: 'real-key' }],
  })
  const settings = makeModernSettings()
  const store = installSearchPoolSettings(makeCtx(settings), { config, fallback: {} })

  assert.equal(store.mode, 'modern')
  assert.equal(store.read().strategy, 'failover')
  assert.equal(store.read().backends[0].apiKey, 'real-key')

  // loader 原位提交新值 → 不需要事件, 下一次 read() 就是新值
  refs.strategy.set('rotate')
  refs.backends.set([{ id: 'ddg', kind: 'ddg' }])
  assert.equal(store.read().strategy, 'rotate')
  assert.equal(store.read().backends[0].id, 'ddg')
})

test('modern: update() 落成 set 路径操作, 用 describe 的 revision 做乐观锁', async () => {
  const { config } = makeEntryConfig({ strategy: 'failover' })
  const settings = makeModernSettings({ revision: 7 })
  const store = installSearchPoolSettings(makeCtx(settings), { config, fallback: {} })

  await store.update({ backends: [{ id: 'exa', kind: 'exa', apiKey: 'k' }], removed: ['ddg'], timeoutMs: 9000 })

  assert.deepEqual(settings.state.writes[0].ops, [
    { op: 'set', path: ['backends'], value: [{ id: 'exa', kind: 'exa', apiKey: 'k' }] },
    { op: 'set', path: ['removed'], value: ['ddg'] },
  ], '只写 volatile 字段, timeoutMs 由 composition 决定')
  assert.equal(settings.state.writes[0].ns, 'search-pool')
  assert.equal(settings.state.writes[0].expectedRevision, 7)
})

test('modern: 没有可写字段时不该发写请求', async () => {
  const { config } = makeEntryConfig({})
  const settings = makeModernSettings()
  const store = installSearchPoolSettings(makeCtx(settings), { config, fallback: {} })
  await store.update({ timeoutMs: 9000 })
  assert.equal(settings.state.writes.length, 0)
})

test('resetOps: 显式写回快照, 不用 unset (unset 会删掉补丁文档里的行内配置)', () => {
  const ops = resetOps({ strategy: 'rotate', backends: [{ id: 'exa', kind: 'exa' }], removed: ['ddg'] })
  assert.deepEqual(ops.map((op) => op.op), ['set', 'set', 'set'])
  assert.deepEqual(ops.map((op) => op.path[0]), ['strategy', 'backends', 'removed'])
  assert.equal(ops[0].value, 'rotate')
  assert.equal(ops[1].value[0].id, 'exa')
  assert.deepEqual(ops[2].value, ['ddg'])
  // 空基线也给出合法值 (而不是删除键)
  const empty = resetOps(undefined)
  assert.equal(empty[0].value, 'failover')
  assert.deepEqual(empty[1].value, [])
  assert.deepEqual(empty[2].value, [])
})

test('modern: reset() 把 apply() 时的快照写回去 (不删文档里的 backends)', async () => {
  const { config } = makeEntryConfig({ strategy: 'rotate', backends: [{ id: 'exa', kind: 'exa' }] })
  const settings = makeModernSettings()
  const snapshot = { strategy: 'failover', backends: [{ id: 'opencodex', kind: 'opencodex', priority: 1 }], removed: [] }
  const store = installSearchPoolSettings(makeCtx(settings), { config, fallback: {}, snapshot })
  const result = await store.reset()
  assert.equal(result.skipped, false)
  assert.deepEqual(settings.state.writes[0].ops, resetOps(snapshot))
  assert.ok(settings.state.writes[0].ops.every((op) => op.op === 'set'), '绝不发 unset')
})

test('modern: 当前值已等于快照时 reset() 不写文档 (避免无意义重排配置)', async () => {
  const config0 = { strategy: 'rotate', backends: [{ id: 'exa', kind: 'exa' }], removed: [] }
  const { config } = makeEntryConfig(config0)
  const settings = makeModernSettings()
  const store = installSearchPoolSettings(makeCtx(settings), { config, fallback: {}, snapshot: structuredClone(config0) })
  const result = await store.reset()
  assert.equal(result.skipped, true)
  assert.equal(settings.state.writes.length, 0)
})

test('resetOps: 清洗空字符串与运行时标记, 别把 apiKey:"" 噪音写进文档', () => {
  const ops = resetOps({
    strategy: 'failover',
    backends: [
      { id: 'opencodex', kind: 'opencodex', priority: 1, apiKey: '', apiKeyEnv: '', baseURL: '', custom: true, updatedAt: 1 },
      { id: 'exa', kind: 'exa', priority: 2, apiKeyEnv: 'EXA_API_KEY', weight: 1 },
    ],
  })
  const backends = ops[1].value
  assert.deepEqual(backends[0], { id: 'opencodex', kind: 'opencodex', priority: 1 })
  assert.deepEqual(backends[1], { id: 'exa', kind: 'exa', priority: 2, apiKeyEnv: 'EXA_API_KEY', weight: 1 })
})

test('sameAsBaseline: 忽略空字符串与运行时标记, 顺序/字段差异仍判不等', () => {
  const base = { strategy: 'failover', backends: [{ id: 'exa', kind: 'exa', priority: 1 }], removed: [] }
  assert.equal(sameAsBaseline({ ...base, backends: [{ id: 'exa', kind: 'exa', priority: 1, apiKey: '' }] }, base), true)
  assert.equal(sameAsBaseline({ ...base, strategy: 'rotate' }, base), false)
  assert.equal(sameAsBaseline({ ...base, removed: ['ddg'] }, base), false)
  assert.equal(sameAsBaseline({ ...base, backends: [{ id: 'exa', kind: 'exa', priority: 2 }] }, base), false)
})

test('modern: 拿不到快照时 reset() 明确报错 (不冒删配置的险)', async () => {
  const settings = makeModernSettings()
  const store = installSearchPoolSettings(makeCtx(settings), { fallback: {} })
  await assert.rejects(() => store.reset(), /baseline unavailable|请在 cordis\.patch\.yml 里手动还原/)
})

test('modern: revision 冲突时重读重试一次', async () => {
  const { config } = makeEntryConfig({})
  const settings = makeModernSettings({ revision: 2 })
  settings.state.conflicts = 1
  const store = installSearchPoolSettings(makeCtx(settings), { config, fallback: {} })

  await store.update({ strategy: 'rotate' })
  assert.equal(settings.state.writes.length, 2, '冲突后重试了一次')
  assert.equal(settings.state.writes[0].expectedRevision, 2)
})

test('modern: 关掉自动生成的通用设置页 (自带 settings.section)', () => {
  const { config } = makeEntryConfig({})
  const settings = makeModernSettings()
  const ctx = makeCtx(settings)
  installSearchPoolSettings(ctx, { config, fallback: {} })
  assert.equal(settings.state.configured.length, 1)
  assert.deepEqual(settings.state.configured[0].presentation, { auto: false })
  assert.equal(settings.state.configured[0].owner, ctx.fiber)
})

test('modern: entry id 带前缀时按候选解析命名空间', async () => {
  const { config } = makeEntryConfig({})
  const settings = makeModernSettings()
  settings.describe = () => [{ ns: 'web.search-pool', value: {}, revision: 5 }]
  const store = installSearchPoolSettings(makeCtx(settings, 'web.search-pool'), { config, fallback: {} })
  await store.update({ strategy: 'rotate' })
  assert.equal(settings.state.writes[0].ns, 'web.search-pool')
  assert.equal(settings.state.writes[0].expectedRevision, 5)
})

test('modern: describe 里找不到本 entry 时尝试写入并给出警告, 不崩', async () => {
  const { config } = makeEntryConfig({})
  const settings = makeModernSettings()
  settings.describe = () => []
  const warnings = []
  const original = console.warn
  console.warn = (m) => warnings.push(String(m))
  try {
    const store = installSearchPoolSettings(makeCtx(settings), { config, fallback: {} })
    await store.update({ strategy: 'rotate' })
  } finally {
    console.warn = original
  }
  assert.equal(settings.state.writes[0].ns, 'search-pool', '退回默认命名空间')
  assert.equal(settings.state.writes[0].expectedRevision, undefined)
  assert.ok(warnings.some((w) => w.includes('settings entry not found')), '要能看出是 id 对不上')
})

test('legacy 0.2.0: register() 分支仍可用', async () => {
  const user = {}
  const base = { strategy: 'failover', backends: [{ id: 'exa', kind: 'exa', apiKey: 'from-env' }] }
  const service = {
    register: (ns, _schema, opts) => {
      assert.equal(ns, 'search-pool')
      return {
        get: () => ({ ...opts.base, ...user }),
        update: async (patch) => {
          Object.assign(user, patch)
        },
        replace: async (next) => {
          for (const key of Object.keys(user)) delete user[key]
          Object.assign(user, next)
        },
        watch: () => {},
      }
    },
  }
  const store = installSearchPoolSettings(makeCtx(service), { fallback: base })

  assert.equal(store.mode, 'legacy')
  assert.equal(store().backends[0].apiKey, 'from-env')
  await store.update({ strategy: 'rotate' })
  assert.equal(store.read().strategy, 'rotate')
  await store.reset()
  assert.equal(store.read().strategy, 'failover')
})

test('无 settings 服务: 降级为行内配置, 写入明确报错', async () => {
  const ctx = { inject: () => {} }
  const store = installSearchPoolSettings(ctx, {
    fallback: { strategy: 'failover', backends: [{ id: 'exa', kind: 'exa', apiKey: 'k' }] },
  })

  assert.equal(store.mode, 'none')
  assert.equal(store().backends[0].apiKey, 'k')
  await assert.rejects(() => store.update({ strategy: 'rotate' }), /settings service unavailable/)
})

test('patchToOps: 只认 volatile 字段', () => {
  assert.deepEqual(patchToOps({ strategy: 'rotate', backends: [], removed: ['a'], circuit: {}, timeoutMs: 1 }), [
    { op: 'set', path: ['strategy'], value: 'rotate' },
    { op: 'set', path: ['backends'], value: [] },
    { op: 'set', path: ['removed'], value: ['a'] },
  ])
  assert.deepEqual(patchToOps(null), [])
  assert.deepEqual(patchToOps({ timeoutMs: 1000 }), [])
})
