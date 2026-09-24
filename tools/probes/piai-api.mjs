// Verify: does 0.87.1 keep every symbol our plugin/DSH imports? Any removals vs 0.85.1?
const symbols = [
  'getSupportedThinkingLevels', 'createProvider', 'Models', 'MutableModels', 'Provider', 'Model',
  'Api', 'ModelThinkingLevel', 'ThinkingLevel', 'SimpleStreamOptions', 'AuthContext', 'CredentialStore',
  'streamSimple', 'calculateCost',
]
const out = (label, value) => console.log(`\n=== ${label} ===\n${value}`)
const fetchText = async url => {
  const response = await fetch(url)
  return response.ok ? await response.text() : `HTTP ${response.status}`
}

for (const version of ['0.85.1', '0.87.1']) {
  const index = await fetchText(`https://unpkg.com/@earendil-works/pi-ai@${version}/dist/index.d.ts`)
  const all = await fetchText(`https://unpkg.com/@earendil-works/pi-ai@${version}/dist/providers/all.d.ts`)
  const models = await fetchText(`https://unpkg.com/@earendil-works/pi-ai@${version}/dist/models.d.ts`)
  const haystack = `${index}\n${all}\n${models}`
  out(`pi-ai ${version} symbol check`, symbols.map(name =>
    `${haystack.includes(name) ? 'ok  ' : 'MISS'} ${name}`).join('\n'))
  out(`pi-ai ${version} providers/all exports`, (all.match(/export[^\n]*/g) ?? []).join('\n'))
  out(`pi-ai ${version} root export lines (first 25)`, index.split('\n').filter(line => line.startsWith('export')).slice(0, 25).join('\n'))
}

// Breaking-change signals: does 0.87.1 still type streamSimple options with headers + sessionId?
const types = await fetchText('https://unpkg.com/@earendil-works/pi-ai@0.87.1/dist/types.d.ts')
out('0.87.1 SimpleStreamOptions-ish shape', types.split('\n').filter(line => /sessionId|headers\?|maxRetries|thinkingBudgets|cacheRetention|transport\?/.test(line)).slice(0, 20).join('\n'))
