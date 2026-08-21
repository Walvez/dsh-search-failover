/**
 * dsh-search-failover client bundle (browser side), hand-authored CJS
 * (no build step) — same shape as dsh-codex-sync's bundle.
 *
 * Registers a "搜索池" settings section (settings.section, order 110) that
 * lets you fill in the API key for every search backend and save it. Keys
 * persist into the host `settings` service (settings.yaml user layer) and
 * take effect immediately — the host provider re-reads config on every
 * search, so no restart is needed.
 *
 * Data channel is the same-origin HTTP routes /search-pool/* mounted by the
 * host half (the web client settings seam refuses third-party namespaces,
 * so we never touch settingsScope in the browser).
 */
window.__ModuleLoader__.load({ id: 'dsh-search-failover', factory: (require) => {
var module = { exports: {} }
var exports = module.exports
'use strict'
const React = require('react')
const { useState, useEffect, useCallback } = React

const NS = 'searchPool'
const LS = {
  zh: {
    nav: '搜索池',
    desc: '配置各大搜索 / 抓取后端的 API Key 与路由策略。密钥仅存储于本地 settings.yaml，保存即热生效（无需重启）。同一引擎可换行填多个 Key。',
    keysTitle: '后端引擎列表',
    backend: '后端引擎',
    key: 'API Key 凭证',
    status: '健康状态',
    hasKey: '已配置',
    noKey: '未配置',
    stClosed: '正常',
    stOpen: '冷却中',
    stQuota: '额度熔断',
    placeholder: '留空保持现有配置；多 Key 换行或逗号分隔',
    save: '保存配置',
    saving: '正在保存…',
    saved: '配置已保存，实时生效 ✓',
    saveFailed: '保存失败：',
    reset: '恢复默认配置',
    resetting: '正在恢复…',
    resetDone: '已恢复默认配置（行内声明）',
    loading: '正在获取后端状态…',
    loadFailed: '读取失败：',
    customTag: '自定义',
    addTitle: '添加自定义后端',
    addDesc: '支持添加自托管 SearXNG 或任意已知类型引擎：指定唯一标识即可无缝并入搜索池。',
    addName: '引擎标识 (id)',
    addUrl: '服务地址 (baseURL)',
    addKey: 'API Key (可选)',
    addBtn: '确认添加',
    addFailed: '添加失败：',
    removeFailed: '删除失败：',
    cancel: '取消',
    strategyTitle: '路由调度策略',
    strategyDesc: '优先顺序：按列表优先级依次尝试，遇错或熔断自动下探下一个引擎。轮询分摊：搜索请求按权重分散到健康后端，最大化利用各源免费配额。',
    failover: '🎯 优先顺序 (Failover)',
    rotate: '🔄 轮询分摊 (Rotate)',
    strategySaved: '策略已更新，实时生效',
    quotaTitle: '额度统计',
    quotaLoading: '查询中…',
    quotaNoApi: '无公开接口',
    quotaError: '查询异常',
    quotaPlan: '套餐',
    quotaUsed: '已用',
    quotaLeft: '剩余',
    quotaReset: '重置',
    refreshQuota: '刷新额度',
    moveUp: '提高优先级',
    moveDown: '降低优先级',
    weightLabel: '权重',
    weightHint: '轮询模式下的流量分配比例 (1-10)',
    test: '测试连接',
    testing: '测试中…',
    testOk: '测试成功',
    tipTitle: '💡 零 Token 消耗 & AI 自主换源',
    tipDesc: '搜索与抓取直接对接各引擎 API，不产生模型 Token 消耗。AI 觉得默认搜索结果不理想时，可自主调用 web_search_from(query, source) 换源对比。',
    openUrl: '前往获取 Key ↗',
  },
  en: {
    nav: 'Search Pool',
    desc: 'Manage API keys and routing for search/fetch backends. Keys stay in local settings.yaml and take effect immediately. Multiple keys per engine: one per line.',
    keysTitle: 'Search Backends',
    backend: 'Backend',
    key: 'API Key Credential',
    status: 'Health',
    hasKey: 'configured',
    noKey: 'missing',
    stClosed: 'healthy',
    stOpen: 'cooldown',
    stQuota: 'quota cooldown',
    placeholder: 'leave empty to keep current; multiple keys: one per line or comma-separated',
    save: 'Save Changes',
    saving: 'Saving…',
    saved: 'Saved, effective now ✓',
    saveFailed: 'Save failed: ',
    reset: 'Reset to Defaults',
    resetting: 'Resetting…',
    resetDone: 'Reset to inline defaults',
    loading: 'Fetching search pool state…',
    loadFailed: 'Load failed: ',
    customTag: 'custom',
    addTitle: 'Add Custom Backend',
    addDesc: 'Add self-hosted SearXNG or any supported engine: provide an ID to seamlessly join the pool.',
    addName: 'Engine ID',
    addUrl: 'Base URL',
    addKey: 'API Key (optional)',
    addBtn: 'Add Engine',
    addFailed: 'Add failed: ',
    removeFailed: 'Remove failed: ',
    cancel: 'Cancel',
    strategyTitle: 'Routing Strategy',
    strategyDesc: 'Failover attempts backends in order of priority; Rotate distributes search requests by weight across healthy engines to optimize free quotas.',
    failover: '🎯 Failover',
    rotate: '🔄 Weighted Rotate',
    strategySaved: 'Strategy updated, effective now',
    quotaTitle: 'Quota Status',
    quotaLoading: 'Querying…',
    quotaNoApi: 'No public API',
    quotaError: 'Query failed',
    quotaPlan: 'Plan',
    quotaUsed: 'Used',
    quotaLeft: 'Left',
    quotaReset: 'Resets',
    refreshQuota: 'Refresh',
    moveUp: 'Increase Priority',
    moveDown: 'Decrease Priority',
    weightLabel: 'Weight',
    weightHint: 'Traffic distribution weight in rotate mode (1-10)',
    test: 'Test Connection',
    testing: 'Testing…',
    testOk: 'Healthy',
    tipTitle: '💡 Zero Model Token & AI Source Switching',
    tipDesc: 'Search and fetch hit engine APIs directly with 0 model token cost. AI can use web_search_from(query, source) to retry with specific engines if needed.',
    openUrl: 'Get Key ↗',
  },
}

// 现代化设计规范样式常量
const card = {
  background: 'rgba(127, 127, 127, 0.04)',
  border: '1px solid rgba(128, 128, 128, 0.14)',
  borderRadius: '12px',
  padding: '16px',
  marginBottom: '16px',
  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)',
}

const input = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 11px',
  borderRadius: '8px',
  border: '1px solid rgba(128, 128, 128, 0.22)',
  background: 'rgba(0, 0, 0, 0.12)',
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: '13px',
  outline: 'none',
  transition: 'border-color 0.15s ease, background 0.15s ease',
}

const buttonPrimary = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  padding: '8px 18px',
  borderRadius: '8px',
  border: '1px solid rgba(37, 99, 235, 0.3)',
  cursor: 'pointer',
  background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
  color: '#ffffff',
  fontSize: '13px',
  fontWeight: 600,
  boxShadow: '0 2px 6px rgba(37, 99, 235, 0.25)',
  transition: 'opacity 0.15s ease, transform 0.1s ease',
}

const buttonGhost = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '4px',
  padding: '7px 14px',
  borderRadius: '8px',
  border: '1px solid rgba(128, 128, 128, 0.25)',
  cursor: 'pointer',
  background: 'rgba(127, 127, 127, 0.06)',
  color: 'inherit',
  fontSize: '13px',
  fontWeight: 500,
  transition: 'background 0.15s ease, border-color 0.15s ease',
}

const badgeStyle = (theme) => {
  if (theme === 'green') {
    return {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      padding: '3px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600,
      background: 'rgba(47, 158, 68, 0.14)', color: '#2f9e44',
      border: '1px solid rgba(47, 158, 68, 0.28)',
      whiteSpace: 'nowrap',
    }
  }
  if (theme === 'orange') {
    return {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      padding: '3px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600,
      background: 'rgba(232, 89, 12, 0.14)', color: '#e8590c',
      border: '1px solid rgba(232, 89, 12, 0.28)',
      whiteSpace: 'nowrap',
    }
  }
  if (theme === 'yellow') {
    return {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      padding: '3px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600,
      background: 'rgba(245, 159, 0, 0.14)', color: '#f59f00',
      border: '1px solid rgba(245, 159, 0, 0.28)',
      whiteSpace: 'nowrap',
    }
  }
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    padding: '3px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600,
    background: 'rgba(128, 128, 128, 0.14)', color: 'inherit',
    border: '1px solid rgba(128, 128, 128, 0.28)',
    whiteSpace: 'nowrap',
  }
}

const iconBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '28px',
  height: '28px',
  borderRadius: '6px',
  border: '1px solid rgba(128, 128, 128, 0.18)',
  background: 'rgba(127, 127, 127, 0.06)',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: '12px',
  padding: 0,
  transition: 'background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease, transform 0.1s ease',
}

const linkStyle = {
  color: '#3b82f6',
  textDecoration: 'none',
  fontWeight: 600,
  fontSize: '13px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
}

const chipTag = (bg, color) => ({
  display: 'inline-flex',
  alignItems: 'center',
  padding: '1px 6px',
  borderRadius: '6px',
  background: bg || 'rgba(127, 127, 127, 0.14)',
  color: color || 'inherit',
  fontSize: '10px',
  fontWeight: 600,
  letterSpacing: '0.2px',
})

function fmtCooldown(ms) {
  if (!ms || ms <= 0) return ''
  const s = Math.ceil(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function SearchPoolSection({ t }) {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [keys, setKeys] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [msgErr, setMsgErr] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ id: '', kind: 'searxng', baseURL: '', apiKey: '' })
  const [quota, setQuota] = useState(null)
  const [testBusy, setTestBusy] = useState(null)
  const [testResults, setTestResults] = useState({})

  const load = useCallback(async () => {
    setError('')
    try {
      const [stateRes, quotaRes] = await Promise.all([
        fetch('/search-pool/state', { cache: 'no-store' }),
        fetch('/search-pool/quota', { cache: 'no-store' }),
      ])
      if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`)
      setState(await stateRes.json())
      if (quotaRes.ok) setQuota(await quotaRes.json())
      else setQuota(null)
    } catch (e) {
      setError(t('loadFailed') + String(e.message || e))
    }
  }, [t])

  useEffect(() => { load() }, [load])

  const saveStrategy = async (strategy) => {
    setBusy(true)
    setMsg('')
    try {
      const res = await fetch('/search-pool/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setMsg(t('strategySaved'))
      setMsgErr(false)
      load()
    } catch (e) {
      setMsg(t('saveFailed') + String(e.message || e))
      setMsgErr(true)
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    setMsg('')
    try {
      const backends = Object.entries(keys)
        .filter(([, v]) => v !== '')
        .map(([id, apiKey]) => ({ id, apiKey }))
      const res = await fetch('/search-pool/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ backends }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setMsg(t('saved'))
      setMsgErr(false)
      setKeys({})
      load()
    } catch (e) {
      setMsg(t('saveFailed') + String(e.message || e))
      setMsgErr(true)
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    setBusy(true)
    setMsg('')
    try {
      const res = await fetch('/search-pool/reset', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setMsg(t('resetDone'))
      setMsgErr(false)
      setKeys({})
      load()
    } catch (e) {
      setMsg(t('saveFailed') + String(e.message || e))
      setMsgErr(true)
    } finally {
      setBusy(false)
    }
  }

  const post = async (payload, okMsg) => {
    setBusy(true)
    setMsg('')
    try {
      const res = await fetch('/search-pool/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setMsg(okMsg)
      setMsgErr(false)
      setKeys({})
      load()
      return true
    } catch (e) {
      setMsg(t('saveFailed') + String(e.message || e))
      setMsgErr(true)
      return false
    } finally {
      setBusy(false)
    }
  }

  const addBackend = async () => {
    const id = addForm.id.trim()
    const kind = addForm.kind
    const baseURL = addForm.baseURL.trim()
    if (!id || !kind) {
      setMsg(t('addFailed') + 'id/kind required')
      setMsgErr(true)
      return
    }
    if (kind === 'searxng' && !baseURL) {
      setMsg(t('addFailed') + 'baseURL required for searxng')
      setMsgErr(true)
      return
    }
    const add = { id, kind, apiKey: addForm.apiKey.trim() }
    if (baseURL) add.baseURL = baseURL
    const ok = await post({ adds: [add] }, t('saved'))
    if (ok !== false) {
      setShowAdd(false)
      setAddForm({ id: '', kind: 'searxng', baseURL: '', apiKey: '' })
    }
  }

  const moveBackend = async (id, dir) => {
    if (!state) return
    const list = [...state.backends]
    const i = list.findIndex((b) => b.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= list.length) return
    const [b] = list.splice(i, 1)
    list.splice(j, 0, b)
    setBusy(true)
    setMsg('')
    try {
      const res = await fetch('/search-pool/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ order: list.map((x) => x.id) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setMsg(t('saved'))
      setMsgErr(false)
      load()
    } catch (e) {
      setMsg(t('saveFailed') + String(e.message || e))
      setMsgErr(true)
    } finally {
      setBusy(false)
    }
  }

  const setWeight = async (id, weight) => {
    const w = Math.max(1, Math.min(10, Math.round(Number(weight) || 1)))
    setBusy(true)
    setMsg('')
    try {
      const res = await fetch('/search-pool/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ weights: [{ id, weight: w }] }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setMsg(t('saved'))
      setMsgErr(false)
      load()
    } catch (e) {
      setMsg(t('saveFailed') + String(e.message || e))
      setMsgErr(true)
    } finally {
      setBusy(false)
    }
  }

  const testBackend = async (id) => {
    setTestBusy(id)
    try {
      const res = await fetch('/search-pool/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const data = await res.json()
      setTestResults((r) => ({ ...r, [id]: data }))
    } catch (e) {
      setTestResults((r) => ({ ...r, [id]: { ok: false, error: String(e.message || e) } }))
    } finally {
      setTestBusy(null)
    }
  }

  const removeBackend = async (id) => {
    setBusy(true)
    setMsg('')
    try {
      const res = await fetch('/search-pool/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ removes: [id] }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setMsg(t('saved'))
      setMsgErr(false)
      load()
    } catch (e) {
      setMsg(t('removeFailed') + String(e.message || e))
      setMsgErr(true)
    } finally {
      setBusy(false)
    }
  }

  const backends = state?.backends ?? []
  const strategy = state?.strategy ?? 'failover'

  return React.createElement('div', { style: { padding: '4px 2px', fontSize: '13px', lineHeight: 1.6 } },
    // 顶部说明
    React.createElement('div', { style: { marginBottom: '16px', opacity: 0.85, fontSize: '13px' } }, t('desc')),

    // 卡片 1: 路由策略
    React.createElement('div', { style: card },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' } },
        React.createElement('h4', { style: { margin: 0, fontWeight: 600, fontSize: '14px' } }, t('strategyTitle')),
        strategy === 'rotate' && React.createElement('button', {
          style: { ...buttonGhost, padding: '4px 10px', fontSize: '12px' },
          disabled: busy,
          onClick: load,
        }, '↻ ' + t('refreshQuota')),
      ),
      React.createElement('p', { style: { margin: '0 0 12px', opacity: 0.7, fontSize: '12px', lineHeight: 1.5 } }, t('strategyDesc')),
      // 胶囊式分段切换器 (Segmented Switcher)
      React.createElement('div', {
        style: {
          display: 'inline-flex',
          padding: '3px',
          borderRadius: '10px',
          background: 'rgba(0, 0, 0, 0.15)',
          border: '1px solid rgba(128, 128, 128, 0.18)',
          gap: '2px',
        },
      },
        ['failover', 'rotate'].map((s) => {
          const active = s === strategy
          return React.createElement('button', {
            key: s,
            style: {
              padding: '7px 16px',
              borderRadius: '8px',
              border: '0',
              cursor: busy ? 'default' : 'pointer',
              background: active ? 'linear-gradient(135deg, #2563eb, #1d4ed8)' : 'transparent',
              color: active ? '#ffffff' : 'inherit',
              fontWeight: active ? 600 : 400,
              fontSize: '12px',
              boxShadow: active ? '0 1px 4px rgba(37, 99, 235, 0.3)' : 'none',
              opacity: busy && !active ? 0.6 : 1,
              transition: 'all 0.15s ease',
            },
            disabled: busy,
            onClick: () => saveStrategy(s),
          }, t(s === 'failover' ? 'failover' : 'rotate'))
        }),
      ),
    ),

    // 卡片 2: 后端列表 (优雅卡片流布局，替代拥挤狭窄的表格)
    React.createElement('div', { style: card },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          React.createElement('h4', { style: { margin: 0, fontWeight: 600, fontSize: '14px' } }, t('keysTitle')),
          React.createElement('span', { style: chipTag('rgba(37, 99, 235, 0.12)', '#3b82f6') }, `${backends.length} 个引擎`),
        ),
        React.createElement('button', {
          style: { ...buttonGhost, padding: '5px 12px', fontSize: '12px' },
          disabled: busy,
          onClick: () => setShowAdd((v) => !v),
        }, showAdd ? t('cancel') : '+ ' + t('addTitle')),
      ),

      // 引擎卡片流
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        backends.map((b, idx) => {
          const q = quota?.quota?.[b.id]
          let quotaText = null
          if (q && !q.error) {
            quotaText = `${q.plan} · ${t('quotaLeft')} ${q.remaining}/${q.limit}${q.resetAt ? ' · ' + q.resetAt.slice(0, 10) : ''}`
          } else if (q && q.error) {
            quotaText = t('quotaError')
          }
          const testRes = testResults[b.id]

          return React.createElement('div', {
            key: b.id,
            style: {
              background: 'rgba(127, 127, 127, 0.03)',
              border: '1px solid rgba(128, 128, 128, 0.14)',
              borderRadius: '10px',
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              transition: 'border-color 0.15s ease, background 0.15s ease',
            },
          },
            // 第一行：引擎名称、标签、状态、操作按钮组
            React.createElement('div', {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '8px',
              },
            },
              // 左侧：引擎标识 & 属性标签
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                // 引擎超链接 / 纯文本
                b.site
                  ? React.createElement('a', {
                      href: b.site,
                      target: '_blank',
                      rel: 'noopener noreferrer',
                      style: linkStyle,
                      title: b.site,
                    }, b.id, React.createElement('span', { style: { fontSize: '11px', opacity: 0.7 } }, '↗'))
                  : React.createElement('span', { style: { fontWeight: 600, fontSize: '13px' } }, b.id),

                // 引擎类型标签
                React.createElement('span', { style: chipTag() }, b.kind),

                // 自定义后端标签
                b.custom && React.createElement('span', {
                  style: chipTag('rgba(147, 51, 234, 0.12)', '#a855f7'),
                }, t('customTag')),

                // 抓取支持标签
                b.hasFetch && React.createElement('span', {
                  style: chipTag('rgba(59, 130, 246, 0.12)', '#3b82f6'),
                }, 'Fetch 抓取'),

                // 多 Key 计数标签
                b.keyCount > 1 && React.createElement('span', {
                  style: chipTag('rgba(16, 185, 129, 0.12)', '#10b981'),
                }, `${b.keyCount} Keys`),

                // 健康状态药丸
                b.state === 'closed'
                  ? React.createElement('span', { style: badgeStyle('green') }, t('stClosed'))
                  : React.createElement('span', { style: badgeStyle(b.quota ? 'orange' : 'yellow') },
                      (b.quota ? t('stQuota') : t('stOpen')) + (b.cooldownMs ? ` ${fmtCooldown(b.cooldownMs)}` : '')),
              ),

              // 右侧：测试、排序、删除操作栏
              React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                // 轮询权重输入
                strategy === 'rotate' && React.createElement('div', {
                  style: { display: 'inline-flex', alignItems: 'center', gap: '4px', marginRight: '4px' },
                },
                  React.createElement('span', { style: { fontSize: '11px', opacity: 0.6 } }, t('weightLabel') + ':'),
                  React.createElement('input', {
                    style: { ...input, width: '36px', padding: '3px 4px', textAlign: 'center', fontSize: '12px' },
                    type: 'number',
                    min: 1,
                    max: 10,
                    title: t('weightHint'),
                    value: b.weight ?? 1,
                    onChange: (e) => setWeight(b.id, e.target.value),
                  }),
                ),

                // 测试按钮
                React.createElement('button', {
                  style: {
                    ...iconBtn,
                    width: 'auto',
                    padding: '0 8px',
                    height: '26px',
                    gap: '4px',
                    color: testBusy === b.id ? '#3b82f6' : 'inherit',
                    borderColor: testBusy === b.id ? '#3b82f6' : iconBtn.border,
                  },
                  title: t('test'),
                  disabled: busy || testBusy !== null,
                  onClick: () => testBackend(b.id),
                },
                  React.createElement('span', { style: { fontSize: '10px' } }, testBusy === b.id ? '…' : '▶'),
                  React.createElement('span', { style: { fontSize: '11px' } }, t('test')),
                ),

                // 上下移动排序
                React.createElement('button', {
                  style: { ...iconBtn, width: '26px', height: '26px' },
                  title: t('moveUp'),
                  disabled: busy || idx === 0,
                  onClick: () => moveBackend(b.id, -1),
                }, '↑'),
                React.createElement('button', {
                  style: { ...iconBtn, width: '26px', height: '26px' },
                  title: t('moveDown'),
                  disabled: busy || idx === backends.length - 1,
                  onClick: () => moveBackend(b.id, 1),
                }, '↓'),

                // 移除按钮
                React.createElement('button', {
                  style: { ...iconBtn, width: '26px', height: '26px', color: '#e8590c' },
                  title: '移除后端',
                  disabled: busy,
                  onClick: () => removeBackend(b.id),
                }, '✕'),
              ),
            ),

            // 第二行：API Key 输入区域 (支持多行多 Key)
            React.createElement('div', { style: { position: 'relative' } },
              React.createElement('textarea', {
                style: {
                  ...input,
                  padding: '8px 12px',
                  minHeight: '40px',
                  resize: 'vertical',
                  lineHeight: 1.5,
                  fontSize: '12px',
                  fontFamily: 'monospace, sans-serif',
                },
                rows: 1,
                spellCheck: false,
                autoComplete: 'off',
                placeholder: b.hasKey ? `${t('hasKey')} · ${t('placeholder')}` : t('placeholder'),
                value: keys[b.id] ?? '',
                onChange: (e) => setKeys((k) => ({ ...k, [b.id]: e.target.value })),
              }),
            ),

            // 第三行 (可选)：额度与测试结果提示
            (quotaText || testRes) && React.createElement('div', {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '8px',
                fontSize: '11px',
                marginTop: '-4px',
              },
            },
              quotaText && React.createElement('span', { style: { color: '#2f9e44', fontWeight: 500 } }, quotaText),
              testRes && React.createElement('span', {
                style: {
                  color: testRes.ok ? '#2f9e44' : '#e8590c',
                  fontWeight: 500,
                  marginLeft: 'auto',
                },
              },
                testRes.ok
                  ? `✓ ${t('testOk')} (${testRes.sources} 条结果 · ${testRes.ms}ms)`
                  : `✗ ${testRes.error ?? t('quotaError')}`,
              ),
            ),
          )
        }),

        // 空状态与加载中
        state === null && !error && React.createElement('div', {
          style: { opacity: 0.6, padding: '24px 0', textAlign: 'center' },
        }, t('loading')),

        backends.length === 0 && state !== null && React.createElement('div', {
          style: { opacity: 0.6, padding: '24px 0', textAlign: 'center' },
        }, '( 无可用后端引擎，请点击上方添加 )'),
      ),
    ),

    // 卡片 3: 自定义后端表单 (展开时显示)
    showAdd && React.createElement('div', {
      style: {
        ...card,
        borderColor: 'rgba(59, 130, 246, 0.35)',
        background: 'rgba(59, 130, 246, 0.04)',
      },
    },
      React.createElement('h4', { style: { margin: '0 0 6px', fontWeight: 600, fontSize: '13px' } }, t('addTitle')),
      React.createElement('p', { style: { margin: '0 0 12px', opacity: 0.7, fontSize: '12px' } }, t('addDesc')),
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        React.createElement('div', { style: { display: 'flex', gap: '8px' } },
          React.createElement('input', {
            style: { ...input, flex: '1 1 auto' },
            placeholder: t('addName'),
            value: addForm.id,
            onChange: (e) => setAddForm((f) => ({ ...f, id: e.target.value })),
          }),
          React.createElement('select', {
            style: { ...input, flex: '0 0 140px', cursor: 'pointer' },
            value: addForm.kind,
            onChange: (e) => setAddForm((f) => ({ ...f, kind: e.target.value })),
          },
            (state?.kinds ?? ['searxng']).map((k) => React.createElement('option', { key: k, value: k }, k)),
          ),
        ),
        addForm.kind === 'searxng' && React.createElement('input', {
          style: input,
          placeholder: t('addUrl') + ' (例如: http://localhost:8080)',
          value: addForm.baseURL,
          onChange: (e) => setAddForm((f) => ({ ...f, baseURL: e.target.value })),
        }),
        React.createElement('textarea', {
          style: { ...input, minHeight: '40px', resize: 'vertical', fontFamily: 'monospace, sans-serif' },
          rows: 1,
          placeholder: t('addKey'),
          value: addForm.apiKey,
          onChange: (e) => setAddForm((f) => ({ ...f, apiKey: e.target.value })),
        }),
        React.createElement('div', { style: { display: 'flex', gap: '10px', marginTop: '4px' } },
          React.createElement('button', {
            style: { ...buttonPrimary, opacity: busy ? 0.6 : 1 },
            disabled: busy,
            onClick: addBackend,
          }, t('addBtn')),
          React.createElement('button', {
            style: buttonGhost,
            disabled: busy,
            onClick: () => setShowAdd(false),
          }, t('cancel')),
        ),
      ),
    ),

    // 卡片 4: 底部操作栏 & 提示
    React.createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px',
        marginTop: '8px',
        padding: '6px 2px',
      },
    },
      React.createElement('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
        React.createElement('button', {
          style: { ...buttonPrimary, opacity: busy ? 0.6 : 1 },
          disabled: busy,
          onClick: save,
        }, busy ? t('saving') : t('save')),
        React.createElement('button', {
          style: buttonGhost,
          disabled: busy,
          onClick: reset,
        }, busy ? t('resetting') : t('reset')),
        msg && React.createElement('span', {
          style: {
            fontSize: '12px',
            fontWeight: 500,
            color: msgErr ? '#e8590c' : '#2f9e44',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
          },
        }, msg),
      ),
      error && React.createElement('div', { style: { color: '#e8590c', fontSize: '12px', width: '100%' } }, error),
    ),

    // 底部小提示 Tip Box
    React.createElement('div', {
      style: {
        marginTop: '16px',
        padding: '12px 16px',
        borderRadius: '10px',
        background: 'rgba(59, 130, 246, 0.06)',
        border: '1px solid rgba(59, 130, 246, 0.16)',
        fontSize: '12px',
        lineHeight: 1.6,
        opacity: 0.9,
      },
    },
      React.createElement('div', { style: { fontWeight: 600, color: '#3b82f6', marginBottom: '3px', fontSize: '13px' } }, t('tipTitle')),
      React.createElement('div', null, t('tipDesc')),
    ),
  )
}

const name = 'dsh-search-failover'
const inject = ['slots', 'locale']

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, LS), 'search-pool: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'search-pool',
    order: 110,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t }),
  }, () => React.createElement(SearchPoolSection, { t })))
}

exports.name = name
exports.inject = inject
exports.apply = apply
return module.exports
} })
