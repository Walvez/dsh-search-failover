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
