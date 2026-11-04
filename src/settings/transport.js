import { Readable } from 'node:stream'
import { SETTINGS_PREFIX } from './route.js'

const SETTINGS_RPC_CHANNEL = '/weixin-settings'
const MAX_BYTES = 262_144
const writes = new Set(['login/start', 'login/poll', 'login/cancel', 'logout', 'save'])
const valid = (route, write) => write ? writes.has(route.slice(1)) : route === '/state'
const result = (status, error) => ({ status, body: { error } })

export async function dispatchSettings(route, { path, input, token, signal } = {}) {
  signal?.throwIfAborted()
  const write = input !== undefined
  if (typeof path !== 'string' || !valid(path, write)) return result(400, '只允许本插件的设置接口。')
  let bytes
  try { bytes = write ? Buffer.from(JSON.stringify(input)) : Buffer.alloc(0) } catch { return result(400, '设置必须是 JSON。') }
  if (bytes.length > MAX_BYTES) return result(413, '设置请求过长。')
  const request = Readable.from(bytes.length ? [bytes] : [])
  request.method = write ? 'POST' : 'GET'
  request.url = SETTINGS_PREFIX + path
  request.headers = { host: '127.0.0.1', origin: 'http://127.0.0.1', 'content-type': 'application/json', ...(typeof token === 'string' ? { 'x-weixin-settings-token': token } : {}) }
  let status = 200, body
  await route.handler(request, { writeHead(code) { status = code }, end(data) { body = JSON.parse(String(data)) } })
  return { status, body }
}

export function createSettingsRpcHandler(route) {
  return async (endpoint, payload, signal, peer) => {
    if (peer?.principal && peer.principal.kind !== 'owner') return { ok: true, value: result(403, '设置只允许宿主所有者操作。') }
    if (endpoint !== 'request' || !payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['path', 'input', 'token'].includes(key))) return { ok: true, value: result(400, '设置请求格式无效。') }
    return { ok: true, value: await dispatchSettings(route, { ...payload, signal }) }
  }
}

export function createSettingsFetchHandler(route) {
  return async request => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(SETTINGS_PREFIX + '/')) return Response.json({ error: '设置地址不存在。' }, { status: 404 })
    const local = ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    const desktop = ['dsh-app:', 'dsh:'].includes(url.protocol) && url.hostname === 'app'
    const source = request.headers.get('origin')
    const ownOrigin = local ? url.origin : `${url.protocol}//${url.host}`
    if ((!local && !desktop) || source && source !== ownOrigin || ['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site'))) return Response.json({ error: '拒绝跨来源设置请求。' }, { status: 403 })
    let input
    if (request.method === 'POST') {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return Response.json({ error: '只接收 JSON 设置。' }, { status: 400 })
      const reader = request.body?.getReader(), chunks = []
      let size = 0
      if (reader) try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_BYTES) { await reader.cancel(); return Response.json({ error: '设置请求过长。' }, { status: 413 }) }
          chunks.push(Buffer.from(value))
        }
      } finally { reader?.releaseLock?.() }
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return Response.json({ error: '设置必须是 JSON。' }, { status: 400 }) }
    } else if (request.method !== 'GET') return Response.json({ error: '设置方法不支持。' }, { status: 405 })
    const outcome = await dispatchSettings(route, { path: url.pathname.slice(SETTINGS_PREFIX.length) + url.search, input, token: request.headers.get('x-weixin-settings-token'), signal: request.signal })
    return Response.json(outcome.body, { status: outcome.status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  }
}

export function createSettingsRpcRoute(connection, route) {
  const handler = createSettingsRpcHandler(route)
  return {
    kind: 'prefix',
    path: SETTINGS_RPC_CHANNEL,
    async handler(req, res) {
      const admission = typeof connection.admit === 'function' ? connection.admit(req) : { rejection: connection.requestRejection(req) }
      if (admission.rejection !== undefined) { res.writeHead(admission.rejection); res.end('unauthorized'); return }
      if (req.method !== 'POST' || req.url.split('?')[0] !== SETTINGS_RPC_CHANNEL + '/request') { res.writeHead(404); res.end('not found'); return }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { res.writeHead(415); res.end('JSON required'); return }
      const chunks = []
      let size = 0, message
      for await (const bytes of req) { size += bytes.length; if (size > MAX_BYTES + 4096) { res.writeHead(413); res.end('too large'); return } chunks.push(bytes) }
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { res.writeHead(400); res.end('invalid JSON'); return }
      if (message?.type !== 'client-request' || message.method !== 'request' || typeof message.rpcId !== 'string' || message.rpcId.length > 128) { res.writeHead(400); res.end('invalid request'); return }
      const value = await handler('request', message.payload, undefined, admission.peer)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: value }))
    },
  }
}

export function bindSettingsRoutes(ctx, factory) {
  let route
  const getRoute = () => route ??= factory()
  const fibers = []
  fibers.push(ctx.inject(['webServer'], owner => owner.effect(() => owner.webServer.register(getRoute()))))
  fibers.push(ctx.inject(['connection'], owner => {
    if (typeof owner.connection?.fetch?.register !== 'function') return
    const fetch = createSettingsFetchHandler(getRoute())
    for (const path of ['/state', ...[...writes].map(item => '/' + item)]) {
      owner.connection.fetch.register({
        path: SETTINGS_PREFIX + path,
        methods: path === '/state' ? ['GET'] : ['POST'],
        requestBody: 'buffer',
        handler: request => fetch(request),
      })
    }
  }))
  fibers.push(ctx.inject(['connection', 'webServer'], owner => {
    owner.effect(() => owner.webServer.register(createSettingsRpcRoute(owner.connection, getRoute())))
  }))
  const available = name => { try { return Boolean(ctx.get(name)) } catch { return false } }
  return {
    async dispose() { await Promise.all(fibers.map(fiber => fiber.dispose())) },
    async ready() {
      if (available('webServer')) await fibers[0].await()
      if (available('connection')) await fibers[1].await()
      if (available('connection') && available('webServer')) await fibers[2].await()
    },
  }
}
