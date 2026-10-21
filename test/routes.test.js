import test from 'node:test'
import assert from 'node:assert/strict'
import { mountSearchPoolRoutes, readJsonBody, sameOrigin } from '../lib/routes.js'

/** 假 webServer: 只记录注册的路由, 测试里直接调用 handler */
function makeWebServer() {
  const routes = new Map()
  return {
    routes,
    register: ({ path, handler }) => {
      routes.set(path, handler)
      return () => routes.delete(path)
    },
  }
}

/** 假 request: 可迭代 body + headers */
function makeRequest({ method = 'POST', body, origin = 'http://127.0.0.1:3080', host = '127.0.0.1:3080' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    headers: { origin, host },
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }
}

/** 假 response: 记录 status/JSON */
function makeResponse() {
  const out = { status: 0, headers: null, body: undefined }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(payload) {
      out.body = payload === undefined ? undefined : JSON.parse(payload)
    },
  }
}

const BASE = {
  backends: [
    { id: 'exa', kind: 'exa', apiKeyEnv: 'EXA_API_KEY' },
    { id: 'serper', kind: 'serper', apiKeyEnv: 'SERPER_API_KEY' },
  ],
}

function mount({ store = {}, provider = undefined } = {}) {
  const webServer = makeWebServer()
  const writes = []
  const fullStore = {
    mode: 'modern',
    read: () => ({ backends: [{ id: 'exa', kind: 'exa', apiKey: 'saved' }], removed: ['ddg'], strategy: 'failover' }),
    // 写路径只认 raw (入口原值, 不含 env 解析出的明文 key)
    raw: () => ({ backends: [{ id: 'exa', kind: 'exa', apiKeyEnv: 'EXA_API_KEY' }], removed: ['ddg'], strategy: 'failover' }),
    update: async (patch) => {
      writes.push(patch)
    },
    reset: async () => {
      writes.push({ reset: true })
    },
    ...store,
  }
  const fakeProvider = provider ?? {
    adapters: { exa: {}, serper: {}, ddg: {} },
    state: () => ({ backends: [], circuit: {} }),
  }
  mountSearchPoolRoutes(
    { webServer, effect: () => {} },
    { readConfig: () => BASE, provider: fakeProvider, base: BASE, settingsStore: fullStore },
  )
  return { webServer, writes, store: fullStore }
}

test('GET /search-pool/state 返回 provider.state()', async () => {
  const { webServer } = mount()
  const response = makeResponse()
  await webServer.routes.get('/search-pool/state')(makeRequest({ method: 'GET' }), response)
  assert.equal(response.out.status, 200)
  assert.deepEqual(response.out.body, { backends: [], circuit: {} })
  assert.equal(response.out.headers['cache-control'], 'no-store')
})

test('POST /search-pool/keys 拒绝跨源请求', async () => {
  const { webServer, writes } = mount()
  const response = makeResponse()
  await webServer.routes.get('/search-pool/keys')(
    makeRequest({ body: { backends: [] }, origin: 'http://evil.example' }),
    response,
  )
  assert.equal(response.out.status, 403)
  assert.equal(writes.length, 0)
})

test('POST /search-pool/keys 把 key 写进 store (内置后端不可删除)', async () => {
  const { webServer, writes } = mount()
  const response = makeResponse()
  await webServer.routes.get('/search-pool/keys')(
    makeRequest({ body: { backends: [{ id: 'exa', apiKey: 'new-key' }] } }),
    response,
  )
  assert.equal(response.out.status, 200, JSON.stringify(response.out.body))
  const [write] = writes
  const exa = write.backends.find((b) => b.id === 'exa')
  assert.equal(exa.apiKey, 'new-key')
  assert.equal(exa.apiKeyEnv, 'EXA_API_KEY', '写回时保留 apiKeyEnv, 不把 env 解析出的明文 key 落盘')
  assert.equal(write.backends.some((b) => b.id === 'exa'), true)
  assert.deepEqual(write.removed, ['ddg'], 'removed 原样带回')
})

test('POST /search-pool/keys 空 body 报 400', async () => {
  const { webServer } = mount()
  const response = makeResponse()
  await webServer.routes.get('/search-pool/keys')(makeRequest({ body: {} }), response)
  assert.equal(response.out.status, 400)
})

test('POST /search-pool/config 切 strategy 走 store.update', async () => {
  const { webServer, writes } = mount()
  const response = makeResponse()
  await webServer.routes.get('/search-pool/config')(makeRequest({ body: { strategy: 'rotate' } }), response)
  assert.equal(response.out.status, 200)
  assert.deepEqual(writes[0], { strategy: 'rotate' })

  const bad = makeResponse()
  await webServer.routes.get('/search-pool/config')(makeRequest({ body: { strategy: 'nope' } }), bad)
  assert.equal(bad.out.status, 400)
})

test('POST /search-pool/reset 调 store.reset', async () => {
  const { webServer, writes } = mount()
  const response = makeResponse()
  await webServer.routes.get('/search-pool/reset')(makeRequest({}), response)
  assert.equal(response.out.status, 200)
  assert.deepEqual(writes, [{ reset: true }])
})

test('store.update 抛错 → 500 带原因 (settings 服务缺失时用户能看到)', async () => {
  const { webServer } = mount({
    store: {
      mode: 'none',
      raw: () => ({ backends: [{ id: 'exa', kind: 'exa' }] }),
      update: async () => {
        throw new Error('settings service unavailable')
      },
    },
  })
  const response = makeResponse()
  await webServer.routes.get('/search-pool/keys')(
    makeRequest({ body: { backends: [{ id: 'exa', apiKey: 'x' }] } }),
    response,
  )
  assert.equal(response.out.status, 500)
  assert.match(response.out.body.error, /settings service unavailable/)
})

test('sameOrigin / readJsonBody 边界', async () => {
  assert.equal(sameOrigin({ headers: {} }), false)
  assert.equal(
    sameOrigin({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }),
    true,
  )
  assert.deepEqual(await readJsonBody(makeRequest({ body: { a: 1 } })), { a: 1 })
  const big = { pad: 'x'.repeat(200) }
  await assert.rejects(() => readJsonBody(makeRequest({ body: big }), 50), /too large/)
})
