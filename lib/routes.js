/**
 * search-pool HTTP routes — 设置页的数据通道 (dsh-market 同款 webServer 架构):
 *  - GET  /search-pool/state  实时状态 (后端 key 有无 / 熔断 / 冷却倒计时)
 *  - POST /search-pool/keys   保存一组后端的 apiKey (settings.update, 热生效)
 *  - POST /search-pool/reset  清空 user 覆盖, 回退到行内配置 (settings.replace)
 * 全部写接口强制 same-origin; 读接口 no-store。
 */
import { SEARCH_POOL_SETTINGS_NS } from './settings.js'

export function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

export function sameOrigin(request) {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try { return new URL(origin).host === host } catch { return false }
}

export async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件宿主上下文
 * @param {{ readConfig: () => object, provider: object }} deps
 *   readConfig — 每次调用返回当前生效配置 (settings 覆盖后), provider — SearchPoolProvider
 */
export function mountSearchPoolRoutes(ctx, { readConfig, provider, base }) {
  // ctx 由调用方以 ctx.inject(['webServer', 'settings']) 传入, 服务已就绪
  const settingsService = ctx.settings
  if (settingsService === undefined) {
    console.warn('[search-pool] settings service unavailable — key management routes disabled')
    return
  }
  const webServer = ctx.webServer
  if (webServer === undefined) {
    console.warn('[search-pool] webServer service unavailable — key management routes disabled')
    return
  }
  // 行内后端的 id: 内置后端不可删除, 只能改 key
  const builtinIds = new Set((base?.backends ?? []).map((b) => b.id))
  /** 去运行时标记, 只保留可持久化字段 */
  const cleanBackend = ({ custom, updatedAt, ...rest }) => rest

  const disposers = [
    webServer.register({
      kind: 'exact',
      path: '/search-pool/state',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        sendJson(response, 200, provider.state())
      },
    }),

    webServer.register({
      kind: 'exact',
      path: '/search-pool/keys',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'untrusted origin' })
        let body
        try { body = await readJsonBody(request) } catch (e) {
          return sendJson(response, 400, { error: e instanceof Error ? e.message : String(e) })
        }
        const bodyIsObject = body !== null && typeof body === 'object'
        const patches = bodyIsObject && Array.isArray(body.backends) ? body.backends : []
        const adds = bodyIsObject && Array.isArray(body.adds) ? body.adds : []
        const removes = bodyIsObject && Array.isArray(body.removes) ? body.removes : []
        const order = bodyIsObject && Array.isArray(body.order) ? body.order : []
        const weights = bodyIsObject && Array.isArray(body.weights) ? body.weights : []
        if (
          bodyIsObject === false ||
          (patches.length === 0 && adds.length === 0 && removes.length === 0 &&
            order.length === 0 && weights.length === 0)
        ) {
          return sendJson(response, 400, {
            error: 'expected { backends?, adds?, removes?, order?, weights? } at least one',
          })
        }
        for (const p of patches) {
          if (typeof p?.id !== 'string' || (p.apiKey !== undefined && typeof p.apiKey !== 'string')) {
            return sendJson(response, 400, { error: 'each patch needs id:string and optional apiKey:string' })
          }
        }
        for (const a of adds) {
          if (typeof a?.id !== 'string' || typeof a?.kind !== 'string') {
            return sendJson(response, 400, { error: 'each add needs id:string and kind:string' })
          }
          if (!provider.adapters[a.kind]) {
            return sendJson(response, 400, { error: `unknown backend kind "${a.kind}"` })
          }
        }
        for (const r of removes) {
          if (typeof r !== 'string') return sendJson(response, 400, { error: 'removes items must be id strings' })
        }
        for (const o of order) {
          if (typeof o !== 'string') return sendJson(response, 400, { error: 'order items must be id strings' })
        }
        for (const w of weights) {
          if (typeof w?.id !== 'string' || typeof w?.weight !== 'number' || w.weight < 1 || w.weight > 10) {
            return sendJson(response, 400, { error: 'each weight needs id:string and weight:number(1..10)' })
          }
        }

        try {
          const cur = settingsService.get(SEARCH_POOL_SETTINGS_NS) ?? {}
          const removedSet = new Set(Array.isArray(cur.removed) ? cur.removed : [])
          let next = Array.isArray(cur.backends) ? cur.backends.map(cleanBackend) : []
          // 1. key 更新
          next = next.map((b) => {
            const patch = patches.find((p) => p.id === b.id)
            if (!patch) return b
            return { ...b, apiKey: patch.apiKey ?? b.apiKey }
          })
          // 2. 删除: 内置后端 → removed 标记(merge 时剔除); 自定义 → 直接移出数组
          for (const r of removes) {
            if (builtinIds.has(r)) removedSet.add(r)
            next = next.filter((b) => b.id !== r)
          }
          // 3. 添加: 任意已装 kind; 恢复被删内置时清除 removed 标记
          for (const a of adds) {
            if (next.some((b) => b.id === a.id) || builtinIds.has(a.id)) {
              return sendJson(response, 400, { error: `backend id "${a.id}" already exists` })
            }
            next.push({
              id: a.id,
              kind: a.kind,
              priority: a.priority ?? 99,
              apiKey: a.apiKey ?? '',
              baseURL: a.baseURL ?? '',
              weight: 1,
            })
            removedSet.delete(a.id)
          }
          // 4. 排序: 按 order 重排显示列表并重写 priority 1..n (failover 顺序 & rotate 轮询顺序)
          if (order.length > 0) {
            const byId = new Map(next.map((b) => [b.id, b]))
            const reordered = order.map((id) => byId.get(id)).filter(Boolean)
            for (const b of next) if (!order.includes(b.id)) reordered.push(b)
            next = reordered.map((b, i) => ({ ...b, priority: i + 1 }))
          }
          // 5. 轮询权重 (rotate 用)
          if (weights.length > 0) {
            next = next.map((b) => {
              const w = weights.find((x) => x.id === b.id)
              return w ? { ...b, weight: w.weight } : b
            })
          }
          // Update 的 merge 以顶层对象为界, 数组整体替换:
          await settingsService.update(SEARCH_POOL_SETTINGS_NS, { backends: next, removed: [...removedSet] })
          sendJson(response, 200, { ok: true })
        } catch (e) {
          sendJson(response, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    }),

    webServer.register({
      kind: 'exact',
      path: '/search-pool/quota',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        // 逐个真实调用各后端 usage() 接口 (仅支持的 kind), 失败返回 null
        const config = readConfig()
        const quota = {}
        for (const b of config.backends ?? []) {
          const usage = provider.adapters[b.kind]?.usage
          quota[b.id] = null
          if (typeof usage !== 'function') continue
          try {
            quota[b.id] = await usage({ ...b })
          } catch (e) {
            quota[b.id] = { error: e?.message ? String(e.message).slice(0, 120) : 'unknown' }
          }
        }
        sendJson(response, 200, { quota })
      },
    }),

    webServer.register({
      kind: 'exact',
      path: '/search-pool/config',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'untrusted origin' })
        let body
        try { body = await readJsonBody(request) } catch (e) {
          return sendJson(response, 400, { error: e instanceof Error ? e.message : String(e) })
        }
        if (!['failover', 'rotate'].includes(body?.strategy)) {
          return sendJson(response, 400, { error: 'strategy must be "failover" or "rotate"' })
        }
        try {
          await settingsService.update(SEARCH_POOL_SETTINGS_NS, { strategy: body.strategy })
          sendJson(response, 200, { ok: true, strategy: body.strategy })
        } catch (e) {
          sendJson(response, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    }),

    webServer.register({
      kind: 'exact',
      path: '/search-pool/reset',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'untrusted origin' })
        try {
          await settingsService.replace(SEARCH_POOL_SETTINGS_NS, {})
          sendJson(response, 200, { ok: true })
        } catch (e) {
          sendJson(response, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    }),
  ]

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose()
    }
  }, 'search-pool: http routes')
}
