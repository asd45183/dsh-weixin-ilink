import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-admin-'))
process.env.DSH_WEIXIN_OWN_STATE_DIR = root
const { WeixinAdmin, recordRecentSender } = await import('../src/admin.js')

const admin = new WeixinAdmin({ config: { allowedSenders: [], allowFirstContact: false, groupChatEnabled: false, mediaEnabled: true, imageAsFile: true, typingIndicator: true, proactiveEnabled: false, groupReplyWhen: 'mention', permissionPreset: 'workspace-write', workspace: '' } })

test('保存白名单与开关并写入 0600 覆盖文件', () => {
  const state = admin.save({ allowedSenders: ['wxid_abc12345', 'o9cq803lly72mVhVU3Ts_bz2w2W0@im.wechat'], allowFirstContact: true, groupReplyWhen: 'all' })
  assert.deepEqual(state.settings.allowedSenders, ['wxid_abc12345', 'o9cq803lly72mVhVU3Ts_bz2w2W0@im.wechat'])
  assert.equal(state.settings.groupReplyWhen, 'all')
  const file = path.join(root, 'settings.json')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.allowFirstContact, true)
  assert.equal((fs.statSync(file).mode & 0o777), 0o600)
})

test('拒绝非法 id 和未知字段，不覆盖已有记录', () => {
  const before = fs.readFileSync(path.join(root, 'settings.json'), 'utf8')
  assert.throws(() => admin.save({ allowedSenders: ['bad id!'] }), /格式不正确/)
  assert.throws(() => admin.save({ unknownKey: true }), /不支持的设置项/)
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), before)
})

test('最近发送者去重并保留时间，状态不含 token 字段', () => {
  recordRecentSender('acc@im.bot', 'wxid_abc12345', false)
  recordRecentSender('acc@im.bot', 'wxid_new99999', true)
  recordRecentSender('acc@im.bot', 'wxid_abc12345', false)
  const state = admin.status()
  assert.equal(state.senders.filter(row => row.senderId === 'wxid_abc12345').length, 1)
  assert.equal(state.senders[0].senderId, 'wxid_abc12345')
  assert.equal(state.senders[1].isGroup, true)
  const serialized = JSON.stringify(state)
  assert.ok(!/token/i.test(serialized))
})

test('退出未知账号返回 404 而不是删除其他记录', () => {
  assert.throws(() => admin.logout('not-exists@im.bot'), error => error.status === 404)
})

test('清理临时状态目录', () => {
  fs.rmSync(root, { recursive: true, force: true })
})
