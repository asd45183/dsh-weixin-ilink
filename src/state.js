/**
 * State location for dsh-weixin-ilink.
 *
 * Layout under ~/.dsh/weixin-own/:
 *   accounts/<accountId>.json            — credential (token, baseUrl, userId), 0600
 *   accounts/accounts.json               — index of registered account ids
 *   accounts/<accountId>.sync.json       — getUpdates long-poll cursor
 *   accounts/<accountId>.context-tokens.json — per-peer context_token cache
 *
 * Ported from a clean first-party Python adapter: atomic write (tmp+rename),
 * 0600 on every state file; the credential file is the sensitive one.
 * @module dsh-weixin-ilink/state
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ponytail: env override for tests and non-default profiles; default is the
// DSH-owned tree so credentials never land in a directory another OpenClaw
// install writes. Re-read each call so a test (or a profile switch) can set
// DSH_WEIXIN_OWN_STATE_DIR after this module is imported. Upgrade: honor a
// per-profile path passed through config.
export function stateDir() {
  const override = process.env.DSH_WEIXIN_OWN_STATE_DIR?.trim()
  return override || path.join(os.homedir(), '.dsh', 'weixin-own')
}

function accountDir() {
  const dir = path.join(stateDir(), 'accounts')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Account ids become filenames; reject path separators and dot-only names. */
const ACCOUNT_ID_RE = /^[A-Za-z0-9@._-]+$/

export function isSafeAccountId(accountId) {
  const value = String(accountId ?? '').trim()
  return value !== '.' && value !== '..' && ACCOUNT_ID_RE.test(value)
}

function requireAccountId(accountId) {
  const value = String(accountId ?? '').trim()
  if (!isSafeAccountId(value)) throw new Error('invalid Weixin account id')
  return value
}

function readJson(file) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null
  } catch {
    return null
  }
}

/** Write atomically: tmp file + rename, so a crash mid-write cannot leave a partial credential. */
function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function saveAccount(accountId, { token, baseUrl, userId = '' }) {
  const id = requireAccountId(accountId)
  const file = path.join(accountDir(), `${id}.json`)
  atomicWrite(file, { token, baseUrl, userId, savedAt: new Date().toISOString() })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // best-effort: the credential is still on disk; a non-600 file is a degraded state, not a failure
  }
}

export function loadAccount(accountId) {
  if (!isSafeAccountId(accountId)) return null
  return readJson(path.join(accountDir(), `${String(accountId).trim()}.json`))
}

export function listAccountIds() {
  const data = readJson(path.join(accountDir(), 'accounts.json'))
  return Array.isArray(data) ? data.filter((id) => typeof id === 'string' && isSafeAccountId(id)).map((id) => id.trim()) : []
}

export function registerAccountId(accountId) {
  const id = requireAccountId(accountId)
  const ids = listAccountIds()
  if (ids.includes(id)) return
  atomicWrite(path.join(accountDir(), 'accounts.json'), [...ids, id])
}

export function unregisterAccountId(accountId) {
  const id = String(accountId ?? '').trim()
  const ids = listAccountIds().filter((item) => item !== id)
  atomicWrite(path.join(accountDir(), 'accounts.json'), ids)
}

export function clearAccount(accountId) {
  if (!isSafeAccountId(accountId)) return
  const id = String(accountId).trim()
  const dir = accountDir()
  for (const f of [`${id}.json`, `${id}.sync.json`, `${id}.context-tokens.json`]) {
    try {
      fs.unlinkSync(path.join(dir, f))
    } catch {
      // ignore missing
    }
  }
  unregisterAccountId(accountId)
}

export function loadSyncBuf(accountId) {
  if (!isSafeAccountId(accountId)) return ''
  const data = readJson(path.join(accountDir(), `${String(accountId).trim()}.sync.json`))
  return data && typeof data.get_updates_buf === 'string' ? data.get_updates_buf : ''
}

export function saveSyncBuf(accountId, syncBuf) {
  const id = requireAccountId(accountId)
  atomicWrite(path.join(accountDir(), `${id}.sync.json`), { get_updates_buf: syncBuf })
}

/** Working directory Weixin conversations run in (one group in the GUI, separate from the deployment's cwd). */
export function sessionsDir() {
  return path.join(stateDir(), 'sessions')
}

export function ensureSessionsDir() {
  const dir = sessionsDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Per-message directory for decrypted inbound media, under
 * `~/.dsh/weixin-own/media/`. Segments are sanitized so a peer id can never
 * escape the media root.
 */
export function ensureMediaDir(...segments) {
  const safe = segments.map((segment) => String(segment ?? '').replace(/[^A-Za-z0-9@._-]/g, '_').slice(0, 60) || '_')
  const dir = path.join(stateDir(), 'media', ...safe)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function contextTokenFile(accountId) {
  return path.join(accountDir(), `${requireAccountId(accountId)}.context-tokens.json`)
}

/** Latest context_token for one conversation (iLink requires a reply to echo it). */
export function loadContextToken(accountId, conversationId) {
  const map = readJson(contextTokenFile(accountId))
  const value = map && typeof map === 'object' ? map[conversationId] : undefined
  return typeof value === 'string' ? value : ''
}

export function saveContextToken(accountId, conversationId, token) {
  if (!token) return
  const file = contextTokenFile(accountId)
  const map = readJson(file)
  const next = map && typeof map === 'object' && !Array.isArray(map) ? map : {}
  next[conversationId] = token
  atomicWrite(file, next)
}

// ── conversation bookkeeping (persona/life/proactive) ───────────────────────

function conversationFile() {
  return path.join(stateDir(), 'conversations.json')
}

/** Per-conversation activity, keyed by `accountId\0conversationId`. */
function conversationKey(accountId, conversationId) {
  return `${accountId ?? ''}\u0000${conversationId ?? ''}`
}

function readConversations() {
  const raw = readJson(conversationFile())
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

/**
 * Record one inbound message and return the conversation's bond facts.
 * `msgsToday` resets on the local calendar day.
 * @param {string} accountId
 * @param {string} conversationId
 * @param {number} [now]
 */
export function recordConversationInbound(accountId, conversationId, now = Date.now(), isGroup = false) {
  const all = readConversations()
  const key = conversationKey(accountId, conversationId)
  const day = new Date(now).toISOString().slice(0, 10)
  const prior = all[key] && typeof all[key] === 'object' ? all[key] : {}
  const sameDay = prior.day === day
  const next = {
    accountId: String(accountId ?? ''),
    conversationId: String(conversationId ?? ''),
    day,
    msgsToday: (sameDay ? Number(prior.msgsToday) || 0 : 0) + 1,
    lastInboundAt: now,
    lastMessageAt: now,
    isGroup: isGroup === true,
  }
  all[key] = next
  atomicWrite(conversationFile(), all)
  return { lastMessageAt: next.lastMessageAt, msgsToday: next.msgsToday }
}

/** All conversations seen so far, with persisted activity. */
export function listConversations() {
  return Object.values(readConversations())
    .filter((row) => row && typeof row === 'object' && typeof row.conversationId === 'string')
    .map((row) => ({
      accountId: String(row.accountId ?? ''),
      conversationId: row.conversationId,
      lastInboundAt: Number(row.lastInboundAt) || 0,
      lastMessageAt: Number(row.lastMessageAt) || 0,
      msgsToday: Number(row.msgsToday) || 0,
      // Old records predate the flag; WeChat room ids are a safe fallback.
      isGroup: row.isGroup === true || /@(?:im\.)?chatroom$/i.test(row.conversationId),
    }))
}

/** The active session line for one conversation; 0 is the historical session. */
export function activeLine(accountId, conversationId) {
  const raw = readJson(path.join(stateDir(), 'session-lines.json'))
  const key = conversationKey(accountId, conversationId)
  const value = raw && typeof raw === 'object' ? Number(raw[key]) : 0
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/** Advance to a fresh line (used by /clear). Returns the new line number. */
export function advanceLine(accountId, conversationId) {
  const file = path.join(stateDir(), 'session-lines.json')
  const raw = readJson(file)
  const all = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const key = conversationKey(accountId, conversationId)
  const current = activeLine(accountId, conversationId)
  const next = current + 1
  all[key] = next
  atomicWrite(file, all)
  return next
}

/** Runtime /proactive override; undefined means "use the plugin config". */
export function loadProactivePreference() {
  const raw = readJson(path.join(stateDir(), 'proactive.json'))
  return raw && typeof raw === 'object' && typeof raw.enabled === 'boolean' ? raw.enabled : undefined
}

export function saveProactivePreference(enabled) {
  atomicWrite(path.join(stateDir(), 'proactive.json'), { enabled: Boolean(enabled) })
}
