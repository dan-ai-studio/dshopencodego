// Probe 4: for gateway models pi-ai 0.87.1 does not know, what exactly is missing?
const out = (label, value) => console.log(`\n=== ${label} ===\n${value}`)
const gateway = (await (await fetch('https://opencode.ai/zen/go/v1/models')).json()).data.map(entry => entry.id)
const dev = JSON.parse(await (await fetch('https://models.dev/api.json')).text())['opencode-go']
const pi = await (await fetch('https://unpkg.com/@earendil-works/pi-ai@0.87.1/dist/providers/data/opencode-go.json')).json()
const known = new Set(Object.values(pi).flatMap(models => Object.keys(models)))

const rows = []
for (const id of gateway) {
  if (known.has(id)) continue
  const model = dev.models[id]
  if (model === undefined) { rows.push({ id, verdict: 'ABSENT from models.dev' }); continue }
  const npm = model.provider?.npm ?? dev.npm
  const api = npm === '@ai-sdk/anthropic' ? 'anthropic-messages'
    : npm === '@ai-sdk/openai' ? 'openai-responses'
      : npm === '@ai-sdk/openai-compatible' ? 'openai-completions' : `UNMAPPED(${npm})`
  const missing = []
  if (typeof model.reasoning !== 'boolean') missing.push('reasoning')
  if (!Array.isArray(model.modalities?.input) || !model.modalities.input.includes('text')) missing.push('modalities.input')
  if (!Number.isSafeInteger(model.limit?.context) || model.limit.context <= 0) missing.push('limit.context')
  if (!Number.isSafeInteger(model.limit?.output) || model.limit.output <= 0) missing.push('limit.output')
  rows.push({ id, api, status: model.status ?? 'ok', missing: missing.join(',') || '—' })
}
out('gateway models unknown to pi-ai 0.87.1', rows.map(r =>
  `${(r.id ?? '').padEnd(26)} api=${String(r.api ?? '').padEnd(20)} status=${String(r.status ?? '').padEnd(11)} missing=${r.missing ?? ''}${r.verdict ?? ''}`).join('\n'))

// Which of them would v0.1.13 actually disable (its rules: api resolvable AND reasoning boolean AND limits positive AND text modality)?
const disabled = rows.filter(r => r.missing !== '—' || r.verdict !== undefined)
out('would be configurationMissing under v0.1.13 rules', disabled.length === 0 ? '(none)' : disabled.map(r => r.id).join(', '))
out('resolvable via models.dev alone', rows.filter(r => r.missing === '—' && r.verdict === undefined).map(r => r.id).join(', '))
