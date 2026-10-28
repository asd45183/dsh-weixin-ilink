/**
 * Model catalog + `/model` argument resolution.
 *
 * The Host LLM registry is the source of truth: providers own model ids and
 * display names. Selection itself is installed by the session controller
 * (`agents.selectForNextRequest`), so this module stays pure and testable.
 * @module dsh-weixin-ilink/model-catalog
 */

/** @typedef {{ provider: string, providerName: string, id: string, name: string }} ModelChoice */

/**
 * List every model currently routable in this deployment.
 * Provider failures are isolated: one bad provider must not hide the rest.
 * @param {{ listProviders(): Array<{id:string,name:string}>, listModels(id:string): Promise<Array<{id:string,name:string}>> }} llm
 * @returns {Promise<ModelChoice[]>}
 */
export async function listModelChoices(llm) {
  const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
  const choices = []
  for (const provider of providers) {
    let models
    try {
      models = await llm.listModels(provider.id)
    } catch {
      continue
    }
    for (const model of models) {
      if (typeof model?.id !== 'string' || model.id === '') continue
      choices.push({
        provider: provider.id,
        providerName: provider.name ?? provider.id,
        id: model.id,
        name: model.name ?? model.id,
      })
    }
  }
  return choices
}

/**
 * Resolve one `/model` argument against the current choices.
 * Accepted forms: 1-based index, `provider/model`, exact model id, exact name.
 * @param {ModelChoice[]} choices
 * @param {string} raw
 * @returns {{ ok: true, choice: ModelChoice } | { ok: false, reason: string }}
 */
export function resolveModelChoice(choices, raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { ok: false, reason: '缺少模型参数' }
  if (/^\d+$/.test(text)) {
    const index = Number(text) - 1
    if (!Number.isInteger(index) || index < 0 || index >= choices.length) {
      return { ok: false, reason: `序号超出范围（1–${choices.length}）` }
    }
    return { ok: true, choice: choices[index] }
  }
  const lower = text.toLowerCase()
  const exact = choices.filter((choice) => `${choice.provider}/${choice.id}`.toLowerCase() === lower)
  if (exact.length === 1) return { ok: true, choice: exact[0] }
  const byId = choices.filter((choice) => choice.id.toLowerCase() === lower)
  if (byId.length === 1) return { ok: true, choice: byId[0] }
  const byName = choices.filter((choice) => choice.name.toLowerCase() === lower)
  if (byName.length === 1) return { ok: true, choice: byName[0] }
  if (byId.length > 1 || byName.length > 1) {
    return { ok: false, reason: `「${text}」匹配到多个模型，请用 provider/model 指定` }
  }
  return { ok: false, reason: `没有找到「${text}」` }
}

/**
 * Render a compact model list for WeChat.
 * @param {ModelChoice[]} choices
 * @param {{provider:string,model:string}|null} current
 * @param {number} [limit]
 * @returns {string}
 */
export function formatModelList(choices, current, limit = 20) {
  if (choices.length === 0) return '当前没有可用模型。'
  const head = current === null || current === undefined
    ? '当前模型：默认'
    : `当前模型：${current.provider}/${current.model}`
  const shown = choices.slice(0, Math.max(1, limit))
  const lines = shown.map((choice, index) => {
    const active = current !== null && current !== undefined
      && current.provider === choice.provider && current.model === choice.id
    return `${active ? '→' : '　'}${index + 1}. ${choice.provider}/${choice.id} — ${choice.name}`
  })
  const tail = choices.length > shown.length ? [`… 还有 ${choices.length - shown.length} 个，可用 /model provider/model 指定`] : []
  return [head, '可用模型：', ...lines, ...tail, '用法：/model <序号|provider/model|模型名>'].join('\n')
}
