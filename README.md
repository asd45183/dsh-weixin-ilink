# dsh-weixin-ilink

Weixin iLink channel plugin for DeepSeek Harness — text, media, persona modes, companion pacing and proactive messages.

> **Package rename (0.7.0):** this publishes as `dsh-weixin-ilink`. The profile row id stays `dsh-weixin-own`, and state stays in `~/.dsh/weixin-own`, so existing accounts and sessions keep working.
>
> **Security change (0.7.0):** an empty `allowedSenders` now denies everyone. If you upgrade with an empty list, set `allowFirstContact: true` for one setup message or add your id to `allowedSenders`.
>
> **Risk:** iLink is a reverse-engineered personal-WeChat protocol, not an official Tencent bot API. Bind a spare account; account restrictions are possible. No telemetry, no `readLinks`.

## Status — bidirectional loop with approvals and cancel

- [x] QR login (terminal): `node bin/login.js`
- [x] Long-poll inbound text
- [x] Deny-by-default allowlist (`allowFirstContact: true` opt-in for first-run setup)
- [x] Session-expired / backoff handling
- [x] Agent bridge (one session per conversation, serialized turns, resume after restart)
- [x] Full toolset (mounts the deployment's default agent preset)
- [x] Outbound reply (chunk + context_token echo)
- [x] Dedup (iLink re-sends identical text under new ids)
- [x] `permissionPreset` config (`workspace-write` default, `danger-full-access` opt-in)
- [x] `/cancel` + per-turn timeout (`turnTimeoutMs`)
- [x] Approval forwarding: a tool that needs approval asks the chat, `y`/`n` answers it
- [x] Inbound media: image/file/voice/video → CDN download + AES-128-ECB decrypt (SSRF allowlist), saved under `~/.dsh/weixin-own/media/` and handed to the agent as attachment paths (download+decrypt verified against a live inbound picture)
- [x] Outbound media: `MEDIA:/path` tags in a reply → CDN upload + send (images default to FILE attachments; `imageAsFile: false` sends bubbles)
- [x] `/help`, `/status`, `/clear`, `/proactive` (answered locally, never reach the agent)
- [x] `/mode` persona modes (default assistant + 11 companion modes) with per-conversation overrides
- [x] Life-state block (mood/energy/activity) and companion pacing (first-bubble delay + 2–3 bubbles)
- [x] Persona/style/life/attachment hints are injected as hidden context; the visible user message stays clean
- [x] Proactive messages (off by default; companion modes only; window/min-gap/backoff/daily cap)
- [x] Typing indicator (best-effort, `typingIndicator`)
- [x] "Still working" note for long turns (`progressAfterMs`)
- [x] Group chats (`groupChatEnabled` + `allowedGroups` + `groupReplyWhen: mention|all`)
- [x] Multiple accounts: every saved account gets its own long-poll loop; sessions, dedupe, approvals and first-contact are all account-scoped
- [ ] Settings card (in-GUI QR login)

## What it is

A DSH cordis bundle that turns a bound personal WeChat account (via Tencent's iLink Bot API) into a remote control surface for a DSH agent. Protocol ported from a clean first-party Python adapter — same endpoints, same AES key handling, same random `X-WECHAT-UIN` (not the real UIN), `0600` credential storage.

## Network egress (complete)

- `https://ilinkai.weixin.qq.com` — API (login QR, long-poll, send, getUploadUrl, config, typing)
- `https://novac2c.cdn.weixin.qq.com/c2c` — media CDN (download + upload)

Nothing else. Every media URL — including a peer-supplied `full_url` — is checked
against an explicit WeChat CDN host allowlist before a socket is opened, so an
inbound message cannot make the bridge fetch internal addresses (SSRF). No
telemetry, no analytics, no `readLinks` (your IP never goes to URLs you receive).

## Media

**Inbound.** An image/file/voice/video item is downloaded from the CDN with its
`encrypt_query_param` (or allowlisted `full_url`), decrypted with AES-128-ECB +
PKCS7, and written to `~/.dsh/weixin-own/media/<conversation>/<message>/`. The
agent sees the caption (may be empty) plus one line per attachment:

```
[附件 图片] /Users/you/.dsh/weixin-own/media/<conv>/<msg>/image-0.png (12345 bytes)
```

A failed download becomes `[附件下载失败:图片] <reason>` instead of dropping the
message. Set `mediaEnabled: false` to turn the whole path off.

**Outbound.** The agent writes a local file and puts a `MEDIA:` tag on its own
line in the reply:

```
已经画好了，见下图。
MEDIA:/tmp/chart.png
```

The tag is stripped from the visible text, the file is uploaded to the CDN
(AES-128-ECB, `getUploadUrl` → `x-encrypted-param`) and sent as an IMAGE item
for `image/*` or a FILE item otherwise. Missing paths are skipped with a warning
rather than failing the reply. `cdnBaseUrl` overrides the CDN root.

## Known limitations (measured)

**`image_item` needs `media_type: 1` on `getUploadUrl`.** `mediaTypeFor` used to
infer images only from an explicit MIME type, and `uploadMedia` called it without
one, so PNG/JPEG uploads were registered as FILE (3). The client accepted the
image item (`message_id` returned) but showed "expired or cleaned". `mediaTypeFor`
now also infers IMAGE/VIDEO from the file extension; measured against a live
account on 2026-10-28, a 3.9 KB PNG renders as an image bubble with that fix.
Images still default to a file attachment (`imageAsFile: true`); set
`imageAsFile: false` to send bubbles.

**Persona/pacing/proactive are companion-only.** The stock `default` mode never
gets a life block, a first-bubble delay, split bubbles, or proactive messages.
`/clear` opens a fresh line; `/list` and `/use` (multi-line switching) are not
ported yet. `proactiveEnabled` is off by default; `/proactive on` writes a
runtime override under `~/.dsh/weixin-own/proactive.json`.

**The iLink session expires after a quiet period.** Every send then answers
`ret: -2, errmsg: "prepare failed"`, including plain text — so "the image never
arrived" is often "nothing was sent". The first retry drops `context_token`;
receiving a fresh message from the user restores the session.

## Layout

```
src/
  index.js            — DSH plugin entry: Config + apply + poll loop + dedup + media wiring
  state.js            — ~/.dsh/weixin-own/accounts/<id>.json (0600) + sync buf + context tokens + media dirs
  agent-bridge.js     — one DSH agent session per conversation; followup → whenIdle → reply
  session-reader.js   — read settled assistant reply out of snapshotEvents()
  persona.js          — persona mode catalog + per-conversation overrides + prompt block
  life-state.js       — deterministic mood/activity/energy snapshot + prompt block
  human-pace.js       — companion first-bubble delay + reply splitting
  proactive.js        — proactive decision rules + scheduler
  quiet-hours.js      — HH:mm window parsing
  media.js            — AES-128-ECB CDN download/upload + SSRF allowlist
  outbound.js         — chunkText + sendReply + `MEDIA:` extraction + media send
  transport/
    ilink.js          — iLink API: getUpdates/sendMessage/sendItemMessage/getUploadUrl/getConfig/sendTyping/QR
bin/
  login.js            — terminal QR login
test/
  selfcheck.mjs       — assert self-check (state, normalizeInbound, chunkText, media crypto/SSRF/CDN, session-reader)
cordis.patch.yml      — profile insert row
```

## Install into a DSH profile

```sh
# from this package dir
cd dsh-weixin-ilink
# link or publish; then in the profile:
dsh plugin --profile web add dsh-weixin-ilink   # or add to profile package.json dsh.profile.bundles
```

## Use

```sh
# 1. bind a WeChat account (scan with WeChat)
node bin/login.js

# 2. first-run setup only: set allowFirstContact: true, send one message,
#    copy the full sender id from the warn line, then add it and turn the flag off:
#      config:
#        allowFirstContact: false
#        allowedSenders: ["wxid_xxx"]

# 3. reload DSH; send a message to the bound account from WeChat.
#    The plugin drives one DSH agent session per conversation and replies with
#    the assistant text (chunked, echoing context_token).
#    Logs: dsh-weixin-ilink: inbound from=<id> conv=<id> len=...  →  reply sent ... chunks=N
```

The plugin injects `agents` + `agentDefaultModel`, so it uses the profile's
default model route. The agent's `cwd` is `~/.dsh/weixin-own/sessions/`, so every
WeChat conversation groups together in the GUI, separate from the deployment cwd.

### Chat commands

| Send | Effect |
|---|---|
| `/cancel` | interrupt the running turn (bypasses the per-conversation queue) |
| `/model` | list models; `/model 2` or `/model provider/model` switches for the next request |
| `/models` | list only; `/model list` is an alias |
| `/mode` | list persona modes; `/mode 女友` switches (and opens a new line) |
| `/status` | account, mode, session id, allowlist count, life state, proactive status |
| `/trust [10m\|off]` | temporarily skip approval prompts on this session line (max 8h, in-memory) |
| `/plan` `/permission` `/goal` `/feedback` `/export` | forwarded to the host's own DSH commands |
| `/new` | open a fresh session line |
| `/list` | list session lines |
| `/use <n>` | switch to an existing line |
| `/compact` | compact older history now (same as the Web `/compact`) |
| `/clear` | clear the current context and open a fresh line |
| `/proactive on\|off` | toggle proactive messages for this account |
| `y` / `n` | answer a pending approval prompt (`批准`/`拒绝` also work) |

### Config keys

| Key | Default | Meaning |
|---|---|---|
| `allowedSenders` | `[]` | Weixin ids allowed to drive the agent; empty denies unless `allowFirstContact` is true |
| `allowFirstContact` | `false` | first-run setup only: allow the first sender once so you can copy its id into `allowedSenders` |
| `permissionPreset` | `workspace-write` | `danger-full-access` lets a WeChat message write the whole disk with no approval — trusted account only |
| `turnTimeoutMs` | `600000` | cancel a turn running longer than this |
| `approvalTimeoutMs` | `300000` | approval prompt waits this long, then fails closed (`unavailable`) |
| `typingIndicator` | `true` | show "typing…" while the agent works (best-effort) |
| `progressAfterMs` | `20000` | send one "still working" note after this long; `0` disables |
| `groupChatEnabled` | `false` | serve group chats (senders are still checked against `allowedSenders`) |
| `groupReplyWhen` | `mention` | in a group, answer only messages starting with `@` (`all` answers everything) |
| `allowedGroups` | `[]` | group ids that may drive the agent when groups are on; empty = any group |
| `personaDefaultMode` | `default` | default mode; `default` is the plain assistant |
| `lifeState` | `true` | inject mood/activity/energy in companion modes |
| `humanPacing` | `true` | delay the first bubble and split companion replies into 2–3 bubbles |
| `replyDelayMaxMs` | `2400` | upper bound for the pre-reply delay |
| `bubbleSplitMax` | `3` | max bubbles per companion reply |
| `bubbleGapMs` | `700` | base pause between bubbles |
| `proactiveEnabled` | `false` | allow companion modes to speak first |
| `proactiveMinGapMinutes` | `180` | minimum gap since the user's last message |
| `proactiveMaxPerDay` | `3` | daily proactive cap per account |
| `proactiveWindowStart` / `End` | `09:00` / `23:00` | proactive window (local `HH:mm`) |

### Multiple accounts

Every account in `~/.dsh/weixin-own/accounts/accounts.json` is served
concurrently; set `accountId` to serve exactly one. Each account keeps its own
sync cursor, dedupe window, first-contact record and approval prompts.

Session ids include the account (`weixin-<conv>-<hash(account,conv)>`), so two
accounts talking to the same peer never share one agent session. A conversation
that predates this split still resumes its old session: the bridge tries the
per-account id, then the legacy conversation-only id, then creates a new
session.

Approval forwarding: when one of *our* agents raises `approval/request`, the
plugin sends the tool name and reason to the chat and waits for `y`/`n`. GUI
sessions are untouched (the listener calls `next()` for them). A timed-out
prompt resolves `unavailable`, so the action fails closed rather than silently
proceeding.

## Marketplace

Prepared for the DSH plugin-market index format 1:

- npm package: `dsh-weixin-ilink`
- source: <https://github.com/asd45183/dsh-weixin-ilink>
- `engines.dsh`: `>=0.2.1-alpha.4 <0.3.0`
- community index: <https://polang233.github.io/dsh-plugin-index/index.json>
- listing request: <https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml>

The package declares `dsh.bundle.patch` and ships `cordis.patch.yml`. A public
source repository and an npm release are required by the index maintainers;
this README and `NOTICE` cover the license and the 0.9.8 MIT attribution.

## Attribution

`persona.js`, `life-state.js`, `human-pace.js`, `proactive.js` and
`quiet-hours.js` are ported from [`dsh-plugin-weixin@0.9.8`](https://github.com/panqing0313/dsh-plugin-weixin)
(MIT). The transport, media and agent bridge remain the minimal first-party
implementation in this package.

## Security notes

- Credential (`token`) stored `0600` at `~/.dsh/weixin-own/accounts/<id>.json`.
- `X-WECHAT-UIN` is a random uint32 per request, not the real WeChat UIN.
- Token goes only to the iLink/WeChat HTTPS origin that issued it (`*.weixin.qq.com`), as `Authorization: Bearer`.
- IDs are truncated to 8 chars in logs; the opt-in first-contact setup hint is the one exception. Message bodies are not logged.
- iLink Bot API is a reverse-engineered personal-WeChat protocol (not a Tencent-official bot API). Bind a spare account, not your main one.
