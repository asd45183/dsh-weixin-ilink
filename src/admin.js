// 微信通道的本地设置服务：账号状态、扫码登录、退出登录、白名单与运行参数。
// 只读写本机 0600 文件，不记录 token、消息正文或联系人昵称。
import fs from 'node:fs'
import path from 'node:path'
import { stateDir, listAccountIds, loadAccount, clearAccount, listConversations, saveAccount, registerAccountId } from './state.js'
import { fetchQrCode, pollQrStatus, ILINK_BASE_URL } from './transport/ilink.js'
import QRCode from 'qrcode'

const SETTINGS_FILE = () => path.join(stateDir(), 'settings.json')
const SENDERS_FILE = () => path.join(stateDir(), 'recent-senders.json')
const MAX_SENDERS = 30
const LOGIN_TTL_MS = 240_000

const boolKeys = new Set(['enabled', 'allowFirstContact', 'groupChatEnabled', 'mediaEnabled', 'imageAsFile', 'typingIndicator', 'proactiveEnabled'])
const listKeys = new Set(['allowedSenders', 'allowedGroups'])
const enumKeys = { groupReplyWhen: ['mention', 'all'], permissionPreset: ['workspace-write', 'danger-full-access'] }
const ID_RE = /^[A-Za-z0-9_@.\-]{4,160}$/

function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch {}
  }
}

export function readOverrides() {
  try {
    const value = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return value
  } catch { return {} }
}

export function applyOverrides(config) {
  const overrides = readOverrides()
  let changed = false
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === undefined) continue
    config[key] = overrides[key]
    changed = true
  }
  return changed
}

export function recordRecentSender(accountId, senderId, isGroup = false) {
  const id = String(senderId || '')
  if (!ID_RE.test(id)) return
  let rows = []
  try {
    const value = JSON.parse(fs.readFileSync(SENDERS_FILE(), 'utf8'))
    if (Array.isArray(value)) rows = value.filter((row) => row && typeof row.senderId === 'string')
  } catch {}
  const row = { accountId: String(accountId || ''), senderId: id, isGroup: isGroup === true, lastAt: Date.now() }
  rows = [row, ...rows.filter((item) => !(item.senderId === id && item.accountId === row.accountId))].slice(0, MAX_SENDERS)
  try { atomicWrite(SENDERS_FILE(), rows) } catch {}
}

function maskAccount(id) {
  const text = String(id || '')
  if (text.length <= 6) return text
  return `${text.slice(0, 3)}***${text.slice(-3)}`
}

function safeHost(value) {
  try { return new URL(String(value)).host } catch { return '' }
}

function safeBaseUrl(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return ILINK_BASE_URL
  let url
  try { url = new URL(raw.includes('://') ? raw : `https://${raw}`) } catch { throw new Error('登录返回的地址无效。') }
  if (url.protocol !== 'https:') throw new Error('登录返回的地址不是 HTTPS。')
  const host = url.hostname.toLowerCase()
  if (host !== 'weixin.qq.com' && host !== 'ilinkai.weixin.qq.com' && !host.endsWith('.weixin.qq.com')) throw new Error('登录返回了非微信域名。')
  return url.origin
}

function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Object.assign(new Error('设置必须是对象。'), { status: 400 })
  const clean = {}
  for (const [key, value] of Object.entries(patch)) {
    if (boolKeys.has(key)) { if (typeof value !== 'boolean') throw Object.assign(new Error(`${key} 必须是布尔值。`), { status: 400 }); clean[key] = value }
    else if (listKeys.has(key)) {
      if (!Array.isArray(value) || value.length > 200) throw Object.assign(new Error(`${key} 必须是数组。`), { status: 400 })
      const ids = [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
      if (ids.some((item) => !ID_RE.test(item))) throw Object.assign(new Error(`${key} 里有格式不正确的 id。`), { status: 400 })
      clean[key] = ids
    } else if (enumKeys[key]) {
      if (!enumKeys[key].includes(value)) throw Object.assign(new Error(`${key} 取值不合法。`), { status: 400 })
      clean[key] = value
    } else if (key === 'workspace') {
      if (typeof value !== 'string' || value.length > 500 || /[\0\r\n]/.test(value)) throw Object.assign(new Error('工作目录格式不正确。'), { status: 400 })
      clean[key] = value.trim()
    } else throw Object.assign(new Error(`不支持的设置项：${key}`), { status: 400 })
  }
  return clean
}

export class WeixinAdmin {
  constructor({ config = {}, log = () => {}, warn = () => {} } = {}) {
    this.config = config
    this.log = log
    this.warn = warn
    this.login = null
  }

  settings() {
    const overrides = readOverrides()
    const merged = {}
    for (const key of [...boolKeys, ...listKeys, ...Object.keys(enumKeys), 'workspace']) {
      merged[key] = overrides[key] !== undefined ? overrides[key] : this.config[key]
    }
    return merged
  }

  status() {
    const ids = listAccountIds()
    const accounts = ids.map((id) => {
      let account = null
      try { account = loadAccount(id) } catch {}
      return { id, masked: maskAccount(id), ready: Boolean(account?.token), userId: account?.userId || '', host: safeHost(account?.baseUrl) }
    })
    let conversations = []
    try { conversations = listConversations() } catch {}
    const latest = conversations.reduce((max, row) => Math.max(max, Number(row.lastInboundAt) || 0), 0)
    let senders = []
    try {
      const rows = JSON.parse(fs.readFileSync(SENDERS_FILE(), 'utf8'))
      if (Array.isArray(rows)) senders = rows.slice(0, MAX_SENDERS)
    } catch {}
    return {
      protocol: 'weixin-settings-v1',
      accounts,
      settings: this.settings(),
      conversations: { count: conversations.length, lastInboundAt: latest || null },
      senders,
      login: this.login ? this.loginState() : null,
      note: '登录/退出在保存凭证后立即生效；白名单和开关保存后立即用于新消息；工作目录、权限预设和账号轮询范围需要重启 DSH。',
    }
  }

  loginState(extra = {}) {
    if (!this.login) return null
    return {
      status: this.login.status,
      image: this.login.image || '',
      link: this.login.link || '',
      startedAt: this.login.startedAt,
      expiresAt: this.login.expiresAt,
      expired: Date.now() > this.login.expiresAt,
      ...extra,
    }
  }

  async startLogin({ botType = '3' } = {}) {
    if (this.login && this.login.status === 'confirmed') this.login = null
    const fresh = await fetchQrCode({ botType: String(botType) })
    const qrcode = String(fresh?.qrcode ?? '')
    const link = String(fresh?.qrcode_img_content ?? '')
    if (!qrcode || !link) throw Object.assign(new Error('二维码响应缺少字段，请重试。'), { status: 502 })
    const image = await QRCode.toDataURL(link, { margin: 1, width: 360, errorCorrectionLevel: 'M' })
    this.login = { qrcode, link, image, baseUrl: ILINK_BASE_URL, status: 'wait', startedAt: Date.now(), expiresAt: Date.now() + LOGIN_TTL_MS, refreshes: 0 }
    this.log('settings: qr login started')
    return this.loginState()
  }

  async pollLogin() {
    if (!this.login) return { status: 'idle', message: '没有进行中的登录。' }
    if (Date.now() > this.login.expiresAt && this.login.status !== 'confirmed') {
      this.login.status = 'expired'
      return this.loginState({ message: '二维码已过期，请刷新。' })
    }
    // 设置页每 2–3 秒轮询一次，这里用短超时避免长时间占住请求。
    let result
    try { result = await pollQrStatus({ baseUrl: this.login.baseUrl, qrcode: this.login.qrcode, timeoutMs: 8000 }) }
    catch { this.login.status = 'wait'; return this.loginState() }
    const status = String(result?.status ?? 'wait')
    if (status === 'wait' || status === 'scaned') { this.login.status = status; return this.loginState() }
    if (status === 'scaned_but_redirect' && result.redirect_host) {
      this.login.baseUrl = safeBaseUrl(result.redirect_host)
      this.login.status = 'scaned'
      return this.loginState({ message: '已扫码，正在跳转…' })
    }
    if (status === 'expired') {
      this.login.status = 'expired'
      return this.loginState({ message: '二维码已过期，请刷新。' })
    }
    if (status === 'binded_redirect') return { status: 'blocked', message: '该机器人仍绑定在本机，请先在微信里解除绑定再扫码。' }
    if (status === 'confirmed') {
      const accountId = String(result.ilink_bot_id ?? '')
      const token = String(result.bot_token ?? '')
      if (!accountId || !token) return { status: 'error', message: '登录确认但凭证不完整，请重新扫码。' }
      const baseUrl = safeBaseUrl(result.baseurl)
      saveAccount(accountId, { token, baseUrl, userId: String(result.ilink_user_id ?? '') })
      registerAccountId(accountId)
      this.login = { ...this.login, status: 'confirmed', accountId, image: '', link: '' }
      this.log(`settings: weixin account ${maskAccount(accountId)} bound`)
      return this.loginState({ message: `微信连接成功：${maskAccount(accountId)}。新账号在重启 DSH 后开始接收消息。` })
    }
    this.login.status = 'wait'
    return this.loginState()
  }

  cancelLogin() {
    this.login = null
    return { status: 'idle' }
  }

  logout(accountId) {
    const id = String(accountId || '').trim()
    if (!listAccountIds().includes(id)) throw Object.assign(new Error('没有找到该账号。'), { status: 404 })
    clearAccount(id)
    this.log(`settings: weixin account ${maskAccount(id)} removed`)
    return { removed: id, accounts: this.status().accounts }
  }

  save(patch) {
    const clean = validatePatch(patch)
    const overrides = { ...readOverrides(), ...clean }
    atomicWrite(SETTINGS_FILE(), overrides)
    // 白名单、开关立即生效；工作目录/权限预设等仍需重启。
    Object.assign(this.config, clean)
    return this.status()
  }
}
