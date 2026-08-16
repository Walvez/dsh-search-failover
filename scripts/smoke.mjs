/**
 * 真实网络 smoke 测试 — 逐个调用后端, 打印前 N 条结果标题
 * 用法: EXA_API_KEY=xxx node scripts/smoke.mjs [kind...]
 * 默认跑全部; 也可指定子集: node scripts/smoke.mjs ddg jina tavily
 */
import { backends } from '../lib/backends.js'

const kinds = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(backends)

for (const kind of kinds) {
  const adapter = backends[kind]
  if (!adapter) { console.log(`[skip] 未知 kind: ${kind}`); continue }
  const t0 = Date.now()
  try {
    const r = await adapter.search({ apiKey: process.env[`${kind.toUpperCase()}_API_KEY`] ?? '' }, {
      query: 'DeepSeek V4 release date',
      maxResults: 5,
    })
    const ms = Date.now() - t0
    console.log(`[ok]   ${kind.padEnd(8)} ${ms}ms  ${r.sources.length} 条`)
    for (const s of r.sources.slice(0, 3)) console.log(`       - ${(s.title ?? s.url).slice(0, 80)}`)
    if (r.content) console.log(`       answer: ${r.content.slice(0, 100)}`)
  } catch (e) {
    const ms = Date.now() - t0
    console.log(`[fail] ${kind.padEnd(8)} ${ms}ms  kind=${e?.kind ?? '?'}  ${(e?.message ?? e).slice(0, 120)}`)
  }
}
