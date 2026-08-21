import test from 'node:test'
import assert from 'node:assert/strict'
import { SearchPoolProvider } from '../lib/provider.js'

const ok = (sources = [{ url: 'https://a.example', title: 'A' }]) =>
  async () => ({ sources })

function makeRegistry(stubs) {
  const registry = {}
  for (const [kind, impl] of Object.entries(stubs)) {
    registry[kind] = { needsKey: false, search: impl }
  }
  return registry
}

const fail = (kind, msg = 'boom') => async () => {
  const e = new Error(msg)
  e.kind = kind
  throw e
}

test('failover: 第一个后端失败 → 用第二个', async () => {
  const registry = makeRegistry({ a: fail('transient'), b: ok([{ url: 'https://b.example', title: 'B' }]) })
  const p = new SearchPoolProvider(() => ({
    backends: [{ id: 'a', kind: 'a', priority: 1 }, { id: 'b', kind: 'b', priority: 2 }],
  }), registry)
  const r = await p.search({ query: 'x', maxResults: 8 })
  assert.equal(r.sources[0].url, 'https://b.example')
})

test('全部失败 → 抛错', async () => {
  const registry = makeRegistry({ a: fail('transient') })
  const p = new SearchPoolProvider(() => ({ backends: [{ id: 'a', kind: 'a' }] }), registry)
  await assert.rejects(() => p.search({ query: 'x' }))
})

test('quota 失败 → 长冷却, 后续请求跳过该后端', async () => {
  let calls = 0
  const registry = makeRegistry({
    q: async () => { calls++; throw Object.assign(new Error('insufficient credits'), { kind: 'quota' }) },
    b: ok([{ url: 'https://b.example' }]),
  })
  const p = new SearchPoolProvider(() => ({
    backends: [{ id: 'q', kind: 'q', priority: 1 }, { id: 'b', kind: 'b', priority: 2 }],
  }), registry)
  await p.search({ query: 'x' })
  await p.search({ query: 'x' })
  assert.equal(calls, 1, 'quota 后不再调用该后端')
})

test('熔断: 3 次瞬时失败后开断', async () => {
  let calls = 0
  const registry = makeRegistry({
    f: async () => { calls++; throw Object.assign(new Error('5xx'), { kind: 'transient' }) },
    b: ok(),
  })
  const p = new SearchPoolProvider(() => ({
    backends: [{ id: 'f', kind: 'f', priority: 1 }, { id: 'b', kind: 'b', priority: 2 }],
    circuit: { threshold: 3, burstWindowMs: 60_000 },
  }), registry)
  for (let i = 0; i < 3; i++) await p.search({ query: 'x' })
  assert.equal(calls, 3)
  await p.search({ query: 'x' })
  assert.equal(calls, 3, '熔断后不再调用')
})

test('rotate: 两个健康后端轮询', async () => {
  const hits = []
  const registry = makeRegistry({
    a: async () => { hits.push('a'); return { sources: [{ url: 'https://a.example' }] } },
    b: async () => { hits.push('b'); return { sources: [{ url: 'https://b.example' }] } },
  })
  const p = new SearchPoolProvider(() => ({
    strategy: 'rotate',
    backends: [{ id: 'a', kind: 'a' }, { id: 'b', kind: 'b' }],
  }), registry)
  await p.search({ query: 'x' })
  await p.search({ query: 'x' })
  assert.deepEqual(hits, ['a', 'b'])
})

test('超时 → 换下一个后端', async () => {
  const registry = makeRegistry({
    slow: async (_b, _r, signal) => {
      await new Promise((res, rej) => {
        const t = setTimeout(res, 500)
        signal.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason ?? new Error('aborted')) }, { once: true })
      })
      return { sources: [] }
    },
    b: ok([{ url: 'https://b.example' }]),
  })
  const p = new SearchPoolProvider(() => ({
    backends: [{ id: 'slow', kind: 'slow', priority: 1 }, { id: 'b', kind: 'b', priority: 2 }],
    timeoutMs: 50,
  }), registry)
  const r = await p.search({ query: 'x' })
  assert.equal(r.sources[0].url, 'https://b.example')
})

test('日志: 成功记 info, 失败记 warn, 熔断打开记 warn(circuit opened)', async () => {
  const lines = []
  const logger = {
    info: (m) => lines.push(['info', m]),
    warn: (m) => lines.push(['warn', m]),
    error: (m) => lines.push(['error', m]),
  }
  const registry = makeRegistry({
    a: fail('transient'),
    b: ok([{ url: 'https://b.example', title: 'B' }]),
  })
  const p = new SearchPoolProvider(() => ({
    backends: [{ id: 'a', kind: 'a', priority: 1 }, { id: 'b', kind: 'b', priority: 2 }],
    circuit: { threshold: 2, burstWindowMs: 60_000, cooldownMs: 60_000 },
  }), registry, logger)
  await p.search({ query: 'x', maxResults: 8 })   // 第1次: a failed
  await p.search({ query: 'x', maxResults: 8 })   // 第2次: a 达阈值开断
  assert.ok(lines.some(([lvl, m]) => lvl === 'warn' && m.includes('a failed')), '失败 warn 含后端 id')
  assert.ok(lines.some(([lvl, m]) => lvl === 'warn' && m.includes('circuit opened for a')), '熔断打开 warn')
  assert.ok(lines.some(([lvl, m]) => lvl === 'info' && m.includes('ok via b')), '成功 info 含后端 id')
})

test('冷却到期 → 半开探活 → 成功恢复', async () => {
  let fail = true
  const registry = makeRegistry({
    f: async () => {
      if (fail) throw Object.assign(new Error('x'), { kind: 'transient' })
      return { sources: [{ url: 'https://f.example' }] }
    },
    b: ok([{ url: 'https://b.example' }]),
  })
  const p = new SearchPoolProvider(() => ({
    backends: [{ id: 'f', kind: 'f', priority: 1 }, { id: 'b', kind: 'b', priority: 2 }],
    circuit: { threshold: 2, burstWindowMs: 60_000, cooldownMs: 10 },
  }), registry)
  await p.search({ query: 'x' })
  await p.search({ query: 'x' })   // f 开断
  fail = false
  await new Promise((r) => setTimeout(r, 15))  // 等 cooldown 过期
  const out = await p.search({ query: 'x' })
  assert.equal(out.sources[0].url, 'https://f.example', '探活成功恢复主后端')
})

test('rotate: 加权轮询 — weight 2 的后端出现频率两倍', async () => {
  const calls = []
  const adapters = {
    a: { search: async () => { calls.push('a'); return { sources: [{ url: 'u' }] } } },
    b: { search: async () => { calls.push('b'); return { sources: [{ url: 'u' }] } } },
  }
  const config = {
    strategy: 'rotate',
    backends: [
      { id: 'a', kind: 'a', priority: 1, weight: 2 },
      { id: 'b', kind: 'b', priority: 2, weight: 1 },
    ],
  }
  const p = new SearchPoolProvider(() => config, adapters)
  for (let i = 0; i < 6; i++) await p.search({ query: 'q', maxResults: 3 })
  const a = calls.filter((x) => x === 'a').length
  const b = calls.filter((x) => x === 'b').length
  assert.equal(a, 4)
  assert.equal(b, 2)
})

test('probe: 真实轻量搜索 + 计时 + 结果计数', async () => {
  let seen = null
  const adapters = {
    a: { search: async (backend, req, signal) => { seen = { backend, req, signal }; return { sources: [{ url: 'u1' }, { url: 'u2' }] } } },
  }
  const config = { backends: [{ id: 'a', kind: 'a', priority: 1, apiKey: 'k' }] }
  const p = new SearchPoolProvider(() => config, adapters)
  const r = await p.probe('a')
  assert.equal(r.ok, true)
  assert.equal(r.sources, 2)
  assert.equal(typeof r.ms, 'number')
  assert.equal(seen.req.query, 'search pool connectivity test')
  assert.equal(seen.req.maxResults, 1)
  assert.ok(seen.signal)
})

test('probe: 未知 id / 未知 kind / 失败传播', async () => {
  const config = { backends: [{ id: 'a', kind: 'a', priority: 1 }] }
  const p = new SearchPoolProvider(() => config, { a: { search: async () => { throw new Error('boom probe') } } })
  await assert.rejects(() => p.probe('nope'), /unknown backend id/)
  await assert.rejects(() => p.probe('a'), /boom probe/)
  const p2 = new SearchPoolProvider(() => ({ backends: [{ id: 'x', kind: 'ghost' }] }), {})
  await assert.rejects(() => p2.probe('x'), /unknown backend kind/)
})

test('failover: 首源结果不足 → 自动追加后续后端并合并去重', async () => {
  const calls = []
  const adapters = {
    exa: { search: async () => { calls.push('exa'); return { sources: [{ url: 'u1' }, { url: 'u2' }] } } },
    serper: { search: async () => { calls.push('serper'); return { sources: [{ url: 'u2' }, { url: 'u3' }, { url: 'u4' }] } } },
    ddg: { search: async () => { calls.push('ddg'); return { sources: [{ url: 'u5' }] } } },
  }
  const config = { strategy: 'failover', mergeThreshold: 3, backends: [
    { id: 'exa', kind: 'exa', priority: 1, apiKey: 'k' },
    { id: 'serper', kind: 'serper', priority: 2, apiKey: 'k' },
    { id: 'ddg', kind: 'ddg', priority: 3 },
  ] }
  const p = new SearchPoolProvider(() => config, adapters)
  const r = await p.search({ query: 'q', maxResults: 8 })
  // exa 2 条 < 阈值 3 → 继续 serper (3条, 含重复u2) → 到 4 条 ≥3 停, 不再用 ddg
  assert.deepEqual(calls, ['exa', 'serper'])
  assert.deepEqual(p.state() ? r.providers : r.providers, ['exa', 'serper'])
  assert.deepEqual(r.sources.map((s) => s.url), ['u1', 'u2', 'u3', 'u4'])
})

test('failover: 首源结果充足 → 不追加', async () => {
  const calls = []
  const adapters = {
    exa: { search: async () => { calls.push('exa'); return { sources: [{ url: 'u1' }, { url: 'u2' }, { url: 'u3' }, { url: 'u4' }] } } },
    serper: { search: async () => { calls.push('serper'); return { sources: [{ url: 'u5' }] } } },
  }
  const config = { strategy: 'failover', mergeThreshold: 3, backends: [
    { id: 'exa', kind: 'exa', priority: 1, apiKey: 'k' },
    { id: 'serper', kind: 'serper', priority: 2, apiKey: 'k' },
  ] }
  const p = new SearchPoolProvider(() => config, adapters)
  const r = await p.search({ query: 'q', maxResults: 8 })
  assert.deepEqual(calls, ['exa'])   // 4 条 ≥ 3, 不再用 serper
  assert.equal(r.sources.length, 4)
})

test('rotate: 不加合并 — 命中一个健康后端即返回', async () => {
  const calls = []
  const adapters = {
    a: { search: async () => { calls.push('a'); return { sources: [{ url: 'u1' }] } } },
    b: { search: async () => { calls.push('b'); return { sources: [{ url: 'u2' }] } } },
  }
  const config = { strategy: 'rotate', mergeThreshold: 3, backends: [
    { id: 'a', kind: 'a', priority: 1, weight: 1 },
    { id: 'b', kind: 'b', priority: 2, weight: 1 },
  ] }
  const p = new SearchPoolProvider(() => config, adapters)
  const r = await p.search({ query: 'q', maxResults: 8 })
  assert.deepEqual(calls, ['a'])     // 1 条但 rotate 不追加
  assert.equal(r.sources.length, 1)
})

test('默认(未设 mergeThreshold=0): failover 首源成功即返回, 不跨源合并', async () => {
  const calls = []
  const adapters = {
    exa: { search: async () => { calls.push('exa'); return { sources: [{ url: 'u1' }] } } },
    serper: { search: async () => { calls.push('serper'); return { sources: [{ url: 'u2' }, { url: 'u3' }] } } },
  }
  const config = { strategy: 'failover', backends: [
    { id: 'exa', kind: 'exa', priority: 1, apiKey: 'k' },
    { id: 'serper', kind: 'serper', priority: 2, apiKey: 'k' },
  ] }
  const p = new SearchPoolProvider(() => config, adapters)
  const r = await p.search({ query: 'q' })
  assert.deepEqual(calls, ['exa'])        // 默认不合并: 首源成功即返回
  assert.equal(r.sources.length, 1)
  assert.deepEqual(r.providers, ['exa'])
})

test('request.source: 强制只用指定引擎, 不按优先级不合并', async () => {
  const calls = []
  const adapters = {
    exa: { search: async () => { calls.push('exa'); return { sources: [{ url: 'u1' }] } } },
    serper: { search: async () => { calls.push('serper'); return { sources: [{ url: 'u2' }] } } },
  }
  const config = { strategy: 'failover', mergeThreshold: 3, backends: [
    { id: 'exa', kind: 'exa', priority: 1, apiKey: 'k' },
    { id: 'serper', kind: 'serper', priority: 2, apiKey: 'k' },
  ] }
  const p = new SearchPoolProvider(() => config, adapters)
  const r = await p.search({ query: 'q', source: 'serper' })
  assert.deepEqual(calls, ['serper'])     // 即使 exa 优先级更高, 指定 serper 就只用 serper
  assert.deepEqual(r.providers, ['serper'])
  assert.equal(r.sources.length, 1)
})

test('request.source 未知 → 抛 SearchPoolError', async () => {
  const adapters = { exa: { search: async () => ({ sources: [{ url: 'u1' }] }) } }
  const config = { strategy: 'failover', mergeThreshold: 3, backends: [
    { id: 'exa', kind: 'exa', priority: 1, apiKey: 'k' },
  ] }
  const p = new SearchPoolProvider(() => config, adapters)
  await assert.rejects(() => p.search({ query: 'q', source: 'nope' }), /unknown search source/)
})

test('多 Key: 第一个 Key 失败 → 同引擎切下一个 Key', async () => {
  const used = []
  const adapters = {
    tavily: {
      search: async (backend) => {
        used.push(backend.apiKey)
        if (backend.apiKey === 'k1') {
          const e = new Error('quota')
          e.kind = 'quota'
          throw e
        }
        return { sources: [{ url: 'u2' }] }
      },
    },
  }
  const p = new SearchPoolProvider(() => ({
    strategy: 'failover',
    backends: [{ id: 'tavily', kind: 'tavily', priority: 1, apiKey: 'k1\nk2' }],
  }), adapters)
  const r = await p.search({ query: 'q' })
  assert.deepEqual(used, ['k1', 'k2'])
  assert.equal(r.sources[0].url, 'u2')
  // k1 进入额度冷却, k2 仍可用
  const snap = p.state().backends[0]
  assert.equal(snap.hasKey, true)
  assert.equal(snap.keyCount, 2)
  assert.equal(snap.state, 'closed')
})

test('fetch: 只走声明了 fetch 的适配器, 失败则下探', async () => {
  const calls = []
  const adapters = {
    serper: { search: async () => ({ sources: [{ url: 's' }] }) },
    jina: {
      search: async () => ({ sources: [{ url: 'j' }] }),
      fetch: async () => { calls.push('jina'); throw Object.assign(new Error('boom'), { kind: 'transient' }) },
    },
    firecrawl: {
      search: async () => ({ sources: [{ url: 'f' }] }),
      fetch: async () => { calls.push('firecrawl'); return { url: 'https://ok.example', content: '# hi' } },
    },
  }
  const p = new SearchPoolProvider(() => ({
    strategy: 'failover',
    backends: [
      { id: 'serper', kind: 'serper', priority: 1, apiKey: 'k' },
      { id: 'jina', kind: 'jina', priority: 2, apiKey: 'k' },
      { id: 'firecrawl', kind: 'firecrawl', priority: 3, apiKey: 'k' },
    ],
  }), adapters)
  const r = await p.fetch({ url: 'https://example.com' })
  assert.deepEqual(calls, ['jina', 'firecrawl'])
  assert.equal(r.statusCode, 200)
  assert.equal(r.body.kind, 'text')
  assert.equal(r.body.content, '# hi')
  assert.equal(r.url, 'https://ok.example')
})

test('fetch: 没有 fetch 适配器 → 抛错', async () => {
  const p = new SearchPoolProvider(() => ({
    backends: [{ id: 'serper', kind: 'serper', apiKey: 'k' }],
  }), { serper: { search: async () => ({ sources: [] }) } })
  await assert.rejects(() => p.fetch({ url: 'https://x.example' }), /no fetch-capable/)
})
