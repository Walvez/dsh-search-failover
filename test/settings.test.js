import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SEARCH_POOL_SETTINGS_NS,
  normalizeConfig,
  mergeSettingsBackend,
  mergeConfigWithSettings,
} from '../lib/settings.js'
import { installSearchPoolSettings } from '../lib/settings-host.js'

function baseConfig() {
  return {
    strategy: 'failover',
    timeoutMs: 15000,
    maxResults: 8,
    backends: [
      { id: 'exa', kind: 'exa', priority: 1, apiKeyEnv: 'EXA_API_KEY', apiKey: 'from-env' },
      { id: 'serper', kind: 'serper', priority: 2, apiKeyEnv: 'SERPER_API_KEY', apiKey: '' },
    ],
    circuit: { threshold: 3 },
  }
}

test('normalizeConfig: 默认值与行内字段', () => {
  const n = normalizeConfig(baseConfig())
  assert.equal(n.strategy, 'failover')
  assert.equal(n.timeoutMs, 15000)
  assert.equal(n.maxResults, 8)
  assert.equal(n.backends.length, 2)
  assert.equal(n.backends[0].priority, 1)
  assert.equal(n.backends[0].apiKey, 'from-env')
  assert.equal(n.circuit.threshold, 3)
  // 缺失字段落到默认
  const d = normalizeConfig({})
  assert.equal(d.strategy, 'failover')
  assert.deepEqual(d.backends, [])
})

test('mergeSettingsBackend: 非空覆盖 / 空串保留 / 无 patch 原样', () => {
  const b = { id: 'exa', kind: 'exa', apiKey: 'old', apiKeyEnv: 'EXA_API_KEY' }
  assert.equal(mergeSettingsBackend(b, { id: 'exa', apiKey: 'new' }).apiKey, 'new')
  // 空字符串视为"清除覆盖" → 保留现有
  assert.equal(mergeSettingsBackend(b, { id: 'exa', apiKey: '' }).apiKey, 'old')
  assert.equal(mergeSettingsBackend(b, { id: 'exa', priority: 5 }).priority, 5)
  assert.deepEqual(mergeSettingsBackend(b, null), b)
})

test('mergeConfigWithSettings: settings 中的新 id 追加为自定义后端 (可删除还原)', () => {
  const base = baseConfig()
  const s = {
    ...base,
    backends: [
      { id: 'exa', kind: 'exa', priority: 1, apiKey: 'saved', baseURL: '' },
      { id: 'my-searx', kind: 'searxng', priority: 99, apiKey: '', baseURL: 'http://192.168.1.10:8888' },
    ],
  }
  const merged = mergeConfigWithSettings(base, s)
  assert.equal(merged.backends.length, 3)
  const custom = merged.backends.find((b) => b.id === 'my-searx')
  assert.equal(custom.custom, true)
  assert.equal(custom.kind, 'searxng')
  assert.equal(custom.baseURL, 'http://192.168.1.10:8888')
  assert.equal(custom.priority, 99)
  // 内置后端不打 custom 标记
  assert.equal(merged.backends.find((b) => b.id === 'exa').custom, undefined)
  // 自定义从 settings 移除 → 回归行内 2 个
  const merged2 = mergeConfigWithSettings(base, { ...s, backends: [] })
  assert.equal(merged2.backends.length, 2)
})

test('mergeConfigWithSettings: 行内完整字段保留 + settings 覆盖 + circuit 合并', () => {
  const base = baseConfig()
  const s = {
    strategy: 'failover',
    timeoutMs: 15000,
    maxResults: 8,
    backends: [
      { id: 'exa', kind: 'exa', priority: 1, apiKey: 'saved-key', baseURL: '', },
      { id: 'serper', kind: 'serper', priority: 2, apiKey: '', baseURL: '' },
    ],
    circuit: { threshold: 5 },
  }
  const merged = mergeConfigWithSettings(base, s)
  const exa = merged.backends.find((b) => b.id === 'exa')
  assert.equal(exa.apiKey, 'saved-key')
  // 行内的 apiKeyEnv 等字段不因 settings 丢失
  assert.equal(exa.apiKeyEnv, 'EXA_API_KEY')
  assert.equal(exa.id, 'exa')
  assert.equal(merged.circuit.threshold, 5)
  // 未在 settings 里的后端不动
  const extra = mergeConfigWithSettings(base, { ...s, backends: [] })
  assert.equal(extra.backends[0].apiKey, 'from-env')
})

test('installSearchPoolSettings: settings 服务不存在时降级为行内', () => {
  const ctx = {
    get: () => undefined,
    // cordis 的 inject 总是存在: settings 服务缺失时回调永不触发
    inject: () => {},
  }
  const source = installSearchPoolSettings(ctx, { fallback: baseConfig() })
  assert.equal(source().backends[0].apiKey, 'from-env')
})

test('installSearchPoolSettings: 保存后 source() 实时反映 (热生效)', () => {
  let registered = null
  const service = {
    _user: {},
    _opts: null,
    register(ns, schema, opts) {
      const svc = this
      assert.equal(ns, SEARCH_POOL_SETTINGS_NS)
      this._opts = opts
      return {
        // scope.get(): base 层 + user 层合并 (数组整体替换, 同 settings 语义)
        get: () => {
          const base = opts.base
          const u = svc._user
          return {
            ...base,
            strategy: u.strategy ?? base.strategy,
            timeoutMs: u.timeoutMs ?? base.timeoutMs,
            maxResults: u.maxResults ?? base.maxResults,
            backends: u.backends ?? base.backends,
            circuit: { ...base.circuit, ...(u.circuit ?? {}) },
          }
        },
      }
    },
    watch() {},
  }
  const ctx = {
    get: () => service,
    // sctx 需要暴露 settings 属性 (installSearchPoolSettings 里 sctx.settings.register)
    inject: (names, cb) => cb({ ...ctx, settings: service }),
  }
  const source = installSearchPoolSettings(ctx, { fallback: baseConfig() })

  // 初始 = 行内
  assert.equal(source().backends[0].apiKey, 'from-env')

  // 模拟设置页保存 (settings.update → user layer)
  service._user = {
    backends: [
      { id: 'exa', kind: 'exa', priority: 1, apiKey: 'ui-saved', baseURL: '' },
      { id: 'serper', kind: 'serper', priority: 2, apiKey: '', baseURL: '' },
    ],
  }
  const merged = mergeConfigWithSettings(baseConfig(), source())
  assert.equal(merged.backends.find((b) => b.id === 'exa').apiKey, 'ui-saved')
  assert.equal(merged.backends.find((b) => b.id === 'exa').apiKeyEnv, 'EXA_API_KEY')

  // 再改一次 → 再次热生效
  service._user = { backends: [] }
  const merged2 = mergeConfigWithSettings(baseConfig(), source())
  assert.equal(merged2.backends[0].apiKey, 'from-env')
})
test('mergeConfigWithSettings: removed 过滤行内后端 (删除内置后恢复可清标记)', () => {
  const base = baseConfig()
  const removed = mergeConfigWithSettings(base, { ...normalizeConfig(base), removed: ['exa'] })
  assert.equal(removed.backends.some((b) => b.id === 'exa'), false)
  assert.equal(removed.backends.length, 1)
  const restored = mergeConfigWithSettings(base, { ...normalizeConfig(base), removed: [] })
  assert.equal(restored.backends.some((b) => b.id === 'exa'), true)
  assert.equal(restored.backends.length, 2)
})

test('splitKeys: 换行与逗号分隔, 去空白', async () => {
  const { splitKeys } = await import('../lib/settings.js')
  assert.deepEqual(splitKeys('a\nb\n'), ['a', 'b'])
  assert.deepEqual(splitKeys('a, b, c'), ['a', 'b', 'c'])
  assert.deepEqual(splitKeys(''), [])
  assert.deepEqual(splitKeys(null), [])
})

test('normalizeConfig 保留 apiKeyEnv 等未知字段 (否则保存一次就丢 key 来源)', () => {
  const out = normalizeConfig({
    backends: [{ id: 'exa', kind: 'exa', apiKeyEnv: 'EXA_API_KEY', custom: true, note: 'x' }],
  })
  assert.equal(out.backends[0].apiKeyEnv, 'EXA_API_KEY')
  assert.equal(out.backends[0].note, 'x')
  assert.equal(out.backends[0].priority, 99)
})
