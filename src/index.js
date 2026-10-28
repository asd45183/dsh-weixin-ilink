/**
 * dsh-weixin-ilink — Weixin iLink channel plugin for DeepSeek Harness.
 *
 * Bidirectional loop: long-poll inbound (text + media) → deny-by-default
 * allowlist → dedupe → DSH agent session (one per conversation) → chunked text
 * reply + uploaded images/files, echoing the peer's context_token.
 *
 * Media: inbound images/files are downloaded from the WeChat CDN (AES-128-ECB,
 * SSRF-allowlisted) into `~/.dsh/weixin-own/media/<conv>/` and handed to the
 * agent as `[附件 …] /abs/path` lines; outbound the agent emits
 * `MEDIA:/abs/path` tags which are uploaded and sent as IMAGE/FILE items.
 *
 * TODO: settings card (in-GUI QR login); resume-after-restart currently
 * re-creates the session in memory, so history resets per conversation on
 * plugin reload.
 *
 * Protocol ported from a clean first-party Python adapter (hermes weixin.py):
 * iLink Bot API, random X-WECHAT-UIN, 0600 token, no telemetry, no readLinks.
 * @module dsh-weixin-ilink
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { admission, groupAdmission } from './admission.js'
import { HELP_TEXT, isMentioned, parseCommand } from './commands.js'
import {
  ILINK_BASE_URL,
  CDN_BASE_URL,
  getUpdates,
  getConfig,
  sendTyping,
  TYPING_START,
  TYPING_STOP,
  normalizeInbound,
  isSessionExpired,
  MAX_CONSECUTIVE_FAILURES,
  RETRY_DELAY_MS,
  BACKOFF_DELAY_MS,
  LONG_POLL_TIMEOUT_MS,
} from './transport/ilink.js'
import {
  loadAccount,
  listAccountIds,
  loadSyncBuf,
  saveSyncBuf,
  loadContextToken,
  saveContextToken,
  ensureSessionsDir,
  ensureMediaDir,
  stateDir,
  activeLine,
  recordConversationInbound,
  listConversations,
  loadProactivePreference,
  saveProactivePreference,
} from './state.js'
import { AgentBridge } from './agent-bridge.js'
import {
  DEFAULT_MODE_ID,
  activeModeFor,
  buildPersonaBlock,
  readPersonaStore,
  resolveMode,
  setActiveMode,
} from './persona.js'
import { isCompanionMode, planCompanionReply, buildHumanStyleBlock } from './human-pace.js'
import { lifeBlock, lifeSummary, readOrInferLifeState } from './life-state.js'
import { ProactiveScheduler, describePlan } from './proactive.js'
import { formatModelList, listModelChoices, resolveModelChoice } from './model-catalog.js'
import { TrustStore, parseTrustDuration } from './trust.js'
import { extractMedia, sendReply, sendMediaFiles } from './outbound.js'
import { CDN_ALLOWLIST, downloadMedia, mediaAllowlist } from './media.js'

export const name = 'dsh-weixin-ilink'

export const inject = ['agents', 'agentDefaultModel']

export const Config = z.object({
  enabled: z.boolean().default(true).description('Start the Weixin long-poll loop when the plugin loads.'),
  accountId: z.string().default('').description('Bound Weixin account id; empty uses the only saved account.'),
  allowedSenders: z.array(z.string()).default([]).description('Weixin user ids allowed to drive the agent. Empty denies everyone unless allowFirstContact is true.'),
  allowFirstContact: z.boolean().default(false).description('When allowedSenders is empty, allow the first sender once for setup. Keep false for a public bot.'),
  maxMessageLength: z.number().default(2000).description('Max characters per outbound Weixin message.'),
  mediaEnabled: z.boolean().default(true).description('Download/decrypt inbound media and send outbound MEDIA: files.'),
  cdnBaseUrl: z.string().default('').description('Weixin CDN root for media. Empty uses the upstream default.'),
  mediaTimeoutMs: z.number().default(120_000).description('Timeout for one CDN download/upload (ms).'),
  mediaAllowedHosts: z.array(z.string()).default([]).description('Extra hostnames allowed for media fetch (e.g. a private CDN mirror). Empty = the WeChat CDN allowlist only.'),
  imageAsFile: z.boolean().default(true).description('Send images as file attachments; false sends image bubbles (requires mediaType IMAGE, fixed in 0.5.7).'),
  personaDefaultMode: z.string().default('default').description('Default persona mode for chats that have not picked one with /mode. "default" is the plain assistant.'),
  lifeState: z.boolean().default(true).description('Inject the deterministic life-state block (mood/energy/activity) in companion modes.'),
  humanPacing: z.boolean().default(true).description('Companion modes delay the first bubble and split long replies into 2-3 WeChat bubbles.'),
  replyDelayMaxMs: z.number().default(2400).description('Upper bound for the pre-reply delay in companion modes (ms).'),
  bubbleSplitMax: z.number().default(3).description('Maximum WeChat bubbles per companion reply.'),
  bubbleGapMs: z.number().default(700).description('Base pause between bubbles in companion modes (ms).'),
  proactiveEnabled: z.boolean().default(false).description('Let companion modes send an occasional message first (off by default).'),
  proactiveMinGapMinutes: z.number().default(180).description('Minimum minutes since the user last spoke before a proactive message.'),
  proactiveMaxPerDay: z.number().default(3).description('Maximum proactive messages per account per day.'),
  proactiveWindowStart: z.string().default('09:00').description('Proactive-message window start, HH:mm.'),
  proactiveWindowEnd: z.string().default('23:00').description('Proactive-message window end, HH:mm.'),
  permissionPreset: z.string().default('workspace-write').description('Permission preset applied to each WeChat agent: "workspace-write" (default; wider writes need approval) or "danger-full-access" (no approval, full disk).'),
  turnTimeoutMs: z.number().default(600_000).description('Cancel a turn that runs longer than this (ms).'),
  approvalTimeoutMs: z.number().default(300_000).description('How long a WeChat approval prompt waits for a y/n reply before failing closed (ms).'),
  typingIndicator: z.boolean().default(true).description('Show "typing…" in WeChat while the agent works (best-effort).'),
  progressAfterMs: z.number().default(20_000).description('Send one "still working" note if a turn runs longer than this (ms); 0 disables.'),
  groupChatEnabled: z.boolean().default(false).description('Serve group chats (off by default). Senders are still checked against allowedSenders.'),
  groupReplyWhen: z.union([z.const('mention'), z.const('all')]).default('mention').description('In a group, answer only messages that start with @ (mention) or every message (all).'),
  allowedGroups: z.array(z.string()).default([]).description('Group ids allowed when groups are on. Empty = every group (mentions still required).'),
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DEDUP_TTL_MS = 300_000
const CANCEL_COMMAND = '/cancel'
const HOST_COMMANDS = new Set(['plan', 'permission', 'goal', 'feedback', 'export'])
const APPROVE_WORDS = new Set(['y', 'yes', 'ok', 'approve', '批准', '同意', '允许', '是'])
const REJECT_WORDS = new Set(['n', 'no', 'reject', '拒绝', '不同意', '否'])

/**
 * @param {any} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  const log = (line) => ctx.logger?.info?.(`dsh-weixin-ilink: ${line}`)
  const warn = (line) => ctx.logger?.warn?.(`dsh-weixin-ilink: ${line}`)
  const errLog = (line) => ctx.logger?.error?.(`dsh-weixin-ilink: ${line}`)

  if (config.enabled === false) {
    log('disabled by configuration; registering no loop')
    return
  }

  const wanted = config.accountId?.trim() ?? ''
  const accountIds = wanted !== '' ? [wanted] : listAccountIds()
  const accounts = new Map()
  for (const id of accountIds) {
    const acc = loadAccount(id)
    if (!acc?.token) {
      warn(`account ${id} has no token; skipping — re-run \`node bin/login.js\``)
      continue
    }
    accounts.set(id, acc)
  }
  if (accounts.size === 0) {
    log('no usable Weixin account; run `node bin/login.js` then reload')
    return
  }

  const bridge = new AgentBridge({
    ctx,
    cwd: ensureSessionsDir(),
    permissionPreset: config.permissionPreset,
    turnTimeoutMs: config.turnTimeoutMs,
    log,
    errLog,
  })
  /** accountId -> { dedup, firstContact } — state is per bound account. */
  const perAccount = new Map()
  for (const id of accounts.keys()) perAccount.set(id, { dedup: new Map(), firstContact: { senderId: '' } })
  /** `${accountId}\0${conversationId}\0${line}` -> { settle(outcome) } while an approval is pending. */
  const pendingApprovals = new Map()
  const approvalKey = (accountId, conversationId, line) => `${accountId}\0${conversationId}\0${line}`
  const trust = new TrustStore()

  const sendTo = async (accountId, conversationId, text) => {
    const acc = accounts.get(accountId)
    if (acc === undefined) return
    try {
      await sendReply({
        baseUrl: String(acc.baseUrl || ILINK_BASE_URL).replace(/\/+$/, ''),
        token: acc.token,
        to: conversationId,
        text,
        contextToken: loadContextToken(accountId, conversationId),
        maxLength: config.maxMessageLength,
        warn,
      })
    } catch (error) {
      errLog(`send failed: ${String(error)}`)
    }
  }

  const stateRoot = stateDir()
  const proactiveEnabledNow = () => loadProactivePreference() ?? config.proactiveEnabled

  const resolveConversationMode = (accountId, conversationId) => {
    const modes = readPersonaStore(stateRoot, { warn })
    const modeId = activeModeFor(stateRoot, accountId, conversationId, config.personaDefaultMode, { warn })
    return resolveMode(modes, modeId)
  }

  const proactiveScheduler = new ProactiveScheduler({
    stateRoot,
    config: () => ({ ...config, proactiveEnabled: proactiveEnabledNow() }),
    warn: (line) => warn(line),
    candidates: () => {
      const modes = readPersonaStore(stateRoot, { warn })
      const rows = []
      for (const row of listConversations()) {
        if (!accounts.has(row.accountId)) continue
        // Proactive messages are DM-only and require the sender to still be
        // in the allowlist; a stale conversation must not outlive a removal.
        if (row.isGroup === true || !config.allowedSenders.includes(row.conversationId)) continue
        const modeId = activeModeFor(stateRoot, row.accountId, row.conversationId, config.personaDefaultMode, { warn })
        const mode = resolveMode(modes, modeId)
        if (!isCompanionMode(mode)) continue
        rows.push({ accountId: row.accountId, conversationId: row.conversationId, lastInboundAt: row.lastInboundAt, mode })
      }
      return rows
    },
    fire: async (candidate) => {
      const life = readOrInferLifeState(stateRoot, candidate.accountId, { warn })
      const contextSections = [
        { name: 'weixin-persona', text: buildPersonaBlock(candidate.mode) },
        { name: 'weixin-style', text: buildHumanStyleBlock() },
        { name: 'weixin-life', text: lifeBlock(life) },
        { name: 'weixin-proactive', text: [
          '<weixin_proactive>',
          `现在是 ${new Date().toLocaleString('zh-CN', { hour12: false })}。你已经一段时间没收到对方消息了。主动发一条简短、自然、像在微信上开口的消息；不要提到“主动消息”、系统提示或时间间隔。`,
          '</weixin_proactive>',
        ].join('\n') },
      ].filter((section) => section.text !== '')
      const reply = await bridge.deliver({ accountId: candidate.accountId, conversationId: candidate.conversationId, text: '（主动开口）', contextSections })
      if (reply.error !== undefined) throw new Error(reply.error)
      const { text } = extractMedia(reply.text || '')
      if (!text.trim()) return ''
      await sendTo(candidate.accountId, candidate.conversationId, text)
      return text
    },
  })

  const runCommand = async (accountId, conversationId, command) => {
    if (command.name === 'help') {
      await sendTo(accountId, conversationId, HELP_TEXT)
      return true
    }
    if (command.name === 'status') {
      const mode = resolveConversationMode(accountId, conversationId)
      const life = readOrInferLifeState(stateRoot, accountId, { warn })
      const proactive = proactiveScheduler.status(accountId)
      const sentToday = proactive.day === new Date().toISOString().slice(0, 10) ? proactive.count : 0
      const currentModel = bridge.modelFor(accountId, conversationId)
        ?? ctx.get('agentDefaultModel')?.currentSelection?.()
        ?? null
      await sendTo(accountId, conversationId, [
        `账号：${accountId}`,
        `模型：${currentModel === null ? '未知' : `${currentModel.provider}/${currentModel.model}`}`,
        `模式：${mode.name}（${mode.id}）`,
        `会话：${bridge.sessionId(accountId, conversationId)}`,
        `白名单：${config.allowedSenders.length} 个发送者`,
        life === null ? '' : `状态：${lifeSummary(life)}`,
        `主动消息：${proactiveEnabledNow() === true ? `开启，今天 ${sentToday}/${config.proactiveMaxPerDay}` : '关闭'}`,
      ].filter(Boolean).join('\n'))
      return true
    }
    if (command.name === 'new') {
      const result = await bridge.clear(accountId, conversationId)
      await sendTo(accountId, conversationId, result.cleared === true
        ? `已开启新会话线（第 ${result.line + 1} 条）`
        : '当前有任务在跑，先 /cancel 再 /new')
      return true
    }
    if (command.name === 'list') {
      const { active, lines } = bridge.lines(accountId, conversationId)
      await sendTo(accountId, conversationId, [
        `会话线（当前第 ${active + 1} 条）：`,
        ...lines.map((line) => `${line === active ? '→' : '　'}${line + 1}`),
        '用法：/use <编号> 切换；/new 开新线；/clear 清空当前线',
      ].join('\n'))
      return true
    }
    if (command.name === 'use') {
      const raw = command.arg.trim()
      if (!/^\d+$/.test(raw)) {
        await sendTo(accountId, conversationId, '用法：/use <编号>；先发 /list 查看')
        return true
      }
      const target = Number(raw) - 1
      const result = await bridge.useLine(accountId, conversationId, target)
      if (result.used !== true) {
        await sendTo(accountId, conversationId, result.busy === true
          ? '当前有任务在跑，先 /cancel 再切换'
          : `没有第 ${raw} 条会话线；先发 /list 查看`)
        return true
      }
      await sendTo(accountId, conversationId, `已切到第 ${target + 1} 条会话线，下一条消息生效。`)
      return true
    }
    if (command.name === 'clear') {
      const result = await bridge.clear(accountId, conversationId)
      await sendTo(accountId, conversationId, result.cleared === true
        ? `已清空，下一条消息开始新会话（第 ${result.line + 1} 条线）`
        : '当前有任务在跑，先 /cancel 再 /clear')
      return true
    }
    if (command.name === 'proactive') {
      const arg = command.arg.trim().toLowerCase()
      if (arg === 'on' || arg === 'off') {
        saveProactivePreference(arg === 'on')
        await sendTo(accountId, conversationId, arg === 'on'
          ? `主动消息已开启（${config.proactiveWindowStart}–${config.proactiveWindowEnd}，至少间隔 ${config.proactiveMinGapMinutes} 分钟，每天最多 ${config.proactiveMaxPerDay} 条；仅伴侣模式生效）`
          : '主动消息已关闭')
        return true
      }
      const proactive = proactiveScheduler.status(accountId)
      const sentToday = proactive.day === new Date().toISOString().slice(0, 10) ? proactive.count : 0
      await sendTo(accountId, conversationId, [
        `主动消息：${proactiveEnabledNow() === true ? '开启' : '关闭'}`,
        `窗口：${config.proactiveWindowStart}–${config.proactiveWindowEnd}`,
        `最小间隔：${config.proactiveMinGapMinutes} 分钟；每天最多 ${config.proactiveMaxPerDay} 条`,
        `今天已发：${sentToday}`,
        '用法：/proactive on | /proactive off',
      ].join('\n'))
      return true
    }
    if (command.name === 'trust' || command.name === 'approve') {
      const line = activeLine(accountId, conversationId)
      const key = approvalKey(accountId, conversationId, line)
      const arg = command.arg.trim().toLowerCase()
      if (arg === '' || arg === 'status') {
        const left = trust.remainingMs(key)
        await sendTo(accountId, conversationId, left === 0
          ? '当前会话线未开启免批。用法：/trust 10m（最长 8 小时）'
          : `当前会话线免批剩余 ${Math.ceil(left / 60_000)} 分钟。`)
        return true
      }
      if (arg === 'off' || arg === '关闭') {
        trust.revoke(key)
        await sendTo(accountId, conversationId, '已关闭当前会话线的免批。')
        return true
      }
      const parsed = parseTrustDuration(arg)
      if (parsed.ok !== true) {
        await sendTo(accountId, conversationId, parsed.reason)
        return true
      }
      trust.grant(key, parsed.ms)
      const pending = pendingApprovals.get(key)
      if (pending !== undefined) pending.settle('allowed-once')
      await sendTo(accountId, conversationId, `已开启免批 ${Math.round(parsed.ms / 60_000)} 分钟（仅当前会话线，到期自动恢复审批）。`)
      return true
    }
    if (HOST_COMMANDS.has(command.name)) {
      const line = `/${command.name}${command.arg.trim() === '' ? '' : ` ${command.arg.trim()}`}`
      try {
        const result = await bridge.forwardCommand(accountId, conversationId, line)
        const text = typeof result.text === 'string' && result.text.trim() !== ''
          ? result.text
          : (result.kind === 'success' ? '完成。' : '命令未完成。')
        await sendTo(accountId, conversationId, result.kind === 'error' ? `命令失败：${text}` : text)
      } catch (error) {
        await sendTo(accountId, conversationId, `命令失败：${String(error.message ?? error)}`)
      }
      return true
    }
    if (command.name === 'compact') {
      const arg = command.arg.trim()
      if (arg !== '') {
        await sendTo(accountId, conversationId, '用法：/compact（不带参数）')
        return true
      }
      try {
        const result = await bridge.compact(accountId, conversationId)
        const text = result.text === 'No compactable history yet.'
          ? '还没有可压缩的历史。'
          : result.text === 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.'
            ? '当前有任务在跑或已在压缩，暂时不能压缩。'
            : (result.text ?? (result.kind === 'success' ? '压缩完成。' : '压缩未完成。'))
        await sendTo(accountId, conversationId, result.kind === 'error' ? `压缩失败：${text}` : text)
      } catch (error) {
        await sendTo(accountId, conversationId, `压缩失败：${String(error.message ?? error)}`)
      }
      return true
    }
    if (command.name === 'model' || command.name === 'models') {
      const llm = ctx.get('llm')
      if (typeof llm?.listProviders !== 'function') {
        await sendTo(accountId, conversationId, '模型服务不可用。')
        return true
      }
      const choices = await listModelChoices(llm)
      const current = bridge.modelFor(accountId, conversationId)
        ?? ctx.get('agentDefaultModel')?.currentSelection?.()
        ?? null
      const arg = command.arg.trim()
      const listOnly = command.name === 'models' || arg.toLowerCase() === 'list' || arg === '列表'
      if (listOnly || arg === '') {
        await sendTo(accountId, conversationId, formatModelList(choices, current))
        return true
      }
      if (arg.toLowerCase() === 'default' || arg === '默认') {
        const fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
        if (fallback === undefined) {
          await sendTo(accountId, conversationId, '没有可用的默认模型。')
          return true
        }
        try {
          await bridge.selectModel(accountId, conversationId, fallback)
          await sendTo(accountId, conversationId, `已切回默认模型 ${fallback.provider}/${fallback.model}，下一条消息生效。`)
        } catch (error) {
          await sendTo(accountId, conversationId, `切换失败：${String(error.message ?? error)}`)
        }
        return true
      }
      const matched = resolveModelChoice(choices, arg)
      if (matched.ok !== true) {
        await sendTo(accountId, conversationId, `${matched.reason}\n\n${formatModelList(choices, current)}`)
        return true
      }
      try {
        await bridge.selectModel(accountId, conversationId, {
          provider: matched.choice.provider,
          model: matched.choice.id,
        })
        await sendTo(accountId, conversationId, `已切换到 ${matched.choice.provider}/${matched.choice.id}（${matched.choice.name}），下一条消息生效。`)
      } catch (error) {
        await sendTo(accountId, conversationId, `切换失败：${String(error.message ?? error)}`)
      }
      return true
    }
    if (command.name === 'mode') {
      const modes = readPersonaStore(stateRoot, { warn })
      const currentId = activeModeFor(stateRoot, accountId, conversationId, config.personaDefaultMode, { warn })
      const arg = command.arg.trim()
      if (arg === '') {
        const render = (mode) => `${mode.id === currentId ? '→' : '　'}${mode.id === DEFAULT_MODE_ID ? '默认助手' : mode.name} — /mode ${mode.name || mode.id}`
        await sendTo(accountId, conversationId, `可用模式：\n${modes.map(render).join('\n')}`)
        return true
      }
      const wanted = arg.toLowerCase()
      const match = modes.find((mode) => mode.id.toLowerCase() === wanted
        || mode.name.toLowerCase() === wanted
        || (mode.id === DEFAULT_MODE_ID && wanted === '默认'))
      if (match === undefined) {
        await sendTo(accountId, conversationId, `没有叫「${arg}」的模式。可用：${modes.map((mode) => (mode.id === DEFAULT_MODE_ID ? '默认' : mode.name)).join('、')}`)
        return true
      }
      if (match.id === currentId) {
        await sendTo(accountId, conversationId, `已经是「${match.name}」模式了，没有变化。`)
        return true
      }
      setActiveMode(stateRoot, accountId, conversationId, match.id, { warn })
      const cleared = await bridge.clear(accountId, conversationId)
      await sendTo(accountId, conversationId, match.id === DEFAULT_MODE_ID
        ? `已切回默认助手${cleared.cleared === true ? '，并开启新会话' : '；当前任务结束后下一条生效'}`
        : `已切换到「${match.name}」模式${cleared.cleared === true ? '，并开启新会话' : '；当前任务结束后下一条生效'}`)
      return true
    }
    return false
  }

  /** Prompt the chat for an approval and wait for its y/n reply (or the timeout, which fails closed). */
  function requestApproval(accountId, conversationId, line, request) {
    const key = approvalKey(accountId, conversationId, line)
    return new Promise((resolve) => {
      let settled = false
      let timer
      const settle = (outcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        pendingApprovals.delete(key)
        resolve(outcome)
      }
      timer = setTimeout(() => {
        log(`approval timed out for conv=${safeId(conversationId)}`)
        settle('unavailable')
      }, config.approvalTimeoutMs)
      request.signal?.addEventListener?.('abort', () => settle('cancelled'), { once: true })
      pendingApprovals.set(key, { settle })
      const reason = String(request.reason ?? '').trim()
      void sendTo(accountId, conversationId, `🔐 需要审批（第 ${line + 1} 条线）\n工具: ${request.toolName}\n${reason ? `原因: ${reason}\n` : ''}\n回复 y 批准(仅本次) / n 拒绝`)
    })
  }

  // Forward approval requests raised by OUR agents to their WeChat chat. Other
  // sessions (the GUI) pass through to their own answerers.
  ctx.on('approval/request', (request, next) => {
    const target = bridge.targetForSession(request.agent?.session?.id)
    if (target === undefined) return next()
    const line = target.line ?? 0
    if (trust.active(approvalKey(target.accountId, target.conversationId, line))) {
      return Promise.resolve('allowed-once')
    }
    return requestApproval(target.accountId, target.conversationId, line, request)
  })

  ctx.effect(() => {
    const abort = new AbortController()
    let running = true
    proactiveScheduler.start()
    for (const [accountId, account] of accounts) {
      void runAccount({
        ctx, config, accountId, account, state: perAccount.get(accountId), bridge, abort,
        isRunning: () => running, log, warn, errLog, sendTo, pendingApprovals, approvalKey,
        stateRoot, proactiveScheduler, runCommand,
      })
    }
    return () => {
      running = false
      abort.abort()
      proactiveScheduler.stop()
      void bridge.dispose()
    }
  })
}

/**
 * One long-poll loop for one bound account. `state` holds the per-account
 * dedupe cache and first-contact record; every send/cancel is account-scoped so
 * two accounts cannot answer through each other.
 */
async function runAccount({ ctx, config, accountId, account, state, bridge, abort, isRunning, log, warn, errLog, sendTo, pendingApprovals, approvalKey, stateRoot, proactiveScheduler, runCommand }) {
  const baseUrl = String(account.baseUrl || ILINK_BASE_URL).replace(/\/+$/, '')
  let syncBuf = loadSyncBuf(accountId)
  let timeoutMs = LONG_POLL_TIMEOUT_MS
  let consecutiveFailures = 0
  log(`listening as account ${accountId} on ${baseUrl}`)
  while (isRunning() && !abort.signal.aborted) {
    let resp
    try {
      resp = await getUpdates({ baseUrl, token: account.token, syncBuf, timeoutMs, abortSignal: abort.signal })
    } catch (err) {
      if (!isRunning()) break
      consecutiveFailures += 1
      warn(`getUpdates failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err?.message ?? err}`)
      await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS)
      consecutiveFailures = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? 0 : consecutiveFailures
      continue
    }
    if (!isRunning()) break
    const ret = resp.ret ?? 0
    const errcode = resp.errcode ?? 0
    if (ret !== 0 || errcode !== 0) {
      if (isSessionExpired(resp, ret, errcode)) {
        warn(`session expired (errcode=${errcode}); polling stopped — re-run \`node bin/login.js\``)
        break
      }
      consecutiveFailures += 1
      warn(`getUpdates ret=${ret} errcode=${errcode} errmsg=${resp.errmsg ?? ''} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`)
      await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS)
      consecutiveFailures = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? 0 : consecutiveFailures
      continue
    }
    consecutiveFailures = 0
    if (typeof resp.longpolling_timeout_ms === 'number' && resp.longpolling_timeout_ms > 0) {
      timeoutMs = resp.longpolling_timeout_ms
    }
    const nextBuf = resp.get_updates_buf
    if (typeof nextBuf === 'string' && nextBuf && nextBuf !== syncBuf) {
      syncBuf = nextBuf
      saveSyncBuf(accountId, syncBuf)
    }
    for (const raw of Array.isArray(resp.msgs) ? resp.msgs : []) {
      const msg = normalizeInbound(raw, accountId)
      if (msg === null) continue
      // Admission/group gate runs before approvals, /cancel and local commands:
      // otherwise a non-allowlisted sender could cancel, approve or toggle
      // account-wide settings without ever driving an agent turn.
      if (!admitInbound({ config, firstContact: state.firstContact, msg, log, warn })) continue
      saveContextToken(accountId, msg.conversationId, msg.contextToken)

      // A pending approval owns the next message: answer it instead of
      // feeding the text to the agent (the turn is blocked on this). This
      // check runs BEFORE dedupe, because two approvals may both be
      // answered with the same word inside one dedupe window.
      const pending = pendingApprovals.get(approvalKey(accountId, msg.conversationId, activeLine(accountId, msg.conversationId)))
      if (pending !== undefined) {
        const word = msg.text.trim().toLowerCase()
        if (APPROVE_WORDS.has(word)) {
          pending.settle('allowed-once')
          await sendTo(accountId, msg.conversationId, '✅ 已批准(仅本次)')
          continue
        }
        if (REJECT_WORDS.has(word)) {
          pending.settle('rejected')
          await sendTo(accountId, msg.conversationId, '⛔ 已拒绝')
          continue
        }
        await sendTo(accountId, msg.conversationId, '等待审批中:回复 y 批准 / n 拒绝')
        continue
      }

      // `/cancel` bypasses the per-conversation queue so it can interrupt a
      // running turn (a queued message would wait for that turn to finish).
      if (msg.text.trim().toLowerCase() === CANCEL_COMMAND) {
        const hadTurn = bridge.cancel(accountId, msg.conversationId)
        await sendTo(accountId, msg.conversationId, hadTurn ? '⏹ 已请求取消当前任务' : '当前没有运行中的任务')
        continue
      }

      // Local commands (/help /status /clear /mode) never reach the agent.
      const command = parseCommand(msg.text)
      if (command !== null && await runCommand(accountId, msg.conversationId, command)) continue

      if (isDuplicate(state.dedup, msg)) {
        log(`dedupe skip conv=${safeId(msg.conversationId)}`)
        continue
      }

      void handleInbound({ ctx, config, account, accountId, bridge, msg, log, warn, errLog, sendTo, stateRoot, proactiveScheduler })
    }
  }
  log(`poll loop stopped for account ${accountId}`)
  return
}


/** One gate for every path: agent, approvals, /cancel and local commands. */
function admitInbound({ config, firstContact, msg, log, warn }) {
  const verdict = admission({
    allowedSenders: config.allowedSenders,
    firstContact,
    senderId: msg.senderId,
    allowFirstContact: config.allowFirstContact === true,
  })
  if (verdict === 'deny') {
    warn(`inbound from ${safeId(msg.senderId)} denied (not allowed)`)
    return false
  }
  if (verdict === 'allow-first') {
    firstContact.senderId = msg.senderId
    warn(`allowlist empty — first contact ${msg.senderId} auto-allowed for this run; add it to allowedSenders to persist`)
  }
  if (msg.isGroup === true) {
    const gate = groupAdmission({
      groupChatEnabled: config.groupChatEnabled,
      allowedGroups: config.allowedGroups,
      groupId: msg.groupId,
    })
    if (gate === 'deny') {
      log(`group ${safeId(msg.groupId)} ignored (groups off or not allowed)`)
      return false
    }
  }
  return true
}

/**
 * Download + decrypt every inbound media reference into a per-message folder.
 * Returns `[{ path, kind }]` for files that landed and `[{ kind, error }]` for
 * ones that did not, so the agent still gets told a download failed.
 */
async function materializeInboundMedia({ config, msg, warn }) {
  const media = Array.isArray(msg.media) ? msg.media : []
  if (media.length === 0) return { files: [] }
  const cdnBaseUrl = String(config.cdnBaseUrl || CDN_BASE_URL).replace(/\/+$/, '')
  const allowlist = mediaAllowlist(config.mediaAllowedHosts)
  const dir = ensureMediaDir(msg.conversationId, msg.id || String(Date.now()))
  const files = []
  for (let index = 0; index < media.length; index += 1) {
    const ref = media[index]
    try {
      const data = await downloadMedia({
        cdnBaseUrl,
        encryptedQueryParam: ref.encryptedQueryParam,
        fullUrl: ref.fullUrl,
        aesKeyB64: ref.aesKeyB64,
        timeoutMs: config.mediaTimeoutMs,
        allowlist,
      })
      const filename = inboundFilename(ref, index, data)
      const file = path.join(dir, filename)
      fs.writeFileSync(file, data, { mode: 0o600 })
      files.push({ path: file, kind: ref.kind, bytes: data.length })
      warn?.(`inbound media saved kind=${ref.kind} bytes=${data.length}`)
    } catch (error) {
      warn?.(`inbound media download failed kind=${ref.kind}: ${String(error)}`)
      files.push({ kind: ref.kind, error: String(error) })
    }
  }
  return { files }
}

const KIND_LABELS = { image: '图片', file: '文件', voice: '语音', video: '视频' }

/** Magic-byte extension sniff (the CDN sends no useful content-type). */
function sniffExtension(data) {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return '.png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return '.jpg'
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return '.gif'
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return '.webp'
  return '.bin'
}

/** Keep the peer filename when it is safe, else synthesize one from kind + magic. */
function inboundFilename(ref, index, data) {
  const ext = sniffExtension(data)
  const name = String(ref.filename ?? '').replace(/[\\/]/g, '_').replace(/^\.+/, '').trim()
  if (name) return name.slice(0, 120)
  return `${ref.kind || 'media'}-${index}${ext}`
}

/** conversation key for the typing-ticket cache. */
const typingTickets = new Map()

function baseOf(account) {
  return String(account.baseUrl || ILINK_BASE_URL).replace(/\/+$/, '')
}

/** Fetch (and cache) the typing ticket for one peer; empty when unavailable. */
async function typingTicketFor({ account, accountId, userId }) {
  const key = `${accountId}\u0000${userId}`
  const cached = typingTickets.get(key)
  if (cached !== undefined) return cached
  const resp = await getConfig({
    baseUrl: baseOf(account),
    token: account.token,
    userId,
    contextToken: loadContextToken(accountId, userId),
    timeoutMs: 8_000,
  })
  const ticket = String(resp?.typing_ticket ?? '')
  if (ticket !== '') typingTickets.set(key, ticket)
  return ticket
}

/** Show or clear the typing indicator. Cosmetic: never throws, never blocks a turn. */
async function setTyping({ account, accountId, userId, status }) {
  try {
    const ticket = await typingTicketFor({ account, accountId, userId })
    if (ticket === '') return
    await sendTyping({ baseUrl: baseOf(account), token: account.token, userId, typingTicket: ticket, status, timeoutMs: 8_000 })
  } catch {
    // typing is decoration; a failure must not affect delivery
  }
}

/**
 * Drive the agent for one inbound message and send the reply back.
 * The admission gate (see ./admission.js) runs first and is deny-by-default.
 */
async function handleInbound({ ctx, config, account, accountId, bridge, msg, log, warn, errLog, sendTo, stateRoot, proactiveScheduler }) {
  if (msg.isGroup === true) {
    if (config.groupReplyWhen === 'mention' && !isMentioned(msg.text)) {
      log(`group ${safeId(msg.groupId)} ignored (no @ mention)`)
      return
    }
  }
  log(`inbound from=${safeId(msg.senderId)} conv=${safeId(msg.conversationId)} len=${msg.text.length} media=${msg.media?.length ?? 0}`)
  const bond = recordConversationInbound(accountId, msg.conversationId, Date.now(), msg.isGroup === true)
  proactiveScheduler?.noteInbound(accountId)
  const modes = readPersonaStore(stateRoot, { warn })
  const activeModeId = activeModeFor(stateRoot, accountId, msg.conversationId, config.personaDefaultMode, { warn })
  const mode = resolveMode(modes, activeModeId)
  const companion = isCompanionMode(mode)
  const life = companion && config.lifeState !== false
    ? readOrInferLifeState(stateRoot, accountId, { bond, warn })
    : null
  const personaBlock = buildPersonaBlock(mode)
  const styleBlock = companion ? buildHumanStyleBlock() : ''
  const lifeBlockText = life === null ? '' : lifeBlock(life)

  // Media first: the agent should see the caption and the attachment paths in
  // one prompt. A failed download degrades to a note, not a dropped message.
  const { files } = config.mediaEnabled === false
    ? { files: [] }
    : await materializeInboundMedia({ config, msg, warn })
  const attachmentLines = files.map((file) => {
    if (file.error !== undefined) return `[附件下载失败:${KIND_LABELS[file.kind] ?? file.kind}] ${file.error}`
    return `[附件 ${KIND_LABELS[file.kind] ?? file.kind}] ${file.path} (${file.bytes} bytes)`
  })
  if (config.mediaEnabled === false && (msg.media?.length ?? 0) > 0) {
    attachmentLines.push('[附件] 媒体功能已禁用,未下载')
  }
  // Without this hint the agent has no reason to emit `MEDIA:` and outbound
  // images never fire; it costs one short line per turn.
  const mediaHint = config.mediaEnabled === false
    ? ''
    : '（发图片/文件时，在回复中单独一行写 MEDIA:/绝对路径，插件会上传发送；图片用 PNG/JPG。）'
  const contextSections = [
    { name: 'weixin-persona', text: personaBlock },
    { name: 'weixin-style', text: styleBlock },
    { name: 'weixin-life', text: lifeBlockText },
    { name: 'weixin-attachments', text: attachmentLines.join('\n') },
    { name: 'weixin-media-hint', text: mediaHint },
  ].filter((section) => section.text !== '')
  const userText = msg.text.trim() !== ''
    ? msg.text
    : (attachmentLines.length > 0 ? '（附件）' : '（空消息）')

  // Cosmetic typing indicator + a single "still working" note for long turns.
  const typingUser = msg.senderId
  if (config.typingIndicator !== false) {
    void setTyping({ account, accountId, userId: typingUser, status: TYPING_START })
  }
  let progressTimer
  if (config.progressAfterMs > 0) {
    progressTimer = setTimeout(() => {
      void sendTo(accountId, msg.conversationId, '⏳ 还在处理中，完成后把结果发你')
    }, config.progressAfterMs)
  }

  let reply
  try {
    reply = await bridge.deliver({ accountId, conversationId: msg.conversationId, text: userText, contextSections })
  } catch (error) {
    errLog(`agent delivery failed: ${String(error)}`)
    return
  } finally {
    clearTimeout(progressTimer)
    if (config.typingIndicator !== false) {
      void setTyping({ account, accountId, userId: typingUser, status: TYPING_STOP })
    }
  }
  if (reply.cancelled === true) {
    // The user already got the "已请求取消" acknowledgement; send nothing more.
    return
  }
  if (reply.error !== undefined) {
    await sendReply({
      baseUrl: String(account.baseUrl || ILINK_BASE_URL).replace(/\/+$/, ''),
      token: account.token,
      to: msg.conversationId,
      text: `⚠️ 本轮失败:${reply.error}`,
      contextToken: loadContextToken(accountId, msg.conversationId),
      maxLength: config.maxMessageLength,
      warn,
    })
    return
  }
  if (!reply.text) return

  // Outbound: `MEDIA:/path` tags become uploaded IMAGE/FILE messages.
  const { paths, text } = extractMedia(reply.text)
  const baseUrl = String(account.baseUrl || ILINK_BASE_URL).replace(/\/+$/, '')
  const contextToken = loadContextToken(accountId, msg.conversationId)
  const pacing = planCompanionReply({ text, mode, life, config })
  if (pacing.delayMs > 0) await sleep(pacing.delayMs)
  let sent = 0
  for (let index = 0; index < pacing.bubbles.length; index += 1) {
    const bubble = pacing.bubbles[index]
    if (!bubble.trim()) continue
    const result = await sendReply({
      baseUrl,
      token: account.token,
      to: msg.conversationId,
      text: bubble,
      contextToken,
      maxLength: config.maxMessageLength,
      warn,
    })
    if (result.error !== undefined) {
      errLog(`reply send failed: ${result.error}`)
      return
    }
    sent += result.sent
    if (index < pacing.bubbles.length - 1 && pacing.gapMs > 0) await sleep(pacing.gapMs)
  }
  log(`reply sent to conv=${safeId(msg.conversationId)} chunks=${sent}`)

  if (paths.length > 0 && config.mediaEnabled !== false) {
    const mediaResult = await sendMediaFiles({
      baseUrl,
      token: account.token,
      cdnBaseUrl: String(config.cdnBaseUrl || CDN_BASE_URL).replace(/\/+$/, ''),
      to: msg.conversationId,
      paths,
      contextToken,
      imageAsFile: config.imageAsFile,
      warn,
    })
    log(`media sent to conv=${safeId(msg.conversationId)} count=${mediaResult.sent} skipped=${mediaResult.skipped.length}`)
  }
}

/** Dedupe signature: text + the media references (two bare images are distinct). */
function fingerprint(msg) {
  const mediaKey = (msg.media ?? [])
    .map((ref) => `${ref.kind}:${ref.encryptedQueryParam || ref.fullUrl}`)
    .sort()
    .join('|')
  return createHash('md5').update(`${msg.senderId}\0${msg.conversationId}\0${msg.text}\0${mediaKey}`).digest('hex')
}

function isDuplicate(dedup, msg) {
  const now = Date.now()
  for (const [key, ts] of dedup) if (now - ts > DEDUP_TTL_MS) dedup.delete(key)
  const fp = fingerprint(msg)
  if (dedup.has(fp)) return true
  dedup.set(fp, now)
  return false
}

/** Truncate ids in logs (never log a full account/peer id). */
function safeId(value) {
  const raw = String(value ?? '').trim()
  return raw ? raw.slice(0, 8) : '?'
}
