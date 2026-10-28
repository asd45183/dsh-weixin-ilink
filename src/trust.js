/**
 * Temporary per-conversation approval grants for WeChat.
 *
 * DSH's approval policy is only `ask` or `never`; `never` rejects, it does not
 * grant. A timed grant therefore lives in the WeChat answerer: while active,
 * approval requests for the exact account/conversation/line resolve
 * `allowed-once` without prompting. The grant is in-memory only and expires.
 * @module dsh-weixin-ilink/trust
 */

export const MAX_TRUST_MS = 8 * 60 * 60_000
export const DEFAULT_TRUST_MS = 10 * 60_000

/**
 * Parse `/trust` duration forms: `10m`, `1h`, `30` (minutes), `30分钟`.
 * @param {string} raw
 * @param {number} [maxMs]
 * @returns {{ok:true,ms:number}|{ok:false,reason:string}}
 */
export function parseTrustDuration(raw, maxMs = MAX_TRUST_MS) {
  const text = String(raw ?? '').trim().toLowerCase()
  const match = /^(\d+)\s*(m|min|分钟|h|小时)?$/.exec(text)
  if (match === null) {
    return { ok: false, reason: '格式：/trust 10m、/trust 1h、/trust 30（分钟）或 /trust off' }
  }
  const amount = Number(match[1])
  const unit = match[2] ?? 'm'
  const minutes = unit === 'h' || unit === '小时' ? amount * 60 : amount
  const ms = minutes * 60_000
  if (!Number.isSafeInteger(ms) || ms <= 0) return { ok: false, reason: '时长必须大于 0' }
  if (ms > maxMs) {
    return { ok: false, reason: `最长 ${Math.round(maxMs / 60_000)} 分钟` }
  }
  return { ok: true, ms }
}

/** In-memory grants keyed by `account\\0conversation\\0line`. */
export class TrustStore {
  #expires = new Map()

  /** @returns {number} absolute expiry timestamp */
  grant(key, ms, now = Date.now()) {
    const expiresAt = now + Math.max(1, Number(ms) || 0)
    this.#expires.set(String(key), expiresAt)
    return expiresAt
  }

  revoke(key) {
    this.#expires.delete(String(key))
  }

  /** @returns {boolean} whether the grant is still active (expired grants are removed) */
  active(key, now = Date.now()) {
    const id = String(key)
    const expiresAt = this.#expires.get(id)
    if (expiresAt === undefined) return false
    if (expiresAt <= now) {
      this.#expires.delete(id)
      return false
    }
    return true
  }

  /** @returns {number} remaining milliseconds, or 0 */
  remainingMs(key, now = Date.now()) {
    const id = String(key)
    const expiresAt = this.#expires.get(id)
    if (expiresAt === undefined) return 0
    const left = expiresAt - now
    if (left <= 0) {
      this.#expires.delete(id)
      return 0
    }
    return left
  }
}
