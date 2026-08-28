import test from 'node:test'
import assert from 'node:assert/strict'
import { backends } from '../lib/backends.js'
import { SearchPoolError } from '../lib/errors.js'

/** 拦截 globalThis.fetch: handler(url, init) → { json? | text?, status? } */
function stubFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const out = await handler(url, init)
    return {
      ok: (out.status ?? 200) < 400,
      status: out.status ?? 200,
      text: async () => (out.text !== undefined ? out.text : JSON.stringify(out.json ?? {})),
    }
  }
  return () => { globalThis.fetch = original }
}

test('serper: POST + x-api-key + organic 映射', async () => {
  let seen = null
  const restore = stubFetch(async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) }
    return { json: { organic: [{ title: 'T', link: 'https://x.example', snippet: 'S', date: '2026-01-01' }] } }
  })
  try {
    const r = await backends.serper.search({ apiKey: 'sk-test' }, { query: 'hello', maxResults: 8 }, undefined)
    assert.equal(seen.url, 'https://google.serper.dev/search')
    assert.equal(seen.init.headers['x-api-key'], 'sk-test')
    assert.equal(seen.body.q, 'hello')
    assert.equal(r.sources[0].url, 'https://x.example')
    assert.equal(r.sources[0].publishedAt, '2026-01-01')
  } finally { restore() }
})

test('serper: 无 key → auth 错误', async () => {
  await assert.rejects(() => backends.serper.search({}, { query: 'q' }, undefined), (e) => e.kind === 'auth')
})

test('serpapi: GET + api_key 参数 + organic_results 映射', async () => {
  let seen = null
  const restore = stubFetch(async (url) => {
    seen = url
    return { json: { organic_results: [{ title: 'T', link: 'https://s.example', snippet: 'S' }] } }
  })
  try {
    const r = await backends.serpapi.search({ apiKey: 'k1' }, { query: 'q', maxResults: 5 }, undefined)
    assert.ok(seen.startsWith('https://serpapi.com/search?'))
    assert.ok(seen.includes('api_key=k1'))
    assert.ok(seen.includes('engine=google'))
    assert.equal(r.sources[0].url, 'https://s.example')
  } finally { restore() }
})

test('brave: header X-Subscription-Token + web.results 映射', async () => {
  let token = null
  const restore = stubFetch(async (url, init) => {
    token = init.headers['x-subscription-token']
    return { json: { web: { results: [{ title: 'T', url: 'https://b.example', description: 'D', age: '2026-08-01' }] } } }
  })
  try {
    const r = await backends.brave.search({ apiKey: 'bt' }, { query: 'q', maxResults: 8 }, undefined)
    assert.equal(token, 'bt')
    assert.equal(r.sources[0].url, 'https://b.example')
    assert.equal(r.sources[0].publishedAt, '2026-08-01')
  } finally { restore() }
})

test('jina: markdown 解析', async () => {
  let seen = null
  const restore = stubFetch(async (url, init) => {
    seen = { url, auth: init.headers.authorization }
    return {
      text: [
        '# Search results for "test"',
        '',
        '- [Hello World](https://example.com/hello)',
        '  A page about hello world.',
        '',
        '- [Second Result](https://example.com/second)',
        'Another description line.',
      ].join('\n'),
    }
  })
  try {
    const r = await backends.jina.search({ apiKey: 'jkey' }, { query: 'test', maxResults: 8 }, undefined)
    assert.ok(seen.url.endsWith('/test'))
    assert.equal(seen.auth, 'Bearer jkey')
    assert.equal(r.sources.length, 2)
    assert.equal(r.sources[0].title, 'Hello World')
    assert.ok(r.sources[0].snippet.includes('hello world'))
  } finally { restore() }
})

test('jina: 无 key → auth 错误 (免费档已取消)', async () => {
  await assert.rejects(() => backends.jina.search({}, { query: 'q' }, undefined), (e) => e.kind === 'auth')
})

test('searxng: GET format=json + 默认 localhost:8080 + baseURL 覆盖', async () => {
  let url = null
  const restore = stubFetch(async (u) => {
    url = u
    return { json: { results: [{ title: 'T', url: 'https://sx.example', content: 'C', publishedDate: '2026-08-01' }] } }
  })
  try {
    const r = await backends.searxng.search({}, { query: 'q', maxResults: 8 }, undefined)
    assert.equal(url, 'http://localhost:8080/search?q=q&format=json')
    assert.equal(r.sources[0].url, 'https://sx.example')
    await backends.searxng.search({ baseURL: 'http://127.0.0.1:8888/' }, { query: 'q2' }, undefined)
    assert.equal(url, 'http://127.0.0.1:8888/search?q=q2&format=json')
  } finally { restore() }
})

test('ddg: HTML 解析 + uddg 解码', async () => {
  const restore = stubFetch(async () => ({
    text: [
      '<div class="result">',
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=' + encodeURIComponent('https://real.example/path?x=1') + '&rut=abc">Real <b>Title</b></a>',
      '<a class="result__snippet" href="https://x">Some &amp; snippet</a>',
      '</div>',
    ].join(''),
  }))
  try {
    const r = await backends.ddg.search({}, { query: 'q', maxResults: 8 }, undefined)
    assert.equal(r.sources[0].url, 'https://real.example/path?x=1')
    assert.equal(r.sources[0].title, 'Real Title')
    assert.equal(r.sources[0].snippet, 'Some & snippet')
  } finally { restore() }
})

test('429 → kind=quota; 5xx → kind=transient', async () => {
  const restore = stubFetch(async () => ({ status: 429, text: 'insufficient credits' }))
  try {
    await assert.rejects(
      () => backends.tavily.search({}, { query: 'q' }, undefined),
      (e) => e instanceof SearchPoolError && e.kind === 'quota',
    )
  } finally { restore() }
  const restore2 = stubFetch(async () => ({ status: 502, text: 'bad gateway' }))
  try {
    await assert.rejects(
      () => backends.tavily.search({}, { query: 'q' }, undefined),
      (e) => e.kind === 'transient',
    )
  } finally { restore2() }
})

test('tavily: 有 key 走 Bearer, 无 key 走 keyless 头', async () => {
  const seen = []
  const restore = stubFetch(async (_u, init) => {
    seen.push(init.headers)
    return { json: { results: [{ url: 'https://t.example', title: 'T', content: 'C' }] } }
  })
  try {
    await backends.tavily.search({ apiKey: 'tk' }, { query: 'q' }, undefined)
    await backends.tavily.search({}, { query: 'q' }, undefined)
    assert.equal(seen[0].authorization, 'Bearer tk')
    assert.equal(seen[0]['x-tavily-access-mode'], undefined)
    assert.equal(seen[1]['x-tavily-access-mode'], 'keyless')
    assert.equal(seen[1].authorization, undefined)
  } finally { restore() }
})

test('serpapi usage: 解析 /account 额度', async () => {
  const restore = stubFetch(async () => ({
    json: {
      plan_id: 'free', plan_name: 'Free Plan', searches_per_month: 250,
      this_month_usage: 2, total_searches_left: 248, plan_renewal_date: '2026-09-16',
    },
  }))
  try {
    const r = await backends.serpapi.usage({ apiKey: 'demo-key' })
    assert.equal(r.plan, 'Free Plan')
    assert.equal(r.used, 2)
    assert.equal(r.limit, 250)
    assert.equal(r.remaining, 248)
    assert.equal(r.resetAt, '2026-09-16')
  } finally { restore() }
})

test('serpapi usage: 无 key → auth 错误', async () => {
  const restore = stubFetch(async () => ({ json: {} }))
  try {
    await assert.rejects(() => backends.serpapi.usage({ apiKey: '' }), /no API key/)
  } finally { restore() }
})

test('firecrawl: POST /v1/search Bearer + data 映射', async () => {
  let seen = null
  const restore = stubFetch(async (url, init) => {
    seen = { url, auth: init.headers.authorization, body: JSON.parse(init.body) }
    return { json: { data: [{ url: 'https://f.example', title: 'T', description: 'D' }] } }
  })
  try {
    const r = await backends.firecrawl.search({ apiKey: 'fc' }, { query: 'q', maxResults: 5 }, undefined)
    assert.equal(seen.url, 'https://api.firecrawl.dev/v1/search')
    assert.equal(seen.auth, 'Bearer fc')
    assert.equal(seen.body.query, 'q')
    assert.equal(r.sources[0].url, 'https://f.example')
  } finally { restore() }
})

test('firecrawl fetch: POST /v1/scrape 返回 markdown', async () => {
  const restore = stubFetch(async () => ({ json: { data: { markdown: '# page', metadata: { sourceURL: 'https://f.example' } } } }))
  try {
    const r = await backends.firecrawl.fetch({ apiKey: 'fc' }, { url: 'https://f.example' }, undefined)
    assert.equal(r.content, '# page')
    assert.equal(r.url, 'https://f.example')
  } finally { restore() }
})

test('jina fetch: r.jina.ai reader', async () => {
  let seen = null
  const restore = stubFetch(async (url) => { seen = url; return { text: '# md' } })
  try {
    const r = await backends.jina.fetch({ apiKey: 'jk' }, { url: 'https://ex.com/a' }, undefined)
    assert.ok(String(seen).includes('r.jina.ai'))
    assert.equal(r.content, '# md')
  } finally { restore() }
})

// ── opencodex 后端 ───────────────────────────────────────────────────────────

import { extractResponseText, parseSidecarSources } from '../lib/backends.js'

const SIDECAR_RESPONSE = {
  output: [
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'thinking…' }] },
    {
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: [
          'Node.js 22 LTS — https://nodejs.org/en/about/previous-releases — Current active LTS line since October 2024.',
          'Node.js releases — https://github.com/nodejs/release#release-schedule — Official release schedule with LTS dates.',
        ].join('\n'),
      }],
    },
  ],
}

test('opencodex: POST /v1/responses 带 web_search tool + sources 解析', async () => {
  let seen = null
  const restore = stubFetch(async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) }
    return { json: SIDECAR_RESPONSE }
  })
  try {
    const r = await backends.opencodex.search({ apiKey: '' }, { query: 'node lts', maxResults: 5 }, undefined)
    assert.equal(seen.url, 'http://127.0.0.1:10100/v1/responses')
    assert.equal(seen.init.headers.authorization, 'Bearer ocx_data_dsh')
    assert.deepEqual(seen.body.tools, [{ type: 'web_search' }])
    assert.equal(seen.body.model, 'opencode-go/glm-5.3-flash')
    assert.ok(seen.body.input[0].content[0].text.includes('node lts'))
    assert.equal(r.sources.length, 2)
    assert.equal(r.sources[0].url, 'https://nodejs.org/en/about/previous-releases')
    assert.equal(r.sources[0].title, 'Node.js 22 LTS')
    assert.equal(r.sources[0].snippet, 'Current active LTS line since October 2024.')
  } finally { restore() }
})

test('opencodex: baseURL/token/carrier 可配置', async () => {
  let seen = null
  const restore = stubFetch(async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) }
    return { json: SIDECAR_RESPONSE }
  })
  try {
    await backends.opencodex.search(
      { apiKey: 'tok1', baseURL: 'http://127.0.0.1:9999/', carrierModel: 'gpt-5.6-luna' },
      { query: 'q', maxResults: 3 }, undefined,
    )
    assert.equal(seen.url, 'http://127.0.0.1:9999/v1/responses')
    assert.equal(seen.init.headers.authorization, 'Bearer tok1')
    assert.equal(seen.body.model, 'gpt-5.6-luna')
  } finally { restore() }
})

test('opencodex: HTTP 401 → auth 错误(不重试)', async () => {
  const restore = stubFetch(async () => ({ status: 401, text: 'unauthorized' }))
  try {
    await assert.rejects(
      () => backends.opencodex.search({ apiKey: 'bad' }, { query: 'q' }, undefined),
      (e) => e.kind === 'auth',
    )
  } finally { restore() }
})

test('opencodex: 服务没起(ECONNREFUSED) → transient', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('fetch failed: connect ECONNREFUSED') }
  try {
    await assert.rejects(
      () => backends.opencodex.search({}, { query: 'q' }, undefined),
      (e) => e.kind === 'transient',
    )
  } finally { globalThis.fetch = original }
})

test('opencodex: 空文本/无 URL → transient', async () => {
  const restore = stubFetch(async () => ({ json: { output: [{ content: [{ type: 'output_text', text: 'no links here' }] }] } }))
  try {
    await assert.rejects(
      () => backends.opencodex.search({}, { query: 'q' }, undefined),
      (e) => e.kind === 'transient' && /no parseable sources/.test(e.message),
    )
  } finally { restore() }
})

test('opencodex: output_text 平铺响应也支持', async () => {
  const restore = stubFetch(async () => ({ json: { output_text: 'T — https://flat.example — S' } }))
  try {
    const r = await backends.opencodex.search({}, { query: 'q', maxResults: 3 }, undefined)
    assert.equal(r.sources[0].url, 'https://flat.example')
  } finally { restore() }
})

test('extractResponseText: 拼 message content 的 output_text, 忽略 reasoning', () => {
  assert.equal(extractResponseText(SIDECAR_RESPONSE), 'Node.js 22 LTS — https://nodejs.org/en/about/previous-releases — Current active LTS line since October 2024.\nNode.js releases — https://github.com/nodejs/release#release-schedule — Official release schedule with LTS dates.')
  assert.equal(extractResponseText(null), '')
  assert.equal(extractResponseText({ output_text: 'flat' }), 'flat')
})

test('parseSidecarSources: 容错破折号/编号/尾标点', () => {
  const src = parseSidecarSources([
    '1. Title One - https://a.example/path. - summary one',
    '2. Title Two — https://b.example — summary two',
    '* Title Three: https://c.example : summary three',
    'no url line',
    '',
  ].join('\n'))
  assert.equal(src.length, 3)
  assert.equal(src[0].url, 'https://a.example/path')
  assert.equal(src[0].title, 'Title One')
  assert.equal(src[1].title, 'Title Two')
  assert.equal(src[2].title, 'Title Three')
})

const SIDECAR_SSE = [
  'event: response.created',
  'data: {"type":"response.created","sequence_number":0,"response":{"id":"","status":"in_progress","output":[]}}',
  '',
  ': keep-alive comment (not JSON)',
  '',
  'event: response.completed',
  `data: ${JSON.stringify({ type: 'response.completed', sequence_number: 9, response: { id: 'r1', status: 'completed', output: SIDECAR_RESPONSE.output } })}`,
  '',
].join('\n')

test('opencodex: SSE 响应(含 keep-alive 帧)从 response.completed 抽结果', async () => {
  let seen = null
  const restore = stubFetch(async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) }
    return { text: SIDECAR_SSE }
  })
  try {
    const r = await backends.opencodex.search({ apiKey: '' }, { query: 'node lts', maxResults: 5 }, undefined)
    assert.equal(r.sources.length, 2)
    assert.equal(r.sources[0].url, 'https://nodejs.org/en/about/previous-releases')
  } finally { restore() }
})

test('completedResponseFromSse: SSE / JSON / 空流', async () => {
  const { completedResponseFromSse } = await import('../lib/backends.js')
  const sseJson = JSON.parse(SIDECAR_SSE.match(/^data: (\{.*completed.*\})$/gm)[0].slice(6)).response
  assert.deepEqual(completedResponseFromSse(SIDECAR_SSE), sseJson)
  assert.deepEqual(completedResponseFromSse('{"output":[]}'), { output: [] })
  assert.equal(completedResponseFromSse('event: ping\ndata: not json'), null)
})
