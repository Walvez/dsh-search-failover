/**
 * 额度感知熔断器 — 模式借鉴 dsh-model-failover, 面向搜索后端简化:
 *  - QUOTA 失败 → 直接长冷却(默认 1h), 额度类错误一次就够
 *  - TRANSIENT 失败 → 突发窗口(默认 5min)内达到阈值(默认 3)才开断, 短冷却(默认 60s)
 *  - 冷却到期自动半开: 下一次请求放行即探活, 成功即闭合
 */
export class CircuitBreaker {
  constructor(options = {}) {
    this.threshold = options.threshold ?? 3
    this.burstWindowMs = options.burstWindowMs ?? 300_000
    this.cooldownMs = options.cooldownMs ?? 60_000
    this.quotaCooldownMs = options.quotaCooldownMs ?? 3_600_000
    this.state = new Map()
  }

  _entry(id) {
    let e = this.state.get(id)
    if (!e) { e = { failures: [], openUntil: 0, quota: false }; this.state.set(id, e) }
    return e
  }

  /** 冷却未到期 → 开断; 到期 → 半开放行并复位 */
  isOpen(id) {
    const e = this._entry(id)
    if (e.openUntil === 0) return false
    if (Date.now() >= e.openUntil) { e.openUntil = 0; return false }
    return true
  }

  recordSuccess(id) {
    const e = this._entry(id)
    e.failures = []
    e.openUntil = 0
    e.quota = false
  }

  recordFailure(id, kind) {
    const e = this._entry(id)
    const now = Date.now()
    if (kind === 'quota') {
      e.failures = []
      e.quota = true
      e.openUntil = now + this.quotaCooldownMs
      return
    }
    e.failures = e.failures.filter((t) => now - t < this.burstWindowMs)
    e.failures.push(now)
    if (e.failures.length >= this.threshold) e.openUntil = now + this.cooldownMs
  }

  stats(id) {
    const e = this._entry(id)
    const now = Date.now()
    const opening = e.openUntil > now
    return {
      open: opening,
      failures: e.failures.length,
      quota: e.quota,
      cooldownRemainingMs: opening ? e.openUntil - now : 0,
    }
  }
}
