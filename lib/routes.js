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
        if (
          (patches.length === 0 && adds.length === 0 && removes.length === 0) ||
          bodyIsObject === false
        ) {
          return sendJson(response, 400, {
            error: 'expected { backends?:[{id,apiKey}], adds?:[{id,kind,baseURL?,apiKey?,priority?}], removes?:[id] }',
          })
        }
        for (const p of patches) {
          if (typeof p?.id !== 'string' || (p.apiKey !== undefined && typeof p.apiKey !== 'string')) {
            return sendJson(response, 400, { error: 'each patch needs id:string and optional apiKey:string' })
          }
        }
        for (const a of adds) {
          if (typeof a?.id !== 'string' || typeof a?.kind !== 'string' || typeof a?.baseURL !== 'string') {
            return sendJson(response, 400, { error: 'each add needs id:string, kind:string, baseURL:string' })
          }
        }
        for (const r of removes) {
          if (typeof r !== 'string') return sendJson(response, 400, { error: 'removes items must be id strings' })
        }

        try {
          const cur = settingsService.get(SEARCH_POOL_SETTINGS_NS) ?? {}
          const curBackends = Array.isArray(cur.backends) ? cur.backends.map(cleanBackend) : []
          let next = curBackends.map((b) => {
            const patch = patches.find((p) => p.id === b.id)
            if (!patch) return b
            return { ...b, apiKey: patch.apiKey ?? b.apiKey }
          })
          for (const a of adds) {
            if (next.some((b) => b.id === a.id)) {
              return sendJson(response, 400, { error: `backend id "${a.id}" already exists` })
            }
            next.push({
              id: a.id,
              kind: a.kind,
              priority: a.priority ?? 99,
              apiKey: a.apiKey ?? '',
              baseURL: a.baseURL,
            })
          }
          for (const r of removes) {
            if (builtinIds.has(r)) {
              return sendJson(response, 400, { error: `"${r}" is a builtin backend and cannot be removed` })
            }
            next = next.filter((b) => b.id !== r)
          }
          // Update 的 merge 以顶层对象为界, 数组整体替换:
          await settingsService.update(SEARCH_POOL_SETTINGS_NS, { backends: next })
          sendJson(response, 200, { ok: true })
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
