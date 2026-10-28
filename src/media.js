/**
 * Weixin media: AES-128-ECB CDN download/upload + SSRF allowlist.
 *
 * Media never rides the iLink JSON API. It lives on the WeChat CDN
 * (`novac2c.cdn.weixin.qq.com/c2c`), encrypted with AES-128-ECB + PKCS7:
 *
 *   download: GET  <cdn>/download?encrypted_query_param=<p>   → ciphertext
 *   upload:   POST <upload_url>  (raw ciphertext, octet-stream)
 *             → response header `x-encrypted-param` = the download param
 *
 * The AES key travels as base64. On the wire it is either base64(raw 16 bytes)
 * (inbound) or base64(hex string) (outbound — the iLink API wants the hex text
 * encoded as base64; base64(raw bytes) makes receivers show grey boxes).
 *
 * Every CDN URL is checked against an explicit host allowlist before a socket
 * is opened: an item's `full_url` comes from the peer, so without this an
 * attacker could point us at internal services (SSRF).
 * @module dsh-weixin-ilink/media
 */
import crypto from 'node:crypto'
import { getUploadUrl } from './transport/ilink.js'

export const MEDIA_IMAGE = 1
export const MEDIA_VIDEO = 2
export const MEDIA_FILE = 3
export const MEDIA_VOICE = 4

/** Hosts we are willing to fetch media from. Everything else is refused (SSRF). */
export const CDN_ALLOWLIST = new Set([
  'novac2c.cdn.weixin.qq.com',
  'ilinkai.weixin.qq.com',
  'wx.qlogo.cn',
  'thirdwx.qlogo.cn',
  'res.wx.qq.com',
  'mmbiz.qpic.cn',
  'mmbiz.qlogo.cn',
])

/**
 * Built-in CDN hosts plus operator-configured extras. Entries may be bare
 * hostnames or full URLs (only the hostname is taken), matched lowercase.
 * @param {readonly string[]} [extra]
 * @returns {Set<string>}
 */
export function mediaAllowlist(extra) {
  const set = new Set(CDN_ALLOWLIST)
  for (const entry of Array.isArray(extra) ? extra : []) {
    const raw = String(entry ?? '').trim().toLowerCase()
    if (raw === '') continue
    try {
      set.add(raw.includes('://') ? new URL(raw).hostname.toLowerCase() : raw)
    } catch {
      // An unparseable entry cannot widen the allowlist; ignore it.
    }
  }
  return set
}

/**
 * Throw unless `url` is http(s) and its host is allowlisted.
 * @param {string} url
 * @param {Set<string>} [allowlist]
 */
export function assertSafeMediaUrl(url, allowlist = CDN_ALLOWLIST) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    throw new Error(`Unparseable media URL: ${String(url).slice(0, 120)}`)
  }
  const scheme = parsed.protocol.toLowerCase()
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new Error(`Media URL has disallowed scheme ${scheme}; only http/https are permitted`)
  }
  const host = parsed.hostname.toLowerCase()
  if (!allowlist.has(host)) {
    throw new Error(`Media URL host ${host} is not in the WeChat CDN allowlist; refusing to fetch to prevent SSRF`)
  }
}

/**
 * Accept the two on-wire key encodings and return 16 raw key bytes.
 * @param {string} aesKeyB64
 * @returns {Buffer}
 */
export function parseAesKey(aesKeyB64) {
  const decoded = Buffer.from(String(aesKeyB64), 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32) {
    const text = decoded.toString('latin1')
    if (/^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, 'hex')
  }
  throw new Error(`unexpected aes_key format (${decoded.length} decoded bytes)`)
}

/** AES-128-ECB + PKCS7 encrypt. @param {Buffer} plaintext @param {Buffer} key */
export function aes128EcbEncrypt(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** AES-128-ECB + PKCS7 decrypt. @param {Buffer} ciphertext @param {Buffer} key */
export function aes128EcbDecrypt(ciphertext, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** PKCS7 always adds 1..16 bytes, so an encrypted file is 16-aligned and > size. */
export function paddedSize(size) {
  return (Math.floor(size / 16) + 1) * 16
}

/** CDN download URL for an `encrypted_query_param` returned by iLink. */
export function cdnDownloadUrl(cdnBaseUrl, encryptedQueryParam) {
  return `${String(cdnBaseUrl).replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`
}

/** CDN upload URL constructed from `upload_param` + `filekey`. */
export function cdnUploadUrl(cdnBaseUrl, uploadParam, filekey) {
  return `${String(cdnBaseUrl).replace(/\/+$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

/**
 * Fetch a media object and decrypt it. The peer-supplied URL is allowlisted
 * before the request; `encrypted_query_param` URLs are built from the
 * configured CDN base, which is allowlisted too.
 * @param {{ cdnBaseUrl: string, encryptedQueryParam?: string, fullUrl?: string,
 *           aesKeyB64?: string, timeoutMs?: number, allowlist?: Set<string> }} opts
 * @returns {Promise<Buffer>}
 */
export async function downloadMedia({ cdnBaseUrl, encryptedQueryParam, fullUrl, aesKeyB64, timeoutMs = 60_000, allowlist = CDN_ALLOWLIST }) {
  let url
  if (encryptedQueryParam) {
    url = cdnDownloadUrl(cdnBaseUrl, encryptedQueryParam)
  } else if (fullUrl) {
    url = String(fullUrl)
  } else {
    throw new Error('media item had neither encrypt_query_param nor full_url')
  }
  assertSafeMediaUrl(url, allowlist)
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 200)
    throw new Error(`CDN download HTTP ${response.status}: ${body}`)
  }
  let data = Buffer.from(await response.arrayBuffer())
  if (aesKeyB64) data = aes128EcbDecrypt(data, parseAesKey(aesKeyB64))
  return data
}

/**
 * Upload one plaintext to the CDN and return the fields needed to build the
 * sendmessage item.
 * @param {{ baseUrl: string, token: string, cdnBaseUrl: string, toUserId: string,
 *           plaintext: Buffer, filename: string, timeoutMs?: number }} opts
 * @returns {Promise<{ encryptedQueryParam: string, aesKeyForApi: string,
 *           ciphertextSize: number, plaintextSize: number }>}
 */
export async function uploadMedia({ baseUrl, token, cdnBaseUrl, toUserId, plaintext, filename, timeoutMs = 120_000 }) {
  const filekey = crypto.randomBytes(16).toString('hex')
  const aesKey = crypto.randomBytes(16)
  const rawsize = plaintext.length
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex')
  const upload = await getUploadUrl({
    baseUrl,
    token,
    toUserId,
    mediaType: mediaTypeFor(filename),
    filekey,
    rawsize,
    rawfilemd5,
    filesize: paddedSize(rawsize),
    aeskeyHex: aesKey.toString('hex'),
  })
  if ((upload.ret ?? 0) !== 0 || (upload.errcode ?? 0) !== 0) {
    throw new Error(`getUploadUrl failed: ret=${upload.ret ?? 0} errcode=${upload.errcode ?? 0} errmsg=${upload.errmsg ?? ''}`)
  }

  const uploadFullUrl = String(upload.upload_full_url ?? '')
  const uploadParam = String(upload.upload_param ?? '')
  let uploadUrl
  if (uploadParam) {
    // Prefer building the CDN URL from upload_param: the manual image_item
    // sends that rendered on 2026-10-28 all used this path, and the
    // x-encrypted-param it returns is the one the client accepts for images.
    uploadUrl = cdnUploadUrl(cdnBaseUrl, uploadParam, filekey)
  } else if (uploadFullUrl) {
    // Server-provided signed URL: must still be http(s); the host is chosen by
    // the iLink API, not by the peer.
    // Server-provided signed URL: still require http(s) and a WeChat CDN host.
    assertSafeMediaUrl(uploadFullUrl, CDN_ALLOWLIST)
    uploadUrl = uploadFullUrl
  } else {
    throw new Error('getUploadUrl returned neither upload_param nor upload_full_url')
  }

  const ciphertext = aes128EcbEncrypt(plaintext, aesKey)
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: ciphertext,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (response.status !== 200) {
    const body = (await response.text().catch(() => '')).slice(0, 200)
    throw new Error(`CDN upload HTTP ${response.status}: ${body}`)
  }
  // The download param the WeChat client accepts is the `x-encrypted-param`
  // response header (matches the reference implementation), falling back to
  // `upload_param`. Measured 2026-10-28 against a live account: header param +
  // base64(hex-key) renders; a base64(raw-key) renders corrupt; and the header
  // param answers HTTP 400 to our own plain GET (the client fetches it through
  // a different path), so do not "fix" this by preferring upload_param.
  const headerParam = response.headers.get('x-encrypted-param')
  const encryptedQueryParam = headerParam || uploadParam
  if (!encryptedQueryParam) throw new Error('CDN upload produced neither x-encrypted-param nor upload_param')

  return {
    encryptedQueryParam,
    // iLink expects base64(hex string), not base64(raw bytes).
    aesKeyForApi: Buffer.from(aesKey.toString('hex'), 'utf-8').toString('base64'),
    ciphertextSize: ciphertext.length,
    plaintextSize: rawsize,
  }
}

/**
 * Build the `item_list[0]` entry for an uploaded media object.
 * Images go as IMAGE (inline preview); everything else as FILE (download card).
 * @param {{ mime: string, filename: string, encryptedQueryParam: string,
 *           aesKeyForApi: string, ciphertextSize: number, plaintextSize: number,
 *           forceFile?: boolean }} opts
 */
export function buildMediaItem({ mime, filename, encryptedQueryParam, aesKeyForApi, ciphertextSize, plaintextSize, forceFile = false }) {
  const media = {
    encrypt_query_param: encryptedQueryParam,
    aes_key: aesKeyForApi,
    encrypt_type: 1,
  }
  if (!forceFile && String(mime).toLowerCase().startsWith('image/')) {
    return { type: 2, image_item: { media, mid_size: ciphertextSize } }
  }
  return {
    type: 4,
    file_item: { media, file_name: filename, len: String(plaintextSize) },
  }
}

/** Coarse iLink media type for getUploadUrl, from the file name/mime. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm'])

export function mediaTypeFor(filename, mime = '') {
  const name = String(filename).toLowerCase()
  const type = String(mime).toLowerCase()
  if (type.startsWith('image/')) return MEDIA_IMAGE
  if (type.startsWith('video/')) return MEDIA_VIDEO
  // uploadMedia calls this without a MIME type; infer images/videos from the
  // extension so a .png is registered as IMAGE, not FILE. Registering it as
  // FILE makes the image_item upload return a different x-encrypted-param and
  // the client shows "expired or cleaned" instead of the picture.
  const dot = name.lastIndexOf('.')
  const ext = dot === -1 ? '' : name.slice(dot)
  if (IMAGE_EXTENSIONS.has(ext)) return MEDIA_IMAGE
  if (VIDEO_EXTENSIONS.has(ext)) return MEDIA_VIDEO
  if (name.endsWith('.silk')) return MEDIA_VOICE
  return MEDIA_FILE
}
