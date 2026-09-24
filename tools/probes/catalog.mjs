// Throwaway probe: what does the OpenCode Go gateway actually advertise?
const out = (label, value) => console.log(`\n=== ${label} ===\n${value}`)

try {
  const response = await fetch('https://opencode.ai/zen/go/v1/models', { headers: { accept: 'application/json' } })
  const text = await response.text()
  out('gateway /zen/go/v1/models', `status=${response.status} type=${response.headers.get('content-type')} bytes=${text.length}\n${text.slice(0, 1200)}`)
  try {
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed) ? parsed : (parsed.data ?? parsed.models ?? [])
    out('gateway model count', String(list.length))
    out('gateway first entry (full)', JSON.stringify(list[0], null, 2))
    out('gateway ids', list.map(entry => entry?.id ?? entry).join(', '))
  } catch (error) {
    out('gateway parse', `failed: ${String(error)}`)
  }
} catch (error) {
  out('gateway fetch', `failed: ${String(error)}`)
}

try {
  const response = await fetch('https://models.dev/api.json', { headers: { accept: 'application/json' } })
  const text = await response.text()
  out('models.dev/api.json', `status=${response.status} bytes=${text.length}`)
  const all = JSON.parse(text)
  const go = all['opencode-go'] ?? all['opencode']
  if (go === undefined) {
    out('models.dev opencode-go', `absent; providers sample: ${Object.keys(all).slice(0, 20).join(', ')}`)
  } else {
    const models = go.models ?? {}
    const ids = Object.keys(models)
    out('models.dev opencode-go', `provider keys=${Object.keys(go).join(',')} models=${ids.length}`)
    out('models.dev sample model', JSON.stringify(models[ids[0]], null, 2))
    out('models.dev has deepseek-v4.1-flash', String(ids.includes('deepseek-v4.1-flash')))
    out('models.dev ids', ids.join(', '))
  }
} catch (error) {
  out('models.dev fetch', `failed: ${String(error)}`)
}
