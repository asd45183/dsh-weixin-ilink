/**
 * Self-check for the non-trivial pure logic: state round-trip + 0600 perms,
 * inbound normalization, and session-expiry classification.
 *
 * Run: node test/selfcheck.mjs
 * No framework — plain asserts. Exits 0 on pass, 1 on the first failure.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createServer } from 'node:http'
import { saveAccount, loadAccount, listAccountIds, registerAccountId, clearAccount, saveContextToken, loadContextToken, recordConversationInbound, listConversations, activeLine, advanceLine } from '../src/state.js'
import { normalizeInbound, isSessionExpired, isStaleSessionRet } from '../src/transport/ilink.js'
import { chunkText, extractMedia, guessMime, sendMediaFiles } from '../src/outbound.js'
import { aes128EcbDecrypt, aes128EcbEncrypt, assertSafeMediaUrl, buildMediaItem, downloadMedia, mediaAllowlist, paddedSize, parseAesKey } from '../src/media.js'
import { admission, groupAdmission } from '../src/admission.js'
import { singleFlight } from '../src/memo.js'
import { HELP_TEXT, isMentioned, parseCommand } from '../src/commands.js'
import { readAssistantReply } from '../src/session-reader.js'
import { readPersonaStore, resolveMode, setActiveMode, activeModeFor, buildPersonaBlock } from '../src/persona.js'
import { inferLifeState, lifeBlock } from '../src/life-state.js'
import { planCompanionReply, isCompanionMode } from '../src/human-pace.js'
import { planProactive } from '../src/proactive.js'
import { formatModelList, listModelChoices, resolveModelChoice } from '../src/model-catalog.js'
import { AgentBridge } from '../src/agent-bridge.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-ilink-'))
process.env.DSH_WEIXIN_OWN_STATE_DIR = tmp

// --- state: round-trip + 0600 + index --------------------------------------
const aid = 'test-bot@im.wechat'
saveAccount(aid, { token: 'tok-abc', baseUrl: 'https://ilinkai.weixin.qq.com', userId: 'u1' })
const loaded = loadAccount(aid)
assert.equal(loaded.token, 'tok-abc')
assert.equal(loaded.userId, 'u1')
const st = fs.statSync(path.join(tmp, 'accounts', `${aid}.json`))
const mode = st.mode & 0o777
assert.equal(mode, 0o600, `credential file must be 0600, got 0o${mode.toString(8)}`)
registerAccountId(aid)
assert.deepEqual(listAccountIds(), [aid])
clearAccount(aid)
assert.equal(loadAccount(aid), null)
assert.deepEqual(listAccountIds(), [])

// account ids become filenames: reject traversal / separators
assert.throws(() => saveAccount('../evil', { token: 'x', baseUrl: 'https://ilinkai.weixin.qq.com' }))
assert.equal(loadAccount('../evil'), null)
assert.equal(loadAccount('a/b'), null)
assert.throws(() => registerAccountId('../evil'))

// --- normalizeInbound: echo/self skip, text extraction, group vs dm ---------
const accountId = 'bot@im.wechat'
// bot echo → null
assert.equal(normalizeInbound({ from_user_id: accountId, item_list: [{ type: 1, text_item: { text: 'echo' } }] }, accountId), null)
// DM text
const dm = normalizeInbound({ from_user_id: 'wxid_a', message_id: 'm1', context_token: 'ctx', item_list: [{ type: 1, text_item: { text: 'hello' } }] }, accountId)
assert.equal(dm.senderId, 'wxid_a')
assert.equal(dm.conversationId, 'wxid_a')
assert.equal(dm.text, 'hello')
assert.equal(dm.contextToken, 'ctx')
// group: group_id wins as conversation id
const grp = normalizeInbound({ from_user_id: 'wxid_a', group_id: 'room@chatroom', item_list: [{ type: 1, text_item: { text: 'hi' } }] }, accountId)
assert.equal(grp.conversationId, 'room@chatroom')
// media-only (image, no text) → a message carrying the CDN reference
const imgOnly = normalizeInbound({ from_user_id: 'wxid_a', message_id: 'm2', item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'p1' }, aeskey: '00112233445566778899aabbccddeeff' } }] }, accountId)
assert.equal(imgOnly.text, '')
assert.equal(imgOnly.media.length, 1)
assert.equal(imgOnly.media[0].kind, 'image')
assert.equal(imgOnly.media[0].encryptedQueryParam, 'p1')
assert.equal(imgOnly.media[0].aesKeyB64, Buffer.from('00112233445566778899aabbccddeeff', 'hex').toString('base64'))
// file item keeps the peer filename
const fileMsg = normalizeInbound({ from_user_id: 'wxid_a', item_list: [{ type: 4, file_item: { file_name: 'report.pdf', media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/x' } } }] }, accountId)
assert.equal(fileMsg.media[0].kind, 'file')
assert.equal(fileMsg.media[0].filename, 'report.pdf')
assert.equal(fileMsg.media[0].fullUrl, 'https://novac2c.cdn.weixin.qq.com/c2c/x')
// caption + image both survive
const caption = normalizeInbound({ from_user_id: 'wxid_a', item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'p1' } } }, { type: 1, text_item: { text: 'look' } }] }, accountId)
assert.equal(caption.text, 'look')
assert.equal(caption.media.length, 1)
// an item with neither param nor full_url is not downloadable → dropped, and a
// message with no text + no media still returns null
assert.equal(normalizeInbound({ from_user_id: 'wxid_a', item_list: [{ type: 2, image_item: { media: {} } }] }, accountId), null)

// --- session expiry classification -----------------------------------------
assert.equal(isSessionExpired({}, -14, undefined), true)
assert.equal(isSessionExpired({}, undefined, -14), true)
assert.equal(isStaleSessionRet(-2, undefined, 'prepare failed'), true)
assert.equal(isStaleSessionRet(undefined, -2, 'unknown error'), true)
assert.equal(isStaleSessionRet(-2, undefined, 'rate limited'), false) // a real rate limit, not stale session
assert.equal(isSessionExpired({}, 0, 0), false)

// --- context_token cache ----------------------------------------------------
saveContextToken(aid, 'conv-1', 'ctx-1')
assert.equal(loadContextToken(aid, 'conv-1'), 'ctx-1')
assert.equal(loadContextToken(aid, 'conv-unknown'), '')

// --- chunkText: short pass-through, long split, natural boundary -------------
assert.deepEqual(chunkText('', 10), [])
assert.deepEqual(chunkText('short', 10), ['short'])
const long = 'aaa bbb ccc ddd eee fff'
const parts = chunkText(long, 10)
assert.ok(parts.length > 1)
assert.ok(parts.every((p) => p.length <= 10), `every chunk <= 10: ${JSON.stringify(parts)}`)
assert.ok(parts.every((p) => !p.startsWith(' ')), `no chunk starts with a space: ${JSON.stringify(parts)}`)
// hard-cut: unbroken string longer than max
const hard = chunkText('x'.repeat(25), 10)
assert.deepEqual(hard, ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])

// --- session-reader: settled reply + turn error -----------------------------
const settled = readAssistantReply({
  events: [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'assistant/message', data: { stream: [{ type: 'text-chunks', texts: ['hel', 'lo'] }] } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ],
})
assert.equal(settled.text, 'hello')
const errored = readAssistantReply({
  events: [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'provider down' } } } },
  ],
})
assert.equal(errored.text, '')
assert.equal(errored.turnError, 'provider down')
// afterSeq filters an older turn
const filtered = readAssistantReply({
  afterSeq: 3,
  events: [
    { seq: 2, type: 'assistant/message', data: { stream: [{ type: 'text-chunks', texts: ['old'] }] } },
    { seq: 4, type: 'assistant/message', data: { stream: [{ type: 'text-chunks', texts: ['new'] }] } },
  ],
})
assert.equal(filtered.text, 'new')

// --- admission: configured list is authoritative; first-contact is opt-in -----
const empty = { senderId: '' }
assert.equal(admission({ allowedSenders: ['a'], firstContact: empty, senderId: 'a' }), 'allow')
assert.equal(admission({ allowedSenders: ['a'], firstContact: empty, senderId: 'b' }), 'deny')
// a configured list disables the first-contact fallback
assert.equal(admission({ allowedSenders: ['a'], firstContact: { senderId: 'z' }, senderId: 'z' }), 'deny')
// empty list: deny by default; first contact only with explicit opt-in
assert.equal(admission({ allowedSenders: [], firstContact: empty, senderId: 'x' }), 'deny')
assert.equal(admission({ allowedSenders: [], firstContact: empty, senderId: 'x', allowFirstContact: true }), 'allow-first')
assert.equal(admission({ allowedSenders: [], firstContact: { senderId: 'x' }, senderId: 'x', allowFirstContact: true }), 'allow')
assert.equal(admission({ allowedSenders: [], firstContact: { senderId: 'x' }, senderId: 'y', allowFirstContact: true }), 'deny')
// undefined list behaves as empty
assert.equal(admission({ allowedSenders: undefined, firstContact: empty, senderId: 'q' }), 'deny')

// --- media: AES-128-ECB, key parsing, padding -------------------------------
const aesKey = crypto.randomBytes(16)
const plaintext = Buffer.from('weixin media payload — 图片', 'utf-8')
const ciphertext = aes128EcbEncrypt(plaintext, aesKey)
assert.equal(ciphertext.length, paddedSize(plaintext.length))
assert.equal(ciphertext.length % 16, 0)
assert.deepEqual(aes128EcbDecrypt(ciphertext, aesKey), plaintext)
assert.equal(paddedSize(0), 16)
assert.equal(paddedSize(16), 32) // PKCS7 always adds a full block
assert.equal(paddedSize(17), 32)

// NIST AES-128 ECB known-answer test (FIPS-197 / SP 800-38A F.1.1):
// the first ciphertext block must match exactly; PKCS7 then adds a full block.
const nistKey = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
const nistPlain = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
const nistCipher = aes128EcbEncrypt(nistPlain, nistKey)
assert.equal(nistCipher.subarray(0, 16).toString('hex'), '69c4e0d86a7b0430d8cdb78070b4c55a')
assert.deepEqual(aes128EcbDecrypt(nistCipher, nistKey), nistPlain)

assert.deepEqual(parseAesKey(aesKey.toString('base64')), aesKey) // base64(raw)
assert.deepEqual(parseAesKey(Buffer.from(aesKey.toString('hex'), 'utf-8').toString('base64')), aesKey) // base64(hex)
assert.throws(() => parseAesKey(Buffer.from('short').toString('base64')), /aes_key/i)
assert.throws(() => parseAesKey(Buffer.from('z'.repeat(32), 'utf-8').toString('base64')), /aes_key/i)

// --- media: SSRF allowlist --------------------------------------------------
assert.doesNotThrow(() => assertSafeMediaUrl('https://novac2c.cdn.weixin.qq.com/c2c/download?x=1'))
assert.doesNotThrow(() => assertSafeMediaUrl('https://mmbiz.qpic.cn/a.png'))
assert.throws(() => assertSafeMediaUrl('http://127.0.0.1:8080/steal'), /allowlist/i)
assert.throws(() => assertSafeMediaUrl('http://169.254.169.254/latest/meta-data'), /allowlist/i)
assert.throws(() => assertSafeMediaUrl('https://evil.example.com/x'), /allowlist/i)
assert.throws(() => assertSafeMediaUrl('file:///etc/passwd'), /scheme/i)
assert.throws(() => assertSafeMediaUrl('not a url'), /Unparseable/i)

// --- media: CDN download + decrypt end-to-end (local server) ----------------
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/download' && url.searchParams.get('encrypted_query_param') === 'q1') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    res.end(ciphertext)
    return
  }
  res.writeHead(404)
  res.end('no')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const localAllow = new Set(['127.0.0.1'])
const fetched = await downloadMedia({
  cdnBaseUrl: `http://127.0.0.1:${port}`,
  encryptedQueryParam: 'q1',
  aesKeyB64: aesKey.toString('base64'),
  allowlist: localAllow,
})
assert.deepEqual(fetched, plaintext)
// without the test allowlist the same URL is refused before any socket opens
await assert.rejects(
  () => downloadMedia({ cdnBaseUrl: `http://127.0.0.1:${port}`, encryptedQueryParam: 'q1' }),
  /allowlist/i,
)
await assert.rejects(
  () => downloadMedia({ cdnBaseUrl: `http://127.0.0.1:${port}`, encryptedQueryParam: 'missing', allowlist: localAllow }),
  /HTTP 404/,
)
server.close()

// --- media: outbound item shapes --------------------------------------------
const imgItem = buildMediaItem({ mime: 'image/png', filename: 'a.png', encryptedQueryParam: 'ep', aesKeyForApi: 'ak', ciphertextSize: 160, plaintextSize: 150 })
assert.equal(imgItem.type, 2)
assert.equal(imgItem.image_item.media.encrypt_query_param, 'ep')
assert.equal(imgItem.image_item.media.aes_key, 'ak')
assert.equal(imgItem.image_item.media.encrypt_type, 1)
assert.equal(imgItem.image_item.mid_size, 160)
const docItem = buildMediaItem({ mime: 'application/pdf', filename: 'a.pdf', encryptedQueryParam: 'ep', aesKeyForApi: 'ak', ciphertextSize: 160, plaintextSize: 150 })
assert.equal(docItem.type, 4)
assert.equal(docItem.file_item.file_name, 'a.pdf')
assert.equal(docItem.file_item.len, '150')
const forced = buildMediaItem({ mime: 'image/png', filename: 'a.png', encryptedQueryParam: 'ep', aesKeyForApi: 'ak', ciphertextSize: 1, plaintextSize: 1, forceFile: true })
assert.equal(forced.type, 4)

assert.equal(guessMime('x.PNG'), 'image/png')
assert.equal(guessMime('x.pdf'), 'application/pdf')
assert.equal(guessMime('x.unknown'), 'application/octet-stream')

// --- media: MEDIA: tag extraction ------------------------------------------
const extracted = extractMedia('先看图\nMEDIA:/tmp/pic.png\n再回复')
assert.deepEqual(extracted.paths, ['/tmp/pic.png'])
assert.equal(extracted.text, '先看图\n再回复')
assert.deepEqual(extractMedia('MEDIA:`/tmp/a b.png` ok').paths, ['/tmp/a b.png'])
assert.deepEqual(extractMedia('MEDIA:"/tmp/a.png"').paths, ['/tmp/a.png'])
assert.deepEqual(extractMedia('MEDIA:/tmp/a.png MEDIA:/tmp/a.png').paths, ['/tmp/a.png'])
assert.deepEqual(extractMedia('no tags here'), { paths: [], text: 'no tags here' })
assert.deepEqual(extractMedia('').paths, [])

// --- media: sendMediaFiles skips missing paths instead of throwing ----------
const mediaSend = await sendMediaFiles({
  baseUrl: 'http://127.0.0.1:1',
  token: 't',
  cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
  to: 'conv',
  paths: [path.join(tmp, 'does-not-exist.png')],
  warn: () => {},
})
assert.equal(mediaSend.sent, 0)
assert.equal(mediaSend.skipped.length, 1)

// --- media: allowlist merges config hosts without widening the built-ins ----
const allow = mediaAllowlist(['CDN.Example.com', 'https://mirror.example.net/x'])
assert.equal(allow.has('novac2c.cdn.weixin.qq.com'), true, 'built-in host kept')
assert.equal(allow.has('cdn.example.com'), true, 'bare host lowercased and added')
assert.equal(allow.has('mirror.example.net'), true, 'URL entry reduced to its host')
assert.equal(allow.has('evil.example'), false)
assert.throws(() => assertSafeMediaUrl('https://evil.example/x', allow), /not in the WeChat CDN allowlist/)
assert.doesNotThrow(() => assertSafeMediaUrl('https://cdn.example.com/x', allow))
assert.throws(() => assertSafeMediaUrl('ftp://novac2c.cdn.weixin.qq.com/x'), /scheme/)

// --- commands: parse + mention + help ---------------------------------------
assert.deepEqual(parseCommand('/help'), { name: 'help', arg: '' })
assert.deepEqual(parseCommand('  /CANCEL  '), { name: 'cancel', arg: '' })
assert.deepEqual(parseCommand('/remind 10m 喝水'), { name: 'remind', arg: '10m 喝水' })
assert.deepEqual(parseCommand('/models'), { name: 'models', arg: '' })
assert.equal(parseCommand('hello /help'), null)
assert.equal(parseCommand(''), null)
assert.equal(isMentioned('@bot 在吗'), true)
assert.equal(isMentioned('  @小鲸 看看'), true)
assert.equal(isMentioned('在吗 @bot'), false)
assert.ok(HELP_TEXT.includes('/cancel') && HELP_TEXT.includes('/help'))

// --- group admission --------------------------------------------------------
assert.equal(groupAdmission({ groupChatEnabled: false, allowedGroups: [], groupId: 'g1' }), 'deny')
assert.equal(groupAdmission({ groupChatEnabled: true, allowedGroups: [], groupId: 'g1' }), 'allow')
assert.equal(groupAdmission({ groupChatEnabled: true, allowedGroups: ['g1'], groupId: 'g1' }), 'allow')
assert.equal(groupAdmission({ groupChatEnabled: true, allowedGroups: ['g1'], groupId: 'g2' }), 'deny')

// --- singleFlight: concurrent callers share one open, and it is retried later --
{
  const map = new Map()
  let opens = 0
  let release
  const gate = new Promise((r) => { release = r })
  const open = async () => { opens += 1; await gate; return 'v' }
  const a = singleFlight(map, 'k', open)
  const b = singleFlight(map, 'k', open)
  await new Promise((r) => setTimeout(r, 0)) // let the deferred open start
  assert.equal(opens, 1, 'only one open while in flight')
  release()
  assert.deepEqual(await Promise.all([a, b]), ['v', 'v'])
  assert.equal(map.size, 0, 'map entry cleared after settle')
  const c = singleFlight(map, 'k', async () => 'w')
  assert.equal(await c, 'w', 'a later call opens again')
}


// --- persona modes ----------------------------------------------------------
const modes = readPersonaStore(tmp)
assert.ok(modes.length >= 2)
assert.equal(resolveMode(modes, 'no-such-mode').id, 'default')
setActiveMode(tmp, 'acct', 'conv', 'girlfriend')
assert.equal(activeModeFor(tmp, 'acct', 'conv', 'default'), 'girlfriend')
assert.match(buildPersonaBlock(resolveMode(modes, 'girlfriend')), /<weixin_persona/u)
assert.equal(isCompanionMode(resolveMode(modes, 'girlfriend')), true)
assert.equal(isCompanionMode(resolveMode(modes, 'default')), false)

// --- life state -------------------------------------------------------------
const life = inferLifeState({ now: new Date('2026-10-28T23:00:00+08:00').getTime(), prior: null, bond: { lastMessageAt: Date.now() - 3_600_000, msgsToday: 5 } })
assert.ok(life.energy >= 5 && life.energy <= 100)
assert.match(lifeBlock(life), /<weixin_life>/u)

// --- companion pacing -------------------------------------------------------
const companionPace = planCompanionReply({ text: '第一句。第二句。第三句。第四句。', mode: { id: 'friend' }, life: { energy: 40 }, config: {}, rng: () => 0.5 })
assert.ok(companionPace.delayMs > 0)
assert.ok(companionPace.bubbles.length >= 1)
const plainPace = planCompanionReply({ text: 'hello', mode: { id: 'default' }, config: {} })
assert.equal(plainPace.delayMs, 0)
assert.deepEqual(plainPace.bubbles, ['hello'])

// --- proactive decision -----------------------------------------------------
const now = Date.now()
assert.equal(planProactive({ now, state: null, lastInboundAt: now - 10 * 3_600_000, config: { proactiveEnabled: false } }).fire, false)
const fire = planProactive({
  now, state: null, lastInboundAt: now - 10 * 3_600_000,
  config: { proactiveEnabled: true, proactiveMinGapMinutes: 180, proactiveMaxPerDay: 3, proactiveWindowStart: '00:00', proactiveWindowEnd: '23:59' },
  rng: () => 0,
})
assert.equal(fire.fire, true)

// --- conversation activity + session lines ---------------------------------
recordConversationInbound('acct2', 'conv2', now)
assert.equal(listConversations().some((row) => row.accountId === 'acct2' && row.conversationId === 'conv2'), true)
recordConversationInbound('acct2', 'group@chatroom', now, true)
assert.equal(listConversations().find((row) => row.conversationId === 'group@chatroom')?.isGroup, true)
assert.equal(activeLine('acct2', 'conv2'), 0)
assert.equal(advanceLine('acct2', 'conv2'), 1)
assert.equal(activeLine('acct2', 'conv2'), 1)


// --- model catalog / /model argument resolution ----------------------------
const fakeLlm = {
  listProviders: () => [{ id: 'p1', name: 'Provider One' }, { id: 'bad', name: 'Broken' }],
  async listModels(id) {
    if (id === 'bad') throw new Error('offline')
    return [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }]
  },
}
const choices = await listModelChoices(fakeLlm)
assert.deepEqual(choices.map(choice => `${choice.provider}/${choice.id}`), ['p1/alpha', 'p1/beta'])
assert.equal(resolveModelChoice(choices, '2').ok && resolveModelChoice(choices, '2').choice.id, 'beta')
assert.equal(resolveModelChoice(choices, 'p1/alpha').ok && resolveModelChoice(choices, 'p1/alpha').choice.id, 'alpha')
assert.equal(resolveModelChoice(choices, 'Alpha').ok && resolveModelChoice(choices, 'Alpha').choice.id, 'alpha')
assert.equal(resolveModelChoice(choices, 'missing').ok, false)
assert.match(formatModelList(choices, { provider: 'p1', model: 'beta' }), /当前模型：p1\/beta/u)


// --- AgentBridge model switching -------------------------------------------
{
  const fakeAgent = {
    session: {
      id: 'session-test',
      requestHeader: () => ({ config: { provider: 'p1', model: 'alpha' } }),
    },
  }
  const calls = []
  const fakeCtx = {
    get: (name) => name === 'sessionController'
      ? { selectModel: async (request) => { calls.push(request); return { selected: { provider: request.provider, model: request.model } } } }
      : undefined,
  }
  const bridge = new AgentBridge({ ctx: fakeCtx, cwd: '/tmp' })
  bridge.sessions.set(AgentBridge.keyOf('acct', 'conv', 0), {
    agent: fakeAgent, handle: {}, busy: Promise.resolve(),
  })
  assert.deepEqual(bridge.modelFor('acct', 'conv'), { provider: 'p1', model: 'alpha' })
  const selected = await bridge.selectModel('acct', 'conv', { provider: 'p1', model: 'beta' })
  assert.deepEqual(selected, { provider: 'p1', model: 'beta' })
  assert.deepEqual(calls[0], { sessionId: 'session-test', provider: 'p1', model: 'beta' })
  assert.deepEqual(bridge.modelFor('acct', 'conv'), { provider: 'p1', model: 'beta' })
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('selfcheck OK')