/**
 * 后端适配器: 每个后端 = { needsKey, search(backend, request, signal) }
 * 返回 { sources, content?, truncated }, 或抛 SearchPoolError(kind 分类)
 *
 * 免费额度 (2026-08 核实):
 *   exa     — 注册 $20 + $10/月, 教育项目 $1000 (需 key)
 *   tavily  — 1000 积分/月, 无 key 走 keyless 匿名档
 *   serper  — 2500 次一次性试用 (需 key)
 *   serpapi — 250 次/月 (需 key)
 *   brave   — 2000 次/月, 注册需信用卡 (需 key)
 *   jina    — 无 key 20 RPM, key 后 500 RPM (s.jina.ai 搜索)
 *   ddg     — 完全免费 (非官方 HTML 端点, ToS 风险)
 *   searxng   — 自托管完全免费 (需 format: json)
 *   firecrawl — 1000 credits/月 (需 key; 同时支持 search + scrape)
 */
import { SearchPoolError, classifyHttpStatus } from './errors.js'

const UA = 'dsh-search-failover/0.3.6'

/** 带超时/取消分类的 fetch → text; 非 2xx 抛 SearchPoolError(kind 分类) */
async function fetchText(url, init, signal) {
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
  return text
}

async function fetchJson(url, init, signal) {
  const text = await fetchText(url, init, signal)
  try { return JSON.parse(text) } catch { throw new SearchPoolError('non-JSON response', 'transient') }
}

function requireKey(backend, name) {
  if (!backend.apiKey) throw new SearchPoolError(`${name}: no API key (set apiKey or apiKeyEnv)`, 'auth')
  return backend.apiKey
}

function limit(request) { return request.maxResults ?? 8 }

export const backends = {
  /** Exa REST — 需 key (api.exa.ai) */
  exa: {
    site: "https://dashboard.exa.ai/api-keys",
    needsKey: true,
    async search(backend, request, signal) {
      const key = requireKey(backend, 'exa')
      const data = await fetchJson('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'user-agent': UA },
        body: JSON.stringify({
          query: request.query,
          numResults: limit(request),
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
    async fetch(backend, request, signal) {
      const key = requireKey(backend, 'exa')
      const data = await fetchJson('https://api.exa.ai/contents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'user-agent': UA },
        body: JSON.stringify({ urls: [request.url], text: true }),
      }, signal)
      const text = data.results?.[0]?.text
      if (!text) throw new SearchPoolError('exa contents empty', 'transient')
      return { url: data.results[0].url || request.url, content: text, truncated: false }
    },
  },

  /** Tavily REST — key 可选: 有 key 走账户, 无 key 走 keyless 匿名档 */
  tavily: {
    site: "https://app.tavily.com",
    needsKey: false,
    async search(backend, request, signal) {
      const headers = { 'content-type': 'application/json', 'user-agent': UA }
      if (backend.apiKey) headers.authorization = `Bearer ${backend.apiKey}`
      else headers['x-tavily-access-mode'] = 'keyless'
      const data = await fetchJson('https://api.tavily.com/search', {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: request.query, max_results: limit(request), search_depth: 'basic' }),
      }, signal)
      const sources = (data.results ?? []).map((r) => ({
        url: r.url,
        ...(r.title ? { title: r.title } : {}),
        ...(r.content ? { snippet: r.content.slice(0, 500) } : {}),
      }))
      return { sources, truncated: false, ...(data.answer ? { content: data.answer } : {}) }
    },
    async fetch(backend, request, signal) {
      const headers = { 'content-type': 'application/json', 'user-agent': UA }
      const body = { urls: [request.url] }
      if (backend.apiKey) headers.authorization = `Bearer ${backend.apiKey}`
      else {
        headers['x-tavily-access-mode'] = 'keyless'
      }
      if (backend.apiKey) body.api_key = backend.apiKey
      const data = await fetchJson('https://api.tavily.com/extract', {
        method: 'POST', headers, body: JSON.stringify(body),
      }, signal)
      const text = data.results?.[0]?.raw_content
      if (!text) throw new SearchPoolError('tavily extract empty', 'transient')
      return { url: data.results[0].url || request.url, content: text, truncated: false }
    },
  },

  /** Serper.dev — 2500 次一次性试用 (google.serper.dev, 需 key) */
  serper: {
    site: "https://serper.dev/dashboard",
    needsKey: true,
    async search(backend, request, signal) {
      const key = requireKey(backend, 'serper')
      const data = await fetchJson('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'user-agent': UA },
        body: JSON.stringify({ q: request.query, num: limit(request) }),
      }, signal)
      const sources = (data.organic ?? []).map((r) => ({
        url: r.link,
        ...(r.title ? { title: r.title } : {}),
        ...(r.snippet ? { snippet: r.snippet } : {}),
        ...(r.date ? { publishedAt: r.date } : {}),
      }))
      return {
        sources,
        truncated: false,
        ...(data.answerBox?.answer ? { content: data.answerBox.answer } : {}),
      }
    },
  },

  /** SerpApi — 250 次/月 (serpapi.com, 需 key) */
  serpapi: {
    site: "https://serpapi.com/manage-api-key",
    needsKey: true,
    async search(backend, request, signal) {
      const key = requireKey(backend, 'serpapi')
      const params = new URLSearchParams({
        engine: 'google',
        q: request.query,
        api_key: key,
        num: String(limit(request)),
      })
      const data = await fetchJson(`https://serpapi.com/search?${params}`, {
        headers: { 'user-agent': UA },
      }, signal)
      const sources = (data.organic_results ?? []).map((r) => ({
        url: r.link,
        ...(r.title ? { title: r.title } : {}),
        ...(r.snippet ? { snippet: r.snippet } : {}),
        ...(r.date ? { publishedAt: r.date } : {}),
      }))
      return {
        sources,
        truncated: false,
        ...(data.answer_box?.answer ? { content: data.answer_box.answer } : {}),
      }
    },
    /** 额度查询: /account 公开接口 (plan/已用/剩余/重置日) */
    async usage(backend) {
      const key = requireKey(backend, 'serpapi')
      const data = await fetchJson(`https://serpapi.com/account?api_key=${encodeURIComponent(key)}`)
      return {
        plan: data.plan_name ?? data.plan_id ?? 'unknown',
        used: data.this_month_usage ?? 0,
        limit: data.searches_per_month ?? 0,
        remaining: data.total_searches_left ?? null,
        resetAt: data.plan_renewal_date ?? null,
      }
    },
  },

  /** Brave Search — 2000 次/月 (api.search.brave.com, 需 key, 注册要信用卡) */
  brave: {
    site: "https://brave.com/search/api/",
    needsKey: true,
    async search(backend, request, signal) {
      const key = requireKey(backend, 'brave')
      const params = new URLSearchParams({ q: request.query, count: String(limit(request)) })
      const data = await fetchJson(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: { 'x-subscription-token': key, accept: 'application/json', 'user-agent': UA },
      }, signal)
      const sources = ((data.web ?? {}).results ?? []).map((r) => ({
        url: r.url,
        ...(r.title ? { title: r.title } : {}),
        ...(r.description ? { snippet: r.description } : {}),
        ...(r.age ? { publishedAt: r.age } : {}),
      }))
      return { sources, truncated: false }
    },
  },

  /** Jina Search (s.jina.ai) — 需免费注册 key (实测 2026-08 无 key 已返回 401) */
  jina: {
    site: "https://jina.ai",
    needsKey: true,
    async search(backend, request, signal) {
      const key = requireKey(backend, 'jina')
      const headers = { 'user-agent': UA, accept: 'text/markdown', authorization: `Bearer ${key}` }
      const md = await fetchText(`https://s.jina.ai/${encodeURIComponent(request.query)}`, { headers }, signal)
      const parsed = parseJinaMarkdown(md, limit(request))
      if (parsed.length === 0) throw new SearchPoolError('jina returned no results', 'transient')
      return { sources: parsed, truncated: false }
    },
    async fetch(backend, request, signal) {
      const key = requireKey(backend, 'jina')
      const headers = { 'user-agent': UA, accept: 'text/markdown', authorization: `Bearer ${key}` }
      const md = await fetchText(`https://r.jina.ai/${encodeURIComponent(request.url)}`, { headers }, signal)
      if (!md.trim()) throw new SearchPoolError('jina reader empty', 'transient')
      return { url: request.url, content: md, truncated: false }
    },
  },

  /** DuckDuckGo HTML 端点 — 完全免费。⚠️ 实测 2026-08 html/lite 双端点均被
   *  异常检测拦截 (HTTP 202 anomaly 页), 可能因网络/IP 而异; 兜底可换
   *  duckduckgo-mcp-server (npx, 需运行时依赖)。非官方接口, ToS 风险见 README */
  ddg: {
    needsKey: false,
    async search(backend, request, signal) {
      const body = new URLSearchParams({ q: request.query, kl: 'wt-wt' })
      const html = await fetchText('https://html.duckduckgo.com/html/', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        body,
      }, signal)
      const sources = []
      const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
        .map((m) => stripHtml(m[1]))
      let i = 0
      for (const m of html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
        if (sources.length >= limit(request)) break
        const url = decodeDdgUrl(m[1])
        if (!url) continue
        sources.push({ url, title: stripHtml(m[2]), ...(snippets[i] ? { snippet: snippets[i] } : {}) })
        i++
      }
      if (sources.length === 0) throw new SearchPoolError('ddg returned no results', 'transient')
      return { sources, truncated: false }
    },
  },

  /** SearXNG 自托管 — 完全免费, 需实例开启 format: json */
  searxng: {
    site: "https://docs.searxng.org",
    needsKey: false,
    async search(backend, request, signal) {
      const base = (
        backend.baseURL
        || (typeof process !== 'undefined' ? process.env.SEARXNG_BASE_URL : undefined)
        || 'http://localhost:8080'
      ).replace(/\/+$/, '')
      const params = new URLSearchParams({ q: request.query, format: 'json' })
      const data = await fetchJson(`${base}/search?${params}`, {
        headers: { 'user-agent': UA },
      }, signal)
      const sources = (data.results ?? []).map((r) => ({
        url: r.url,
        ...(r.title ? { title: r.title } : {}),
        ...(r.content ? { snippet: r.content.slice(0, 500) } : {}),
        ...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
      }))
      return { sources, truncated: false }
    },
  },

  /** Firecrawl — 1000 credits/月, 搜索 + 抓取 (api.firecrawl.dev, 需 key) */
  firecrawl: {
    site: "https://www.firecrawl.dev/app/api-keys",
    needsKey: true,
    async search(backend, request, signal) {
      const key = requireKey(backend, 'firecrawl')
      const data = await fetchJson('https://api.firecrawl.dev/v1/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'user-agent': UA },
        body: JSON.stringify({ query: request.query, limit: limit(request) }),
      }, signal)
      const rows = data.data ?? data.results ?? []
      const sources = rows.map((r) => ({
        url: r.url,
        ...(r.title ? { title: r.title } : {}),
        ...((r.markdown || r.description) ? { snippet: String(r.markdown || r.description).slice(0, 500) } : {}),
      }))
      if (sources.length === 0) throw new SearchPoolError('firecrawl returned no results', 'transient')
      return { sources, truncated: false }
    },
    async fetch(backend, request, signal) {
      const key = requireKey(backend, 'firecrawl')
      const data = await fetchJson('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'user-agent': UA },
        body: JSON.stringify({ url: request.url, formats: ['markdown'] }),
      }, signal)
      const md = data.data?.markdown || data.markdown
      if (!md) throw new SearchPoolError('firecrawl scrape empty', 'transient')
      return { url: data.data?.metadata?.sourceURL || request.url, content: md, truncated: false }
    },
  },
}

/** s.jina.ai 返回 markdown: 链接行 [title](url) + 后续描述行, 直到下一个链接 */
function parseJinaMarkdown(md, maxResults) {
  const sources = []
  let cur = null
  const push = () => {
    if (!cur) return
    sources.push({
      url: cur.url,
      ...(cur.title ? { title: cur.title } : {}),
      ...(cur.desc.length ? { snippet: cur.desc.join(' ').slice(0, 300) } : {}),
    })
    cur = null
  }
  for (const line of md.split('\n')) {
    if (sources.length >= maxResults) break
    const m = line.match(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/)
    if (m) {
      push()
      cur = { url: m[2], title: m[1].replace(/^[*\d.\s]+/, '').trim() || undefined, desc: [] }
    } else if (cur) {
      const t = line.replace(/^[-*#>\s]+/, '').trim()
      if (t && !/^\d+[.)]/.test(t) && !/^search results?/i.test(t)) cur.desc.push(t)
    }
  }
  push()
  return sources
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
