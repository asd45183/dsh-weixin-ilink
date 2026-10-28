/**
 * Bind one Weixin conversation to one DSH agent session.
 *
 * Pattern (proven by DSH's own headless/webhook entry points): create an agent
 * through `ctx.agents.create({ sessionId, meta, agentOptions, setup })`, admit
 * each user message with `agent.followup(createUserMessage(...))`, wait for
 * `agent.whenIdle()`, and read the reply out of `agent.session.snapshotEvents()`.
 *
 * Minimal: one durable session per conversation, turns serialized per
 * conversation, no presets / no steer / no late-reply channel. `@deepseek-ai/dsh-llm`
 * and `@deepseek-ai/dsh-agent` resolve only inside a DSH profile, so they are
 * imported lazily: the module stays loadable (and testable) outside the host,
 * and a missing service surfaces as a delivery error, not a plugin-load failure.
 * @module dsh-weixin-ilink/agent-bridge
 */
import { createHash } from 'node:crypto'
import { readAssistantReply } from './session-reader.js'
import { singleFlight } from './memo.js'
import { activeLine, advanceLine } from './state.js'

let createUserMessageRef = null
async function loadCreateUserMessage() {
  if (createUserMessageRef === null) {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof mod.createUserMessage !== 'function') {
      throw new Error('@deepseek-ai/dsh-llm does not export createUserMessage')
    }
    createUserMessageRef = mod.createUserMessage
  }
  return createUserMessageRef
}

let installModelSelectionRef
async function loadInstallModelSelection() {
  if (installModelSelectionRef === undefined) {
    try {
      const mod = await import('@deepseek-ai/dsh-agent')
      installModelSelectionRef = typeof mod.installModelSelection === 'function' ? mod.installModelSelection : null
    } catch {
      installModelSelectionRef = null
    }
  }
  return installModelSelectionRef ?? undefined
}

/** Deterministic, filesystem-safe session id for one account's conversation (stable across restarts). */
export function sessionIdFor(accountId, conversationId) {
  const raw = String(conversationId ?? '').replace(/[^A-Za-z0-9]/g, '-').slice(0, 40)
  const hash = createHash('sha256').update(`${accountId ?? ''}\0${conversationId ?? ''}`).digest('hex').slice(0, 10)
  return `weixin-${raw}-${hash}`
}

/** Session id for one line; line 0 keeps the historical id so old history resumes. */
export function sessionIdForLine(accountId, conversationId, line = 0) {
  const base = sessionIdFor(accountId, conversationId)
  return line > 0 ? `${base}--${line}` : base
}

/**
 * Pre-multi-account id shape (conversation only). Kept so a conversation that
 * started life before the account was part of the id still resumes its history
 * instead of opening a parallel empty session.
 */
export function legacySessionIdFor(conversationId) {
  const raw = String(conversationId ?? '').replace(/[^A-Za-z0-9]/g, '-').slice(0, 40)
  const hash = createHash('sha256').update(String(conversationId ?? '')).digest('hex').slice(0, 10)
  return `weixin-${raw}-${hash}`
}

export class AgentBridge {
  /**
   * @param {{ ctx: any, cwd: string, permissionPreset?: string, turnTimeoutMs?: number,
   *           log?: (s: string) => void, errLog?: (s: string) => void }} opts
   */
  constructor({ ctx, cwd, permissionPreset = 'workspace-write', turnTimeoutMs = 600_000, log, errLog }) {
    this.ctx = ctx
    this.cwd = cwd
    this.permissionPreset = permissionPreset
    this.turnTimeoutMs = turnTimeoutMs
    this.log = log ?? (() => {})
    this.errLog = errLog ?? (() => {})
    /** `${accountId}\0${conversationId}` -> { handle, agent, busy, active, cancelledByUser } */
    this.sessions = new Map()
    /** sessionId -> { accountId, conversationId } (for approval forwarding). */
    this.bySession = new Map()
    /** key -> in-flight open, so two messages arriving together cannot each open a session. */
    this.pending = new Map()
  }

  /** Reverse lookup so an approval request for one of our agents reaches the right account + chat. */
  targetForSession(sessionId) {
    return this.bySession.get(String(sessionId ?? ''))
  }

  static keyOf(accountId, conversationId, line = 0) {
    return `${accountId ?? ''}\0${conversationId ?? ''}\0${line}`
  }

  /**
   * Interrupt the running turn for a conversation, if any.
   *
   * `active` is our own flag rather than `agent.status`: a turn that handed
   * work to a background job returns to `idle` immediately, so status would
   * report "nothing to cancel" while the user still expects a cancellation
   * of the step they just started.
   * @returns {boolean} whether a turn was actually running.
   */
  cancel(accountId, conversationId) {
    const line = activeLine(accountId, conversationId)
    const record = this.sessions.get(AgentBridge.keyOf(accountId, conversationId, line))
    if (!record) return false
    if (record.active !== true) return false
    record.cancelledByUser = true
    record.agent.cancel({ kind: 'user' })
    this.log(`cancel requested for conv=${safeId(conversationId)}`)
    return true
  }

  /** The session id the next message will use (for /status). */
  sessionId(accountId, conversationId) {
    return sessionIdForLine(accountId, conversationId, activeLine(accountId, conversationId))
  }

  /**
   * Start a fresh line: dispose the active agent and advance the persisted line
   * number, so the next message creates a new session instead of resuming the
   * old transcript.
   * @returns {{cleared:true,line:number,sessionId:string}|{cleared:false,busy:true}}
   */
  async clear(accountId, conversationId) {
    const line = activeLine(accountId, conversationId)
    const key = AgentBridge.keyOf(accountId, conversationId, line)
    const record = this.sessions.get(key)
    if (record?.active === true) return { cleared: false, busy: true }
    if (record) {
      this.sessions.delete(key)
      this.bySession.delete(String(record.agent.session.id))
      try {
        await record.handle.dispose()
      } catch (error) {
        this.errLog(`session dispose failed: ${String(error)}`)
      }
    }
    const nextLine = advanceLine(accountId, conversationId)
    return { cleared: true, line: nextLine, sessionId: sessionIdForLine(accountId, conversationId, nextLine) }
  }

  /**
   * Compose a fresh agent scope: install the model selection, then mount the
   * deployment's default agent preset so the conversation inherits the same
   * tools and system prompt a GUI thread gets. Without the preset mount the
   * agent is created bare (only the built-in working-directory tool).
   */
  async #compose(agentCtx, selection) {
    const install = await loadInstallModelSelection()
    if (install) install(agentCtx, { current: selection, assembled: undefined })
    const presets = this.ctx.get('agentPresets')
    if (presets?.resolve && presets?.mount) {
      try {
        const resolved = await presets.resolve(undefined) // undefined = configured default
        await presets.mount(agentCtx, resolved.id)
      } catch (error) {
        this.errLog(`agent preset mount failed (agent runs without deployed tools): ${String(error)}`)
      }
    }
  }

  async #ensureAgent(accountId, conversationId) {
    const line = activeLine(accountId, conversationId)
    const key = AgentBridge.keyOf(accountId, conversationId, line)
    const existing = this.sessions.get(key)
    if (existing) return existing
    // Two messages can arrive in one long-poll batch. Without single-flight both
    // callers see "no agent yet" and open their own session — measured once:
    // `123` landed in a brand-new session while `345` resumed the real history.
    return singleFlight(this.pending, key, () => this.#openAgent(key, accountId, conversationId, line))
  }

  async #openAgent(key, accountId, conversationId, line) {
    const agents = this.ctx.get('agents')
    if (!agents?.create) throw new Error('agents service unavailable')
    const models = this.ctx.get('agentDefaultModel')
    const selection = models?.currentSelection?.() ?? { provider: '', model: '' }
    const sessionId = sessionIdForLine(accountId, conversationId, line)
    const legacyId = legacySessionIdFor(conversationId)
    const agentOptions = selection.provider && selection.model
      ? { provider: selection.provider, model: selection.model }
      : undefined
    const setup = (agentCtx) => this.#compose(agentCtx, selection)
    /** Try each persisted id in order; undefined means "not on disk". */
    const tryResume = async (id) => {
      try {
        return await agents.resume({ resumeSessionId: id, ...(agentOptions ? { agentOptions } : {}), setup })
      } catch {
        return undefined
      }
    }
    // 1) this account's own session, 2) the pre-multi-account id (history
    // migration), 3) a fresh session.
    let handle = await tryResume(sessionId)
    let resumed = handle !== undefined
    if (handle === undefined && line === 0 && legacyId !== sessionId) {
      handle = await tryResume(legacyId)
      resumed = handle !== undefined
    }
    handle ??= await agents.create({ sessionId, meta: { cwd: this.cwd }, ...(agentOptions ? { agentOptions } : {}), setup })
    const record = { handle, agent: handle.agent, busy: Promise.resolve() }
    this.sessions.set(key, record)
    this.bySession.set(String(handle.agent.session.id), { accountId, conversationId })
    // Apply the configured permission preset (sandbox + approval policy) so a
    // WeChat session can write where it needs to; `workspace-write` keeps the
    // default and still requires approval for wider writes.
    try {
      this.ctx.get('permissionPresets')?.set(handle.agent.session, this.permissionPreset)
    } catch (error) {
      this.errLog(`permission preset "${this.permissionPreset}" failed: ${String(error)}`)
    }
    this.log(`agent ${resumed ? 'resumed' : 'created'} for account=${safeId(accountId)} conv=${safeId(conversationId)} line=${line} session=${handle.agent.session.id} preset=${this.permissionPreset}`)
    return record
  }

  /**
   * Deliver one inbound message and return the assistant reply text.
   * Turns are serialized per conversation so a reply cannot interleave with
   * the next user message.
   * @returns {Promise<{ text: string, error?: string }>}
   */
  async deliver({ accountId, conversationId, text }) {
    const record = await this.#ensureAgent(accountId, conversationId)
    const previous = record.busy
    let release
    record.busy = new Promise((resolve) => { release = resolve })
    await previous.catch(() => {})
    try {
      const createUserMessage = await loadCreateUserMessage()
      const afterSeq = record.agent.session.seq
      record.active = true
      record.cancelledByUser = false
      record.agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      let timer
      const idle = record.agent.whenIdle()
      const timedOut = await Promise.race([
        idle.then(() => false),
        new Promise((resolve) => { timer = setTimeout(() => resolve(true), this.turnTimeoutMs) }),
      ])
      clearTimeout(timer)
      record.active = false
      if (timedOut) {
        record.agent.cancel({ kind: 'user' })
        this.errLog(`turn timed out after ${this.turnTimeoutMs}ms for conv=${safeId(conversationId)}; cancelled`)
        return { text: '', error: `本轮超过 ${Math.round(this.turnTimeoutMs / 1000)}s,已自动取消` }
      }
      if (record.cancelledByUser === true) {
        record.cancelledByUser = false
        // The user already got "已请求取消"; do not also send the partial reply.
        return { text: '', cancelled: true }
      }
      const events = record.agent.session.snapshotEvents()
      const { text: reply, turnError } = readAssistantReply({ events, afterSeq })
      if (turnError !== undefined) {
        this.errLog(`turn failed for conv=${safeId(conversationId)}: ${turnError}`)
        return { text: '', error: turnError }
      }
      return { text: reply }
    } finally {
      record.active = false
      release()
    }
  }

  /** Tear down every session this bridge created. */
  async dispose() {
    const records = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(records.map(async ({ handle }) => {
      try {
        await handle.dispose()
      } catch (error) {
        this.errLog(`session dispose failed: ${String(error)}`)
      }
    }))
  }
}

function safeId(value) {
  const raw = String(value ?? '').trim()
  return raw ? raw.slice(0, 8) : '?'
}
