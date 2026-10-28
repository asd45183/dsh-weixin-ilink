/**
 * Read assistant output back out of a DSH agent session.
 *
 * DSH 0.1.5 removed the durable `assistant/chunk` event, so a reply is read by
 * (1) waiting for the settled `assistant/message` / `assistant/attempt` event,
 * (2) reassembling text from the embedded stream, and (3) surfacing a failed
 * turn (`turn/end` with `reason.kind === 'error'`) so the caller answers the
 * user immediately instead of spinning for the whole wait budget.
 *
 * Ported from the reference channel's session reader; the stream walk mirrors
 * DSH's own snapshot reader.
 * @module dsh-weixin-ilink/session-reader
 */
const SETTLED_TYPES = new Set(['assistant/message', 'assistant/attempt'])

function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/** Reassemble text from an embedded stream record; reasoning is never sent to WeChat. */
export function streamText(stream) {
  if (!Array.isArray(stream)) return ''
  let out = ''
  for (const entry of stream) {
    if (entry?.type === 'text-chunks' && Array.isArray(entry.texts)) {
      out += entry.texts.join('')
    } else if (entry?.type === 'chunk') {
      const chunk = entry.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    }
  }
  return out
}

/**
 * Read the latest settled assistant reply.
 * @param {{ events: readonly any[], afterSeq?: number }} params
 * @returns {{ text: string, settledSeq: number, turnError: (string | undefined) }}
 */
export function readAssistantReply({ events, afterSeq = -1 }) {
  let text = ''
  let settledSeq = -1
  let turnError
  for (const event of events ?? []) {
    if (typeof event?.seq === 'number' && event.seq <= afterSeq) continue
    switch (event?.type) {
      case 'turn/start':
        turnError = undefined
        break
      case 'turn/end': {
        const reason = event.data?.reason
        if (reason?.kind === 'error') {
          const message = reason.error?.message
          turnError = typeof message === 'string' && message !== '' ? message : 'unknown error'
          settledSeq = typeof event.seq === 'number' ? event.seq : settledSeq
        }
        break
      }
      default: {
        if (!SETTLED_TYPES.has(event.type)) break
        const fromStream = streamText(event.data?.stream)
        const body = fromStream !== '' ? fromStream : messageText(event.data?.message)
        if (body !== '') {
          text = body
          settledSeq = typeof event.seq === 'number' ? event.seq : settledSeq
        }
        break
      }
    }
  }
  return { text, settledSeq, turnError }
}
