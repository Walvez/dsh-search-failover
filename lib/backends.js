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

  /**
   * opencodex web-search sidecar (127.0.0.1:10100) — 透明转发给 opencodex。
   *
   * ★ 真正执行搜索的是 opencodex 设置里选的"网页搜索附属服务"
   *   (opencodex config 的 webSearchSidecar.backend/model, 例如 gpt-5.6-luna
   *   或 grok) — 本后端不指定、不覆盖那个选择; 用户在 opencodex 里切换
   *   sidecar, 这里的搜索行为跟着变。
   *
   * carrierModel 只是承载合成 web_search 工具调用的"壳"模型 (opencodex 的
   * agentic loop 需要一个主模型发起工具调用并整合结果), 默认用最便宜的
   * opencode-go/glm-5.3-flash, 可用 carrierModel 覆盖。
   *
   * needsKey: false — opencodex 本机 loopback 默认免 token, 有 token 时用。
   * 失败分类: 服务没起/超时 → transient(熔断短冷却自动下探);
   *          401/403 → auth(token 不匹配, 不值得重试)。
   */
  opencodex: {
    site: 'https://github.com/bitkyc08/opencodex',
    needsKey: false,
    async search(backend, request, signal) {
      const base = (backend.baseURL
        || (typeof process !== 'undefined' ? process.env.OPENCODEX_BASE_URL : undefined)
        || 'http://127.0.0.1:10100').replace(/\/+$/, '')
      const token = backend.apiKey
        || (typeof process !== 'undefined' ? process.env.OPENCODEX_DATA_TOKEN : undefined)
        || 'ocx_data_dsh'
      const carrier = backend.carrierModel || 'opencode-go/glm-5.3-flash'
      const n = limit(request)
      const body = {
        model: carrier,
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: `Web search: ${request.query}\n\nReturn up to ${n} distinct relevant results, one per line, format: title — url — one-sentence summary. No preamble, no markdown headers.`,
          }],
        }],
        tools: [{ type: 'web_search' }],
        max_output_tokens: 2000,
      }
      const headers = { 'content-type': 'application/json', 'user-agent': UA }
      if (token) headers.authorization = `Bearer ${token}`
      // opencodex 的 web-search agentic loop 无条件回 SSE (即使请求 stream:false):
      // sidecar 搜索在流内执行, 最终整合结果在 response.completed 事件的 response 里。
      const res = await fetchText(`${base}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(body) }, signal)
      const data = completedResponseFromSse(res)
      // 无 completed 事件: 流被超时截断 (sidecar 全程 >timeoutMs) 或上游中断 —
      // 报 timeout 而非 no text, 熔断器按瞬时失败短冷却, 下一个引擎立即接管。
      if (!data) throw new SearchPoolError('opencodex sidecar stream ended without response.completed (sidecar too slow or interrupted)', 'transient')
      const text = extractResponseText(data)
      if (!text) throw new SearchPoolError('opencodex sidecar returned no text', 'transient')
      const sources = parseSidecarSources(text)
      if (sources.length === 0) throw new SearchPoolError('opencodex sidecar returned no parseable sources', 'transient')
      return { sources: sources.slice(0, n), truncated: false }
    },
  },
}

/** 从 /v1/responses 的 SSE 流里抽 response.completed 事件的 response 对象; 顶层 JSON 原样返回 */
export function completedResponseFromSse(body) {
  if (body.startsWith('{')) {
    try { return JSON.parse(body) } catch { return null }
  }
  let final = null
  for (const m of body.matchAll(/^data: (.*)$/gm)) {
    try {
      const evt = JSON.parse(m[1])
      if (evt?.type === 'response.completed' && evt.response) final = evt.response
    } catch { /* keep-alive/comment frames */ }
  }
  return final
}

/** 从 /v1/responses 响应里提取全部 output_text */
export function extractResponseText(data) {
  const out = data?.output
  if (!Array.isArray(out)) {
    if (typeof data?.output_text === 'string') return data.output_text
    return ''
  }
  const parts = []
  for (const item of out) {
    for (const c of item?.content ?? []) {
      if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text)
    }
  }
  return parts.join('\n')
}

/** 解析 "title — url — summary" 行(容错 url 前后的分隔符; url 必须是 http(s)) */
export function parseSidecarSources(text) {
  const sources = []
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*\d.\s]+/, '')
    if (!line) continue
    const urlMatch = line.match(/https?:\/\/[^\s)\]>"']+/)
    if (!urlMatch) continue
    const url = urlMatch[0].replace(/[.,;]+$/, '')
    const before = line.slice(0, urlMatch.index).trim().replace(/[—–\-:]+$/, '').trim()
    const after = line.slice(urlMatch.index + urlMatch[0].length).trim().replace(/^[—–\-:]+/, '').trim()
    const title = (before || url).slice(0, 200)
    const snippet = after.slice(0, 500) || undefined
    sources.push({ url, title, ...(snippet ? { snippet } : {}) })
  }
  return sources
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
