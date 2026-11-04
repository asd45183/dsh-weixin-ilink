// 复用 DSH 的原生 WebServer / connection 承载设置页，不另开端口。
import { randomBytes, timingSafeEqual } from 'node:crypto'

export const SETTINGS_PREFIX = '/api/weixin-settings'
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)) }

async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('只接收 JSON 设置。'), { status: 400 })
  let size = 0
  const chunks = []
  for await (const bytes of req) { size += bytes.length; chunks.push(bytes); if (size > 262_144) throw Object.assign(new Error('设置请求过长。'), { status: 413 }) }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value } catch { throw Object.assign(new Error('设置必须是 JSON 对象。'), { status: 400 }) }
}

const empty = (value) => { if (Object.keys(value).length) throw Object.assign(new Error('此操作不接收参数。'), { status: 400 }) }

export function createSettingsRoute({ admin, log = () => {} } = {}) {
  if (!admin) throw new TypeError('缺少微信设置服务。')
  const token = randomBytes(32).toString('hex')
  return {
    kind: 'prefix',
    path: SETTINGS_PREFIX,
    async handler(req, res) {
      try {
        const host = req.headers.host
        if (!host || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return send(res, 403, { error: '设置页只接受本机来源。' })
        const origin = `${req.socket?.encrypted ? 'https' : 'http'}://${host}`
        const url = new URL(req.url, origin)
        if (url.origin !== origin || req.headers.origin && req.headers.origin !== origin || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return send(res, 403, { error: '拒绝跨来源设置请求。' })
        if (req.method === 'GET' && url.pathname === `${SETTINGS_PREFIX}/state`) return send(res, 200, { token, ...admin.status() })
        if (req.method !== 'POST') return send(res, 404, { error: '设置地址不存在。' })
        const supplied = req.headers['x-weixin-settings-token']
        if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return send(res, 403, { error: '请刷新设置页后重试。' })
        const input = await body(req)
        let value
        switch (url.pathname.slice(SETTINGS_PREFIX.length)) {
          case '/login/start': {
            const botType = input.botType === undefined ? '3' : input.botType
            if (typeof botType !== 'string' || !/^[0-9]{1,4}$/.test(botType)) throw Object.assign(new Error('botType 格式不正确。'), { status: 400 })
            value = await admin.startLogin({ botType })
            break
          }
          case '/login/poll': empty(input); value = await admin.pollLogin(); break
          case '/login/cancel': empty(input); value = admin.cancelLogin(); break
          case '/logout': {
            if (Object.keys(input).length !== 1 || typeof input.accountId !== 'string') throw Object.assign(new Error('退出登录只接收 accountId。'), { status: 400 })
            value = admin.logout(input.accountId)
            break
          }
          case '/save': {
            if (Object.keys(input).length !== 1 || !input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) throw Object.assign(new Error('保存设置只接收 patch 对象。'), { status: 400 })
            value = admin.save(input.patch)
            break
          }
          default: return send(res, 404, { error: '设置地址不存在。' })
        }
        return send(res, 200, value)
      } catch (error) {
        const status = Number.isSafeInteger(error?.status) ? error.status : 500
        if (status >= 500) log(`settings error: ${String(error?.message || error)}`)
        return send(res, status, { error: String(error?.message || error) })
      }
    },
  }
}
