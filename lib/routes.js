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
export function mountSearchPoolRoutes(ctx, { readConfig, provider }) {
  const settingsService = ctx.get('settings')
  if (settingsService === undefined) {
    console.warn('[search-pool] settings service unavailable — key management routes disabled')
    return
  }
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.warn('[search-pool] webServer service unavailable — key management routes disabled')
    return
  }

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
        const patches = Array.isArray(body?.backends) ? body.backends : null
        if (patches === null) return sendJson(response, 400, { error: 'expected { backends: [{ id, apiKey }] }' })
        for (const p of patches) {
          if (typeof p?.id !== 'string' || (p.apiKey !== undefined && typeof p.apiKey !== 'string')) {
            return sendJson(response, 400, { error: 'each patch needs id:string and optional apiKey:string' })
          }
        }

        try {
          const cur = settingsService.get(SEARCH_POOL_SETTINGS_NS) ?? {}
          const curBackends = Array.isArray(cur.backends) ? cur.backends : []
          const next = curBackends.map((b) => {
            const patch = patches.find((p) => p.id === b.id)
            if (!patch) return b
            return { ...b, apiKey: patch.apiKey ?? b.apiKey }
          })
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