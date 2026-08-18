import test from 'node:test'
import assert from 'node:assert/strict'
import { SearchPoolProvider } from '../lib/provider.js'

function makeProvider(backends, strategy = 'failover') {
  const config = { strategy, timeoutMs: 15000, circuit: { threshold: 2, quotaCooldownMs: 3600000 }, backends }
  return new SearchPoolProvider(() => config, {})
}

test('state(): 初始快照 — hasKey 判定与 closed 状态', () => {
  const p = makeProvider([
    { id: 'exa', kind: 'exa', priority: 1, apiKey: 'real-key' },
    { id: 'tavily', kind: 'tavily', priority: 2, apiKeyEnv: 'TAVILY_API_KEY' },
    { id: 'searxng', kind: 'searxng', priority: 3, baseURL: 'http://localhost:8080' },
  ])
  const s = p.state()
  const byId = Object.fromEntries(s.backends.map((b) => [b.id, b]))
  assert.equal(byId.exa.hasKey, true)
  assert.equal(byId.tavily.hasKey, process.env.TAVILY_API_KEY ? true : false)
  assert.equal(byId.searxng.hasKey, false)
  assert.equal(byId.exa.state, 'closed')
  assert.equal(byId.exa.cooldownMs, 0)
  assert.equal(s.strategy, 'failover')
  assert.equal(s.circuit.threshold, 2)
})

test('state(): quota 失败 → quota-cooldown + 倒计时', () => {
  const p = makeProvider([{ id: 'exa', kind: 'exa', priority: 1, apiKey: 'k' }])
  p.circuit.recordFailure('exa', 'quota')
  const s = p.state()
  const exa = s.backends[0]
  assert.equal(exa.state, 'quota-cooldown')
  assert.equal(exa.quota, true)
  assert.ok(exa.cooldownMs > 0 && exa.cooldownMs <= 3600000)
})

test('state(): 瞬时失败达到阈值 → open + 短冷却', () => {
  const p = makeProvider([{ id: 'exa', kind: 'exa', priority: 1, apiKey: 'k' }])
  p.circuit.recordFailure('exa', 'transient')
  p.circuit.recordFailure('exa', 'transient')
  const s = p.state()
  assert.equal(s.backends[0].state, 'open')
  assert.equal(s.backends[0].quota, false)
  assert.ok(s.backends[0].cooldownMs > 0)
})

test('state(): 成功后闭合', () => {
  const p = makeProvider([{ id: 'exa', kind: 'exa', priority: 1, apiKey: 'k' }])
  p.circuit.recordFailure('exa', 'quota')
  p.circuit.recordSuccess('exa')
  const s = p.state()
  assert.equal(s.backends[0].state, 'closed')
})

test('state(): 自定义后端透传 custom 标记', () => {
  const config = {
    strategy: 'failover',
    backends: [
      { id: 'my-searx', kind: 'searxng', custom: true, baseURL: 'http://localhost:8080' },
      { id: 'exa', kind: 'exa', apiKey: 'k' },
    ],
  }
  const p = new SearchPoolProvider(() => config, {})
  const s = p.state()
  assert.equal(s.backends[0].custom, true)
  assert.equal(s.backends[1].custom, false)
})

test('state(): 透传适配器 site (官网/配置页链接)', () => {
  const config = {
    strategy: 'failover',
    backends: [
      { id: 'exa', kind: 'exa', apiKey: 'k' },
      { id: 'ddg', kind: 'ddg' },
    ],
  }
  const adapters = {
    exa: { site: 'https://dashboard.exa.ai/api-keys', search: async () => ({ sources: [] }) },
    ddg: { search: async () => ({ sources: [] }) },
  }
  const p = new SearchPoolProvider(() => config, adapters)
  const s = p.state()
  assert.equal(s.backends[0].site, 'https://dashboard.exa.ai/api-keys')
  assert.equal(s.backends[1].site, null)
})
test('state(): 输出按 priority 排序 (UI 顺序 = 优先级顺序)', () => {
  const config = {
    strategy: 'failover',
    backends: [
      { id: 'c', kind: 'ddg', priority: 99, weight: 1 },
      { id: 'a', kind: 'exa', priority: 1, apiKey: 'k', weight: 1 },
      { id: 'b', kind: 'tavily', priority: 2, apiKey: 'k', weight: 1 },
    ],
  }
  const p = new SearchPoolProvider(() => config, {})
  const ids = p.state().backends.map((b) => b.id)
  assert.deepEqual(ids, ['a', 'b', 'c'])
})

test('state(): 重排后 priority 重写 → 新顺序 (模拟↑↓)', () => {
  let cfg = {
    strategy: 'failover',
    backends: [
      { id: 'a', kind: 'exa', priority: 1, apiKey: 'k' },
      { id: 'b', kind: 'tavily', priority: 2, apiKey: 'k' },
    ],
  }
  const p = new SearchPoolProvider(() => cfg, {})
  // 模拟路由 order 重排: 交换顺序并重写 priority
  cfg = {
    ...cfg,
    backends: [
      { ...cfg.backends[1], priority: 1 },
      { ...cfg.backends[0], priority: 2 },
    ],
  }
  assert.deepEqual(p.state().backends.map((b) => b.id), ['b', 'a'])
})
