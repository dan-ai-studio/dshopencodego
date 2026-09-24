// Verify: what the newest published pi-ai actually ships, and what DSH publishes as its pin.
const out = (label, value) => console.log(`\n=== ${label} ===\n${value}`)
const json = async url => {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return response.json()
}
const text = async url => {
  const response = await fetch(url)
  return { status: response.status, body: response.ok ? await response.text() : '' }
}

// 1. published versions of pi-ai
const pi = await json('https://registry.npmjs.org/@earendil-works%2Fpi-ai')
const times = pi.time
const versions = Object.keys(pi.versions).filter(v => !v.includes('-'))
const latest = pi['dist-tags'].latest
out('pi-ai dist-tags', JSON.stringify(pi['dist-tags']))
out('pi-ai last 8 stable versions', versions.slice(-8).map(v => `${v} (${times[v]?.slice(0, 10)})`).join('\n'))
out('pi-ai latest', `${latest} published ${times[latest]}`)

// 2. does latest ship the opencode session-header wrapper, and does it cover all three protocols?
const headers = await text(`https://unpkg.com/@earendil-works/pi-ai@${latest}/dist/providers/opencode-headers.js`)
out(`opencode-headers.js @ ${latest}`, `HTTP ${headers.status}\n${headers.body.slice(0, 1500)}`)
const goProvider = await text(`https://unpkg.com/@earendil-works/pi-ai@${latest}/dist/providers/opencode-go.js`)
out(`opencode-go.js @ ${latest}`, `HTTP ${goProvider.status}\n${goProvider.body.slice(0, 1200)}`)

// 3. is the wrapper publicly exported from the package root?
const rootTypes = await text(`https://unpkg.com/@earendil-works/pi-ai@${latest}/dist/index.d.ts`)
out('root index.d.ts exports (opencode/withOpenCodeSession mentions)', rootTypes.body.split('\n').filter(line => /opencode|SessionHeader|sessionAffinity/i.test(line)).join('\n') || '(none)')
const pkg = await json(`https://unpkg.com/@earendil-works/pi-ai@${latest}/package.json`)
out('pi-ai exports map', JSON.stringify(pkg.exports, null, 2))

// 4. catalog freshness in latest
const catalog = await json(`https://unpkg.com/@earendil-works/pi-ai@${latest}/dist/providers/data/opencode-go.json`)
out(`opencode-go catalog @ ${latest}`, Object.entries(catalog).map(([api, models]) => `${api} (${Object.keys(models).length}): ${Object.keys(models).join(', ')}`).join('\n'))

// 5. what DSH publishes as its own pin
for (const name of ['@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh']) {
  try {
    const meta = await json(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
    const tags = meta['dist-tags']
    const versionsAll = Object.keys(meta.versions)
    const latestPublished = tags.latest
    const dependency = meta.versions[latestPublished]?.dependencies?.['@earendil-works/pi-ai']
      ?? meta.versions[latestPublished]?.peerDependencies?.['@earendil-works/pi-ai']
    out(name, `dist-tags=${JSON.stringify(tags)}\nlatest=${latestPublished} (${meta.time[latestPublished]?.slice(0, 10)})\npi-ai range on latest=${dependency}\nlast 5 versions=${versionsAll.slice(-5).join(', ')}`)
  } catch (error) {
    out(name, `failed: ${String(error)}`)
  }
}
