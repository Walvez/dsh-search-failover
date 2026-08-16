/**
 * 后端适配器: 每个后端 = { needsKey, search(backend, request, signal) }
 * 返回 { sources, content?, truncated }, 或抛 SearchPoolError(kind 分类)
 */
import { SearchPoolError, classifyHttpStatus } from './errors.js'

const UA = 'dsh-search-failover/0.1.0'

async function fetchJson(url, init, signal) {
  let res
  try {
    res = await fetch(url, { ...init, signal })
  } catch (e) {
    const name = e?.name ?? ''
    if (name === 'TimeoutError') throw new SearchPoolError('timeout', 'transient')
    if (name === 'AbortError') {
      if (signal?.aborted) throw new SearchPoolError('aborted', 'abort', 'WEB_ABORTED')
      throw new SearchPoolError('timeout', 'transient')
    }
    throw new SearchPoolError(`fetch failed: ${e?.message ?? e}`, 'transient')
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    const status = /insufficient|quota|billing|rate.?limit/i.test(text) ? 429 : res.status
    throw new SearchPoolError(`HTTP ${res.status}: ${text.slice(0, 160)}`, classifyHttpStatus(status))
  }
  try { return JSON.parse(text) } catch { throw new SearchPoolError('non-JSON response', 'transient') }
}

export const backends = {
  /** Exa REST — 需 key (api.exa.ai) */
  exa: {
    needsKey: true,
    async search(backend, request, signal) {
      const key = backend.apiKey
      if (!key) throw new SearchPoolError('exa: no API key (set apiKey or apiKeyEnv)', 'auth')
      const data = await fetchJson('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'user-agent': UA },
        body: JSON.stringify({
          query: request.query,
          numResults: request.maxResults ?? 8,
          type: 'auto',
          contents: { highlights: { numSentences: 1 } },
        }),
      }, signal)
      const sources = (data.results ?? []).map((r) => ({
        url: r.url,
        ...(r.title ? { title: r.title } : {}),
        ...(r.highlights?.[0] ? { snippet: r.highlights[0] } : {}),
        ...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
      }))
      return { sources, truncated: false }
    },
  },

  /** Tavily REST — key 可选: 有 key 走账户, 无 key 走 keyless 匿名档 */
  tavily: {
    needsKey: false,
    async search(backend, request, signal) {
      const headers = { 'content-type': 'application/json', 'user-agent': UA }
      if (backend.apiKey) headers.authorization = `Bearer ${backend.apiKey}`
      else headers['x-tavily-access-mode'] = 'keyless'
      const data = await fetchJson('https://api.tavily.com/search', {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: request.query, max_results: request.maxResults ?? 8, search_depth: 'basic' }),
      }, signal)
      const sources = (data.results ?? []).map((r) => ({
        url: r.url,
        ...(r.title ? { title: r.title } : {}),
        ...(r.content ? { snippet: r.content.slice(0, 500) } : {}),
      }))
      return { sources, truncated: false, ...(data.answer ? { content: data.answer } : {}) }
    },
  },

  /** DuckDuckGo HTML 端点 — 无 key。注意: 属非官方接口, ToS 风险见 README */
  ddg: {
    needsKey: false,
    async search(backend, request, signal) {
      const limit = request.maxResults ?? 8
      const body = new URLSearchParams({ q: request.query, kl: 'wt-wt' })
      let res
      try {
        res = await fetch('https://html.duckduckgo.com/html/', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
          body,
          signal,
        })
      } catch (e) {
        if (e?.name === 'TimeoutError' || (e?.name === 'AbortError' && !signal?.aborted)) {
          throw new SearchPoolError('timeout', 'transient')
        }
        if (e?.name === 'AbortError') throw new SearchPoolError('aborted', 'abort', 'WEB_ABORTED')
        throw new SearchPoolError(`ddg fetch failed: ${e?.message ?? e}`, 'transient')
      }
      if (!res.ok) throw new SearchPoolError(`ddg HTTP ${res.status}`, classifyHttpStatus(res.status))
      const html = await res.text()
      const sources = []
      const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
        .map((m) => stripHtml(m[1]))
      let i = 0
      for (const m of html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
        if (sources.length >= limit) break
        const url = decodeDdgUrl(m[1])
        if (!url) continue
        sources.push({ url, title: stripHtml(m[2]), ...(snippets[i] ? { snippet: snippets[i] } : {}) })
        i++
      }
      if (sources.length === 0) throw new SearchPoolError('ddg returned no results', 'transient')
      return { sources, truncated: false }
    },
  },
}

function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim()
}

/** DDG 结果链接形如 //duckduckgo.com/l/?uddg=<encoded>&rut=... */
function decodeDdgUrl(href) {
  try {
    const m = href.match(/[?&]uddg=([^&]+)/)
    if (m) return decodeURIComponent(m[1])
    if (href.startsWith('http')) return href
    return null
  } catch { return null }
}
