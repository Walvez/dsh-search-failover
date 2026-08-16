/**
 * dsh-search-failover — 错误类型与分类
 * kind: 'quota' | 'transient' | 'auth' | 'abort'
 *  - quota     → 额度耗尽(429/insufficient), 长冷却, 不值得重试
 *  - transient → 5xx/超时/网络, 短冷却后重试
 *  - auth      → key 无效, 终态
 *  - abort     → 调用方取消, 立即终止不再尝试下一个后端
 */
export class SearchPoolError extends Error {
  constructor(message, kind = 'transient', code = 'WEB_PROVIDER_ERROR') {
    super(message)
    this.name = 'SearchPoolError'
    this.kind = kind
    this.code = code
  }
}

export function classifyHttpStatus(status) {
  if (status === 429) return 'quota'
  if (status === 401 || status === 403) return 'auth'
  return 'transient'
}
