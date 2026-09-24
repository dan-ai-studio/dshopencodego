// Probe 2: where can per-model protocol (chat-completions / responses / messages) come from?
const out = (label, value) => console.log(`\n=== ${label} ===\n${value}`)

// 1. models.dev provider-level object, and whether any model carries a protocol hint
try {
  const all = JSON.parse(await (await fetch('https://models.dev/api.json')).text())
  const go = all['opencode-go']
  const { models, ...providerLevel } = go
  out('models.dev opencode-go provider-level', JSON.stringify(providerLevel, null, 2))
  const keyUnion = new Set()
  for (const model of Object.values(models)) for (const key of Object.keys(model)) keyUnion.add(key)
  out('models.dev model key union', [...keyUnion].join(', '))
  const hinted = Object.entries(models).filter(([, model]) => 'api' in model || 'provider' in model || 'npm' in model)
  out('models with protocol-ish fields', JSON.stringify(hinted.map(([id]) => id)))
} catch (error) {
  out('models.dev', `failed: ${String(error)}`)
}

// 2. pi-ai's own generated catalog (newest release): per-model api + baseUrl
for (const version of ['0.85.1', '0.87.1']) {
  try {
    const url = `https://unpkg.com/@earendil-works/pi-ai@${version}/dist/providers/data/opencode-go.json`
    const response = await fetch(url)
    if (!response.ok) { out(`pi-ai ${version} catalog`, `HTTP ${response.status}`); continue }
    const catalog = await response.json()
    const lines = []
    for (const [api, models] of Object.entries(catalog)) lines.push(`${api} (${Object.keys(models).length}): ${Object.keys(models).join(', ')}`)
    out(`pi-ai ${version} opencode-go catalog`, lines.join('\n'))
  } catch (error) {
    out(`pi-ai ${version} catalog`, `failed: ${String(error)}`)
  }
}

// 3. Does the gateway itself accept a model on the "wrong" protocol? (unauthenticated → expect 401, tells us nothing about routing)
for (const path of ['chat/completions', 'responses', 'messages']) {
  try {
    const response = await fetch(`https://opencode.ai/zen/go/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-opencode-session': '00000000-0000-4000-8000-000000000000' },
      body: JSON.stringify(path === 'messages'
        ? { model: 'deepseek-v4.1-flash', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
        : { model: 'deepseek-v4.1-flash', max_output_tokens: 1, input: 'hi' }),
    })
    out(`gateway ${path} without key`, `HTTP ${response.status} :: ${(await response.text()).slice(0, 200)}`)
  } catch (error) {
    out(`gateway ${path}`, `failed: ${String(error)}`)
  }
}
