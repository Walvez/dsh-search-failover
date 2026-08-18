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

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch('/search-pool/state', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setState(await res.json())
    } catch (e) {
      setError(t('loadFailed') + String(e.message || e))
    }
  }, [t])

  useEffect(() => { load() }, [load])

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

  const backends = state?.backends ?? []
  return React.createElement('div', { style: { padding: '4px 2px', fontSize: '13px', lineHeight: 1.6 } },
    React.createElement('p', { style: { color: 'inherit', opacity: 0.75, margin: '0 0 14px' } }, t('desc')),
    React.createElement('h4', { style: { margin: '12px 0 6px', fontWeight: 600 } }, t('keysTitle')),
    React.createElement('div', null,
      backends.map((b) => React.createElement('div', { key: b.id, style: row },
        React.createElement('div', { style: { ...cell, flex: '0 0 120px' } },
          b.site
            ? React.createElement('a', {
                href: b.site,
                target: '_blank',
                rel: 'noopener noreferrer',
                style: link,
                title: b.site,
              }, b.id)
            : React.createElement('span', { style: { ...linkMuted, fontWeight: 600 } }, b.id),
          React.createElement('div', { style: { opacity: 0.6, fontSize: '12px' } }, b.kind),
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
        React.createElement('div', { style: { flex: '0 0 130px', textAlign: 'center', fontSize: '12px' } },
          b.state === 'closed'
            ? React.createElement('span', { style: badge('#2f9e44') }, t('stClosed'))
            : React.createElement('span', { style: badge(b.quota ? '#e8590c' : '#f08c00') },
                (b.quota ? t('stQuota') : t('stOpen')) + (b.cooldownMs ? ' ' + fmtCooldown(b.cooldownMs) : '')),
        ),
        React.createElement('div', { style: { flex: '0 0 64px', textAlign: 'center', fontSize: '12px' } },
          b.hasKey
            ? React.createElement('span', { style: { color: '#2f9e44' } }, t('hasKey'))
            : React.createElement('span', { style: { color: '#e8590c' } }, t('noKey')),
        ),
      )),
      state === null && !error && React.createElement('div', { style: { opacity: 0.6 } }, t('loading')),
      backends.length === 0 && state !== null && React.createElement('div', { style: { opacity: 0.6 } }, '( )'),
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
