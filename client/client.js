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
    desc: '填写各搜索后端的 API Key，保存后立即生效（无需重启）。密钥只保存在本机 settings.yaml。',
    keysTitle: '后端密钥',
    backend: '后端',
    key: 'API Key',
    status: '状态',
    hasKey: '已配置',
    noKey: '未配置',
    stClosed: '正常',
    stOpen: '冷却中',
    stQuota: '额度冷却',
    placeholder: '不填则保持现有值',
    save: '保存',
    saving: '保存中…',
    saved: '已保存，立即生效 ✓',
    saveFailed: '保存失败：',
    reset: '恢复默认配置',
    resetting: '恢复中…',
    resetDone: '已恢复默认（行内配置）',
    loading: '加载中…',
    loadFailed: '读取失败：',
    customTag: '自定义',
    addTitle: '添加自定义后端',
    addDesc: '添加任意已支持的后端（含自托管 SearXNG 实例）：填唯一名称并选择类型即可加入搜索池，无需改配置文件。',
    addName: '名称（唯一 id）',
    addUrl: '服务地址 (baseURL)',
    addKey: 'API Key（可选）',
    addBtn: '添加',
    addFailed: '添加失败：',
    removeFailed: '删除失败：',
    cancel: '取消',
    strategyTitle: '使用方式',
    strategyDesc: '优先顺序：按 priority 依次尝试，前一个失败才用下一个。轮询分摊：搜索平均分到健康后端，分散免费额度。',
    failover: '优先顺序',
    rotate: '轮询分摊',
    strategySaved: '策略已保存，立即生效',
    quotaTitle: '额度（实时查询）',
    quotaLoading: '查询中…',
    quotaNoApi: '无公开额度接口',
    quotaError: '查询失败',
    quotaPlan: '套餐',
    quotaUsed: '本 30 天已用',
    quotaLeft: '剩余',
    quotaReset: '重置日',
    refreshQuota: '刷新',
    moveUp: '上移',
    moveDown: '下移',
    weightLabel: '权重',
    weightHint: '轮询模式下按权重分配搜索次数 (1-10)',
  },
  en: {
    nav: 'Search Pool',
    desc: 'Fill in API keys for each search backend and save — effective immediately (no restart). Keys are stored locally in settings.yaml only.',
    keysTitle: 'Backend Keys',
    backend: 'Backend',
    key: 'API Key',
    status: 'Status',
    hasKey: 'configured',
    noKey: 'missing',
    stClosed: 'healthy',
    stOpen: 'cooling down',
    stQuota: 'quota cooldown',
    placeholder: 'leave empty to keep current',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved, effective now ✓',
    saveFailed: 'Save failed: ',
    reset: 'Reset to defaults',
    resetting: 'Resetting…',
    resetDone: 'Reset to inline config',
    loading: 'Loading…',
    loadFailed: 'Load failed: ',
    customTag: 'custom',
    addTitle: 'Add custom backend',
    addDesc: 'Add any supported backend (incl. self-hosted SearXNG): give it a unique name and pick a type to join the pool — no config file edits.',
    addName: 'Name (unique id)',
    addUrl: 'Base URL',
    addKey: 'API Key (optional)',
    addBtn: 'Add',
    addFailed: 'Add failed: ',
    removeFailed: 'Remove failed: ',
    cancel: 'Cancel',
    strategyTitle: 'Strategy',
    strategyDesc: 'Failover tries backends by priority; rotate round-robins searches across healthy backends to spread free quotas.',
    failover: 'Failover',
    rotate: 'Rotate',
    strategySaved: 'Strategy saved, effective now',
    quotaTitle: 'Quota (live)',
    quotaLoading: 'Checking…',
    quotaNoApi: 'no quota API',
    quotaError: 'query failed',
    quotaPlan: 'Plan',
    quotaUsed: 'Used (30d)',
    quotaLeft: 'Left',
    quotaReset: 'Resets',
    refreshQuota: 'Refresh',
    moveUp: 'Move up',
    moveDown: 'Move down',
    weightLabel: 'Weight',
    weightHint: 'In rotate mode searches are distributed by weight (1-10).',
  },
}

const row = { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid rgba(128,128,128,0.18)' }
const cell = { flex: '1 1 auto', minWidth: 0 }
const badge = (color) => ({
  display: 'inline-block', padding: '1px 8px', borderRadius: '10px',
  fontSize: '12px', color: '#fff', background: color,
})
const link = {
  color: 'inherit', textDecoration: 'underline', textUnderlineOffset: '3px',
  cursor: 'pointer', display: 'inline-block',
}
const linkMuted = { color: 'inherit', textDecoration: 'none', cursor: 'default', display: 'inline-block' }
const input = {
  width: '100%', boxSizing: 'border-box', padding: '6px 10px',
  borderRadius: '6px', border: '1px solid rgba(128,128,128,0.35)',
  background: 'rgba(0,0,0,0.15)', color: 'inherit', fontFamily: 'inherit', fontSize: '13px',
}
const button = {
  padding: '8px 18px', borderRadius: '8px', border: '0', cursor: 'pointer',
  background: 'rgba(0,122,255,0.9)', color: '#fff', fontSize: '13px', fontWeight: 600,
}
const buttonGhost = { ...button, background: 'transparent', border: '1px solid rgba(128,128,128,0.4)', color: 'inherit', fontWeight: 400 }

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
    const ok = await post(
      { adds: [add] },
      t('saved'),
    )
    if (ok !== false) { setShowAdd(false); setAddForm({ id: '', kind: 'searxng', baseURL: '', apiKey: '' }) }
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
    React.createElement('p', { style: { color: 'inherit', opacity: 0.75, margin: '0 0 14px' } }, t('desc')),
    React.createElement('h4', { style: { margin: '12px 0 6px', fontWeight: 600 } }, t('strategyTitle')),
    React.createElement('p', { style: { margin: '0 0 8px', opacity: 0.7 } }, t('strategyDesc')),
    React.createElement('div', { style: { display: 'flex', gap: '8px', marginBottom: '16px' } },
      ['failover', 'rotate'].map((s) => React.createElement('button', {
        key: s,
        style: s === strategy
          ? { ...button, opacity: busy ? 0.6 : 1 }
          : buttonGhost,
        disabled: busy,
        onClick: () => saveStrategy(s),
      }, t(s === 'failover' ? 'failover' : 'rotate'))),
    ),
    React.createElement('h4', { style: { margin: '12px 0 6px', fontWeight: 600 } }, t('keysTitle')),
    strategy === 'rotate' && React.createElement('button', { style: buttonGhost, disabled: busy, onClick: load }, t('refreshQuota')),
    React.createElement('div', null,
      backends.map((b, bi) => {
        const idx = backends.indexOf(b)
        const q = quota?.quota?.[b.id]
        let quotaText = null
        if (q && !q.error) quotaText = q.plan + ' · ' + t('quotaLeft') + ' '
          + q.remaining + '/' + q.limit + (q.resetAt ? ' · ' + q.resetAt.slice(0, 10) : '')
        else if (q && q.error) quotaText = t('quotaError')
        const iconBtn = {
          border: '0', background: 'transparent', color: 'inherit', cursor: 'pointer',
          fontSize: '13px', opacity: 0.7, padding: '2px 4px', borderRadius: '6px',
        }
        return React.createElement('div', { key: b.id, style: row },
          React.createElement('div', { style: { ...cell, flex: '0 0 150px' } },
            b.site
              ? React.createElement('a', {
                  href: b.site,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  style: link,
                  title: b.site,
                }, b.id)
              : React.createElement('span', { style: { ...linkMuted, fontWeight: 600 } }, b.id),
            b.custom && React.createElement('span', {
              style: { display: 'inline-block', marginLeft: '6px', padding: '0 6px', borderRadius: '8px', background: 'rgba(127,127,127,0.25)', fontSize: '11px', verticalAlign: 'middle' },
            }, t('customTag')),
            React.createElement('div', { style: { opacity: 0.6, fontSize: '12px' } }, b.kind),
            quotaText && React.createElement('div', { style: { fontSize: '11px', color: '#2f9e44', marginTop: '2px' } }, quotaText),
          ),
          React.createElement('div', { style: cell },
            React.createElement('input', {
              style: input,
              type: 'password',
              placeholder: b.hasKey ? t('hasKey') + ' · ' + t('placeholder') : t('placeholder'),
              value: keys[b.id] ?? '',
              onChange: (e) => setKeys((k) => ({ ...k, [b.id]: e.target.value })),
            }),
          ),
          React.createElement('div', { style: { flex: '0 0 120px', textAlign: 'center', fontSize: '12px' } },
            b.state === 'closed'
              ? React.createElement('span', { style: badge('#2f9e44') }, t('stClosed'))
              : React.createElement('span', { style: badge(b.quota ? '#e8590c' : '#f08c00') },
                  (b.quota ? t('stQuota') : t('stOpen')) + (b.cooldownMs ? ' ' + fmtCooldown(b.cooldownMs) : '')),
          ),
          React.createElement('div', { style: { flex: '0 0 56px', textAlign: 'center', fontSize: '12px' } },
            b.hasKey
              ? React.createElement('span', { style: { color: '#2f9e44' } }, t('hasKey'))
              : React.createElement('span', { style: { color: '#e8590c' } }, t('noKey')),
          ),
          strategy === 'rotate' && React.createElement('div', { style: { flex: '0 0 52px', textAlign: 'center' } },
            React.createElement('input', {
              style: { ...input, width: '44px', padding: '4px', textAlign: 'center' },
              type: 'number', min: 1, max: 10,
              title: t('weightHint'),
              value: b.weight ?? 1,
              onChange: (e) => setWeight(b.id, e.target.value),
            }),
          ),
          React.createElement('div', { style: { flex: '0 0 52px', textAlign: 'center' } },
            React.createElement('button', { style: iconBtn, title: t('moveUp'), disabled: busy || idx === 0, onClick: () => moveBackend(b.id, -1) }, '↑'),
            React.createElement('button', { style: iconBtn, title: t('moveDown'), disabled: busy || idx === backends.length - 1, onClick: () => moveBackend(b.id, 1) }, '↓'),
          ),
          React.createElement('div', { style: { flex: '0 0 32px', textAlign: 'center' } },
            React.createElement('button', {
              style: iconBtn,
              title: 'remove',
              disabled: busy,
              onClick: () => removeBackend(b.id),
            }, '✕'),
          ),
        )
      }),
      state === null && !error && React.createElement('div', { style: { opacity: 0.6 } }, t('loading')),
      backends.length === 0 && state !== null && React.createElement('div', { style: { opacity: 0.6 } }, '( )'),
    ),
    React.createElement('button', {
      style: { ...buttonGhost, marginTop: '10px' },
      disabled: busy,
      onClick: () => setShowAdd((v) => !v),
    }, showAdd ? t('cancel') + ' · ' + t('addTitle') : t('addTitle')),
    showAdd && React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px', border: '1px solid rgba(128,128,128,0.25)', borderRadius: '8px', padding: '12px' } },
      React.createElement('p', { style: { margin: '0', opacity: 0.75 } }, t('addDesc')),
      React.createElement('div', { style: { display: 'flex', gap: '8px' } },
        React.createElement('input', {
          style: { ...input, flex: '1 1 auto' },
          placeholder: t('addName'),
          value: addForm.id,
          onChange: (e) => setAddForm((f) => ({ ...f, id: e.target.value })),
        }),
        React.createElement('select', {
          style: { ...input, flex: '0 0 130px' },
          value: addForm.kind,
          onChange: (e) => setAddForm((f) => ({ ...f, kind: e.target.value })),
        },
          (state?.kinds ?? ['searxng']).map((k) => React.createElement('option', { key: k, value: k }, k)),
        ),
      ),
      addForm.kind === 'searxng' && React.createElement('input', {
        style: input,
        placeholder: t('addUrl'),
        value: addForm.baseURL,
        onChange: (e) => setAddForm((f) => ({ ...f, baseURL: e.target.value })),
      }),
      React.createElement('input', {
        style: input,
        type: 'password',
        placeholder: t('addKey'),
        value: addForm.apiKey,
        onChange: (e) => setAddForm((f) => ({ ...f, apiKey: e.target.value })),
      }),
      React.createElement('div', { style: { display: 'flex', gap: '10px' } },
        React.createElement('button', { style: { ...button, opacity: busy ? 0.6 : 1 }, disabled: busy, onClick: addBackend }, t('addBtn')),
        React.createElement('button', { style: buttonGhost, disabled: busy, onClick: () => setShowAdd(false) }, t('cancel')),
      ),
    ),
    React.createElement('div', { style: { display: 'flex', gap: '10px', marginTop: '14px', alignItems: 'center' } },
      React.createElement('button', {
        style: { ...button, opacity: busy ? 0.6 : 1 },
        disabled: busy,
        onClick: save,
      }, busy ? t('saving') : t('save')),
      React.createElement('button', { style: buttonGhost, disabled: busy, onClick: reset },
        busy ? t('resetting') : t('reset')),
      React.createElement('span', { style: { fontSize: '12px', color: msgErr ? '#e8590c' : '#2f9e44' } }, msg),
    ),
    error && React.createElement('div', { style: { color: '#e8590c', fontSize: '12px', marginTop: '8px' } }, error),
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
