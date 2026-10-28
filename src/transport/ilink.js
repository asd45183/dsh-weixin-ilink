/**
 * iLink Bot API transport — ported from a clean first-party Python adapter
 * (hermes weixin.py) to ESM JS. Same protocol, same endpoints, same random
 * X-WECHAT-UIN (NOT the real WeChat UIN), same AES key handling, same session
 * semantics.
 *
 * Text + media: getUpdates / sendMessage / getUploadUrl / getConfig / sendTyping
 * and QR login, plus AES-128-ECB CDN media (see ./media.js for the crypto and
 * the SSRF allowlist). normalizeInbound returns media references so the caller
 * can download + decrypt them.
 *
 * Network egress (the complete list):
 *   https://ilinkai.weixin.qq.com       — API (login QR, long-poll, send, config, typing)
 *   https://novac2c.cdn.weixin.qq.com/c2c — media CDN
 * Nothing else. No telemetry, no analytics, no third-party endpoints.
 * @module dsh-weixin-ilink/transport/ilink
 */
import crypto from 'node:crypto'

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

// ponytail: hermes ships ILINK_APP_ID='bot', CHANNEL_VERSION='2.2.0'. Keep the
// app id; swap CHANNEL_VERSION to read from this package.json once published.
// Upgrade path: import pkg from '../../package.json' with { assert: { type: 'json' } }.
export const ILINK_APP_ID = 'bot'
export const CHANNEL_VERSION = '0.1.0'
export const ILINK_APP_CLIENT_VERSION = (1 << 16) | (0 << 8) | 0

export const EP = {
  GET_UPDATES: 'ilink/bot/getupdates',
  SEND_MESSAGE: 'ilink/bot/sendmessage',
  SEND_TYPING: 'ilink/bot/sendtyping',
  GET_CONFIG: 'ilink/bot/getconfig',
  GET_UPLOAD_URL: 'ilink/bot/getuploadurl', // media milestone
  GET_BOT_QR: 'ilink/bot/get_bot_qrcode',
  GET_QR_STATUS: 'ilink/bot/get_qrcode_status',
}

export const LONG_POLL_TIMEOUT_MS = 35_000
export const API_TIMEOUT_MS = 15_000
export const CONFIG_TIMEOUT_MS = 10_000
export const QR_TIMEOUT_MS = 35_000
export const MAX_CONSECUTIVE_FAILURES = 3
export const RETRY_DELAY_MS = 2_000
export const BACKOFF_DELAY_MS = 30_000
export const SESSION_EXPIRED_ERRCODE = -14
export const RATE_LIMIT_ERRCODE = -2

// iLink item_list entry types. Text milestone uses TEXT only; the rest are for
// the media milestone and document the wire shapes here so they cannot drift.
export const ITEM_TEXT = 1
export const ITEM_IMAGE = 2
export const ITEM_VOICE = 3
export const ITEM_FILE = 4
export const ITEM_VIDEO = 5
export const MSG_TYPE_BOT = 2
export const MSG_STATE_FINISH = 2
export const TYPING_START = 1
export const TYPING_STOP = 2

const STALE_SESSION_MSGS = new Set(['unknown error', 'prepare failed'])

/** Random per-request X-WECHAT-UIN — a random uint32, base64. NOT the real WeChat UIN. */
function randomWechatUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64')
}

function buildHeaders(token, body) {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body ?? '', 'utf-8')),
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function buildCommonHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
}

/**
 * Combine an internal timeout AbortController with an optional external signal
 * (e.g. plugin stop), so stop() cancels an in-flight long-poll immediately.
 * Ported from hermes combineAbortSignals.
 */
function combineSignals(internal, external) {
  if (!external) return { signal: internal?.signal, cleanup: () => {} }
  if (!internal) return { signal: external, cleanup: () => {} }
  if (external.aborted) {
    internal.abort()
    return { signal: internal.signal, cleanup: () => {} }
  }
  const onAbort = () => internal.abort()
  external.addEventListener('abort', onAbort, { once: true })
  return {
    signal: internal.signal,
    cleanup: () => external.removeEventListener('abort', onAbort),
  }
}

function apiUrl(baseUrl, endpoint) {
  return `${baseUrl.replace(/\/+$/, '')}/${endpoint}`
}

/**
 * POST JSON to an iLink endpoint, bounded by an AbortController timeout.
 * @throws {Error} on non-2xx (with a 200-char body snippet) or timeout/abort.
 */
export async function apiPost({ baseUrl, endpoint, payload, token, timeoutMs, label, abortSignal }) {
  const body = JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const { signal, cleanup } = combineSignals(controller, abortSignal)
  try {
    const res = await fetch(apiUrl(baseUrl, endpoint), {
      method: 'POST',
      headers: buildHeaders(token, body),
      body,
      ...(signal ? { signal } : {}),
    })
    const raw = await res.text()
    if (!res.ok) throw new Error(`${label ?? endpoint} HTTP ${res.status}: ${raw.slice(0, 200)}`)
    return JSON.parse(raw)
  } finally {
    clearTimeout(timer)
    cleanup()
  }
}

/** GET (tokenless; QR endpoints carry no Authorization). */
export async function apiGet({ baseUrl, endpoint, timeoutMs, label, abortSignal }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const { signal, cleanup } = combineSignals(controller, abortSignal)
  try {
    const res = await fetch(apiUrl(baseUrl, endpoint), {
      method: 'GET',
      headers: buildCommonHeaders(),
      ...(signal ? { signal } : {}),
    })
    const raw = await res.text()
    if (!res.ok) throw new Error(`${label ?? endpoint} HTTP ${res.status}: ${raw.slice(0, 200)}`)
    return JSON.parse(raw)
  } finally {
    clearTimeout(timer)
    cleanup()
  }
}

/**
 * Long-poll getUpdates. A client-side timeout (or external abort) is a normal
 * long-poll exit and returns an empty {ret:0} so the caller simply retries.
 */
export async function getUpdates({ baseUrl, token, syncBuf, timeoutMs = LONG_POLL_TIMEOUT_MS, abortSignal }) {
  try {
    return await apiPost({
      baseUrl,
      endpoint: EP.GET_UPDATES,
      token,
      timeoutMs,
      label: 'getUpdates',
      abortSignal,
      payload: { get_updates_buf: syncBuf ?? '' },
    })
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: syncBuf }
    }
    throw err
  }
}

/** Send one text reply. The caller chunks and echoes context_token. */
export async function sendMessage({ baseUrl, token, to, text, contextToken, clientId, timeoutMs = API_TIMEOUT_MS, abortSignal }) {
  if (!text || !text.trim()) throw new Error('sendMessage: text must not be empty')
  const message = {
    from_user_id: '',
    to_user_id: to,
    client_id: clientId,
    message_type: MSG_TYPE_BOT,
    message_state: MSG_STATE_FINISH,
    item_list: [{ type: ITEM_TEXT, text_item: { text } }],
  }
  if (contextToken) message.context_token = contextToken
  return apiPost({
    baseUrl,
    endpoint: EP.SEND_MESSAGE,
    token,
    timeoutMs,
    label: 'sendMessage',
    abortSignal,
    payload: { msg: message },
  })
}

/**
 * Ask the CDN for an upload slot. iLink answers with `upload_param` (build the
 * CDN URL yourself) and/or a pre-signed `upload_full_url` (post there directly).
 */
export async function getUploadUrl({ baseUrl, token, toUserId, mediaType, filekey, rawsize, rawfilemd5, filesize, aeskeyHex, timeoutMs = API_TIMEOUT_MS, abortSignal }) {
  return apiPost({
    baseUrl,
    endpoint: EP.GET_UPLOAD_URL,
    token,
    timeoutMs,
    label: 'getUploadUrl',
    abortSignal,
    payload: {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskeyHex,
    },
  })
}

/** Send one already-built media item (image or file) to a peer. */
export async function sendItemMessage({ baseUrl, token, to, item, contextToken, clientId, timeoutMs = API_TIMEOUT_MS, abortSignal }) {
  if (!item || typeof item !== 'object') throw new Error('sendItemMessage: item is required')
  const message = {
    from_user_id: '',
    to_user_id: to,
    client_id: clientId,
    message_type: MSG_TYPE_BOT,
    message_state: MSG_STATE_FINISH,
    item_list: [item],
  }
  if (contextToken) message.context_token = contextToken
  return apiPost({
    baseUrl,
    endpoint: EP.SEND_MESSAGE,
    token,
    timeoutMs,
    label: 'sendItemMessage',
    abortSignal,
    payload: { msg: message },
  })
}

/** Fetch bot config (typing_ticket) for a peer. */
export async function getConfig({ baseUrl, token, userId, contextToken, timeoutMs = CONFIG_TIMEOUT_MS }) {
  const payload = { ilink_user_id: userId }
  if (contextToken) payload.context_token = contextToken
  return apiPost({ baseUrl, endpoint: EP.GET_CONFIG, token, timeoutMs, label: 'getConfig', payload })
}

/** Set/clear the typing indicator (cosmetic; never fail a turn over it). */
export async function sendTyping({ baseUrl, token, userId, typingTicket, status, timeoutMs = CONFIG_TIMEOUT_MS }) {
  return apiPost({
    baseUrl,
    endpoint: EP.SEND_TYPING,
    token,
    timeoutMs,
    label: 'sendTyping',
    payload: { ilink_user_id: userId, typing_ticket: typingTicket, status },
  })
}

/** Fetch a login QR (tokenless GET). Returns {qrcode, qrcode_img_content}. */
export async function fetchQrCode({ botType = '3', timeoutMs = QR_TIMEOUT_MS } = {}) {
  return apiGet({
    baseUrl: ILINK_BASE_URL,
    endpoint: `${EP.GET_BOT_QR}?bot_type=${encodeURIComponent(botType)}`,
    timeoutMs,
    label: 'fetchQRCode',
  })
}

/** One QR-status poll step (server long-polls ~30s). Network hiccups return {status:'wait'}. */
export async function pollQrStatus({ baseUrl = ILINK_BASE_URL, qrcode, verifyCode, timeoutMs = QR_TIMEOUT_MS } = {}) {
  const qs = `?qrcode=${encodeURIComponent(qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ''}`
  try {
    return await apiGet({ baseUrl, endpoint: `${EP.GET_QR_STATUS}${qs}`, timeoutMs, label: 'pollQRStatus' })
  } catch {
    return { status: 'wait' }
  }
}

/**
 * Recognize the stale-session variant of iLink's `-2` (not a real rate limit):
 * a `-2` with `unknown error` / `prepare failed` means the session is not ready,
 * not that the bot is being rate-limited.
 */
export function isStaleSessionRet(ret, errcode, errmsg) {
  return (ret === RATE_LIMIT_ERRCODE || errcode === RATE_LIMIT_ERRCODE)
    && STALE_SESSION_MSGS.has((errmsg ?? '').toLowerCase())
}

/** Session expired: errcode -14, or the stale-session `-2` variant. */
export function isSessionExpired(resp, ret, errcode) {
  return ret === SESSION_EXPIRED_ERRCODE
    || errcode === SESSION_EXPIRED_ERRCODE
    || isStaleSessionRet(ret, errcode, resp?.errmsg ?? resp?.msg ?? '')
}

/**
 * Pull one media reference out of an item entry, or null for text/unknown.
 * Shapes are documented (and kept in sync) with the media module:
 *   IMAGE → image_item.media + image_item.aeskey (hex)
 *   FILE  → file_item.media  + file_item.file_name
 *   VOICE → voice_item.media + voice_item.text (voice-to-text shortcut)
 *   VIDEO → video_item.media
 */
function mediaFromItem(item) {
  const type = item?.type
  if (type !== ITEM_IMAGE && type !== ITEM_FILE && type !== ITEM_VOICE && type !== ITEM_VIDEO) return null
  const key = type === ITEM_IMAGE ? 'image_item' : type === ITEM_FILE ? 'file_item' : type === ITEM_VOICE ? 'voice_item' : 'video_item'
  const node = item[key] ?? {}
  const media = node.media ?? {}
  let aesKeyB64 = String(media.aes_key ?? '').trim()
  if (!aesKeyB64 && type === ITEM_IMAGE && node.aeskey) {
    // image_item.aeskey is a hex string on the wire; normalize to base64(raw).
    const hex = String(node.aeskey).trim()
    if (/^[0-9a-fA-F]{32}$/.test(hex)) aesKeyB64 = Buffer.from(hex, 'hex').toString('base64')
  }
  const ref = {
    kind: type === ITEM_IMAGE ? 'image' : type === ITEM_FILE ? 'file' : type === ITEM_VOICE ? 'voice' : 'video',
    filename: String(node.file_name ?? '').trim(),
    encryptedQueryParam: String(media.encrypt_query_param ?? '').trim(),
    fullUrl: String(media.full_url ?? '').trim(),
    aesKeyB64,
  }
  if (!ref.encryptedQueryParam && !ref.fullUrl) return null // nothing downloadable
  return ref
}

/**
 * Reduce one iLink inbound message to the channel's shape, or null to skip.
 * Null for bot echoes and self-messages only: media-only messages are welcome
 * (a caption is optional). Media entries carry the CDN reference + AES key; the
 * caller downloads/decrypts them (./media.js).
 */
export function normalizeInbound(raw, accountId) {
  const from = String(raw?.from_user_id ?? '').trim()
  if (!from || from === accountId) return null // skip echoes + self
  const items = Array.isArray(raw?.item_list) ? raw.item_list : []
  let text = ''
  const media = []
  for (const item of items) {
    if (item?.type === ITEM_TEXT && !text) {
      text = String(item?.text_item?.text ?? '')
      continue
    }
    const ref = mediaFromItem(item)
    if (ref) media.push(ref)
  }
  if (!text && media.length === 0) return null
  const groupId = String(raw?.group_id ?? '').trim()
  const conversationId = groupId || from
  const contextToken = String(raw?.context_token ?? '').trim()
  const id = String(raw?.message_id ?? raw?.client_id ?? '')
  return {
    id,
    senderId: from,
    conversationId,
    isGroup: groupId !== '',
    groupId,
    contextToken,
    text,
    media,
    timestamp: raw?.create_time_ms ?? Date.now(),
  }
}
