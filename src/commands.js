/**
 * Slash-command parsing and the help text.
 *
 * Kept free of DSH imports so it is loadable and testable outside a profile.
 * @module dsh-weixin-ilink/commands
 */

/** Commands the chat can send. `/cancel` is handled before the queue; the rest are answered directly. */
export const HELP_TEXT = [
  '可用命令：',
  '/help —— 显示这份帮助',
  '/cancel —— 中断当前正在跑的轮次',
  '/model —— 查看/切换模型；/model 2 或 /model provider/model',
  '/mode —— 查看人格模式；/mode 女友 切换模式',
  '/status —— 账号、模式、会话、白名单、主动消息状态',
  '/clear —— 清空当前会话，下一条消息开新会话',
  '/proactive —— 查看主动消息；/proactive on|off 开关',
  '',
  '其它说明：',
  '· 直接发文字就是给 agent 的指令',
  '· 发图片/文件会保存到本地并交给 agent 读取',
  '· 需要审批时会收到「🔐 需要审批」，回 y 批准、n 拒绝',
  '· agent 回复里带 MEDIA:/绝对路径 时会自动发送图片或文件',
  '· 伴侣模式下会延迟首条、拆成 2–3 条气泡；默认助手不分条不延迟',
].join('\n')

/**
 * Split one message into a command name and its argument.
 * @param {unknown} text
 * @returns {{ name: string, arg: string } | null} null when the text is not a command
 */
export function parseCommand(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('/')) return null
  const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (match === null) return null
  return { name: match[1].toLowerCase(), arg: (match[2] ?? '').trim() }
}

/** Whether a group message addresses the bot (the first non-space character is `@`). */
export function isMentioned(text) {
  return /^\s*@/.test(String(text ?? ''))
}
