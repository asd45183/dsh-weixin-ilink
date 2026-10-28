/**
 * Outbound reply: markdown-agnostic chunking + iLink sendMessage + media.
 *
 * WeChat rejects messages over the platform limit, so long replies are split at
 * a paragraph, then line, then space boundary near the limit; a pathological
 * unbroken string is hard-cut. Every chunk echoes the peer's latest
 * context_token (iLink requires it; a stale/absent one can make the server drop
 * the message).
 *
 * Outbound media convention: the agent writes a local file and puts
 * `MEDIA:/absolute/path` on its own line in the reply. We strip the tag, send
 * the text, then upload the file to the CDN and send it as an IMAGE (image/*)
 * or FILE item.
 * @module dsh-weixin-ilink/outbound
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sendMessage, sendItemMessage } from './transport/ilink.js'

/**
 * iLink answers `-2 / prepare failed` (or `unknown error`) when the session has
 * gone stale after a quiet period. Retrying once WITHOUT the context token is
 * the documented fallback; everything else is a real failure.
 */
function isStaleSession(resp) {
  const code = resp?.ret ?? resp?.errcode
  return code === -2 && /prepare failed|unknown error/i.test(String(resp?.errmsg ?? resp?.msg ?? ''))
}

/** Send once, and once more without the context token when the session is stale. */
async function sendWithStaleRetry(makeSend, contextToken, warn, to) {
  let resp = await makeSend(contextToken)
  if (isStaleSession(resp) && contextToken !== undefined) {
    warn?.(`send to ${safeId(to)} stale session; retrying without context_token`)
    resp = await makeSend(undefined)
  }
  return resp
}
import { buildMediaItem, uploadMedia } from './media.js'

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

/** Best-effort mime from the file extension (no dependency on a mime db). */
export function guessMime(filename) {
  return MIME_BY_EXT[path.extname(String(filename)).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Split `text` into chunks of at most `max` characters, preferring natural
 * boundaries. Returns [] for empty text.
 * @param {string} text
 * @param {number} max
 */
export function chunkText(text, max = 2000) {
  const src = String(text ?? '')
  if (src === '') return []
  const limit = Math.max(1, Math.floor(max))
  if (src.length <= limit) return [src]
  const chunks = []
  let rest = src
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^[\n\s]+/, '')
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

// `MEDIA:<path>` with optional whitespace and optional quotes/backticks around
// the path (models often wrap paths in backticks).
const MEDIA_TAG_RE = /MEDIA:\s*(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|[^\s`"']+)/g

/**
 * Extract `MEDIA:/path` tags from a reply. Returns the cleaned text plus the
 * referenced paths (de-duplicated, in order). Tag removal keeps the rest of the
 * text intact; only lines that become empty vanish.
 * @param {string} text
 * @returns {{ paths: string[], text: string }}
 */
export function extractMedia(text) {
  const src = String(text ?? '')
  const paths = []
  const seen = new Set()
  const take = (token) => {
    let value = String(token ?? '').trim()
    if ((value.startsWith('`') && value.endsWith('`')) || (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim()
    }
    if (value && !seen.has(value)) {
      seen.add(value)
      paths.push(value)
    }
  }
  const kept = []
  for (const line of src.split('\n')) {
    MEDIA_TAG_RE.lastIndex = 0
    let hadTag = false
    const cleanedLine = line.replace(MEDIA_TAG_RE, (match, token) => {
      hadTag = true
      take(token)
      return ''
    })
    // A line that existed only to carry tags disappears entirely; other lines
    // keep their text (and any deliberate blank lines elsewhere are preserved).
    if (hadTag && cleanedLine.trim() === '') continue
    kept.push(hadTag ? cleanedLine.replace(/[ \t]+$/, '') : line)
  }
  const cleaned = kept.join('\n').replace(/^\n+/, '').replace(/\n+$/, '').trim()
  return { paths, text: cleaned }
}

/**
 * Send a reply, chunked, echoing the peer's context_token.
 * @returns {Promise<{ sent: number, error?: string }>}
 */
export async function sendReply({ baseUrl, token, to, text, contextToken, maxLength = 2000, log, warn }) {
  const chunks = chunkText(text, maxLength)
  if (chunks.length === 0) return { sent: 0 }
  let sent = 0
  for (const chunk of chunks) {
    let resp
    try {
      resp = await sendWithStaleRetry(
        (token0) => sendMessage({ baseUrl, token, to, text: chunk, ...(token0 === undefined ? {} : { contextToken: token0 }), clientId: randomUUID() }),
        contextToken, warn, to)
    } catch (error) {
      warn?.(`send to ${safeId(to)} failed: ${String(error)}`)
      return { sent, error: String(error) }
    }
    const ret = resp?.ret ?? 0
    const errcode = resp?.errcode ?? 0
    if (ret !== 0 || errcode !== 0) {
      warn?.(`send to ${safeId(to)} ret=${ret} errcode=${errcode} errmsg=${resp?.errmsg ?? ''}`)
      return { sent, error: `ret=${ret} errcode=${errcode}` }
    }
    sent += 1
  }
  return { sent }
}

/**
 * Upload local files to the CDN and send each as an IMAGE or FILE message.
 * Missing/unreadable paths are skipped with a warning (a hallucinated path
 * should not fail the whole reply).
 * @param {{ baseUrl: string, token: string, cdnBaseUrl: string, to: string,
 *           paths: string[], contextToken?: string, warn?: (s: string) => void }} opts
 * @returns {Promise<{ sent: number, skipped: string[], error?: string }>}
 */
export async function sendMediaFiles({ baseUrl, token, cdnBaseUrl, to, paths, contextToken, warn, imageAsFile = true }) {
  const skipped = []
  let sent = 0
  for (const raw of paths ?? []) {
    const file = String(raw)
    let plaintext
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile()) throw new Error('not a regular file')
      plaintext = fs.readFileSync(file)
    } catch (error) {
      warn?.(`media skip ${file}: ${String(error)}`)
      skipped.push(file)
      continue
    }
    try {
      const filename = path.basename(file)
      const mime = guessMime(filename)
      const uploaded = await uploadMedia({
        baseUrl,
        token,
        cdnBaseUrl,
        toUserId: to,
        plaintext,
        filename,
      })
      // An image_item is accepted by iLink but renders as a corrupt thumbnail
      // (measured 2026-10-28: same fields as Tencent's own inbound image_item,
      // PNG and JPEG, and even Tencent's own picture re-uploaded). The identical
      // bytes as a file_item open correctly, so images default to a file
      // attachment; set imageAsFile=false to retry the image channel.
      const item = buildMediaItem({
        mime,
        filename,
        encryptedQueryParam: uploaded.encryptedQueryParam,
        aesKeyForApi: uploaded.aesKeyForApi,
        ciphertextSize: uploaded.ciphertextSize,
        plaintextSize: uploaded.plaintextSize,
        forceFile: imageAsFile,
      })
      const resp = await sendWithStaleRetry(
        (token0) => sendItemMessage({ baseUrl, token, to, item, ...(token0 === undefined ? {} : { contextToken: token0 }), clientId: randomUUID() }),
        contextToken, warn, to)
      const ret = resp?.ret ?? 0
      const errcode = resp?.errcode ?? 0
      if (ret !== 0 || errcode !== 0) throw new Error(`ret=${ret} errcode=${errcode} errmsg=${resp?.errmsg ?? ''}`)
      sent += 1
    } catch (error) {
      warn?.(`media send ${file} failed: ${String(error)}`)
      skipped.push(file)
    }
  }
  return sent > 0 || skipped.length === 0 ? { sent, skipped } : { sent, skipped, error: `failed: ${skipped.length}` }
}

function safeId(value) {
  const raw = String(value ?? '').trim()
  return raw ? raw.slice(0, 8) : '?'
}
