// Probe 3: the "unknown protocol" set, and whether a family rule could cover it.
const out = (label, value) => console.log(`\n=== ${label} ===\n${value}`)

const gateway = (await (await fetch('https://opencode.ai/zen/go/v1/models')).json()).data.map(entry => entry.id)
const modelsDev = JSON.parse(await (await fetch('https://models.dev/api.json')).text())['opencode-go'].models
const pi = await (await fetch('https://unpkg.com/@earendil-works/pi-ai@0.87.1/dist/providers/data/opencode-go.json')).json()

const piApi = new Map()
for (const [api, models] of Object.entries(pi)) for (const id of Object.keys(models)) piApi.set(id, api)

out('counts', `gateway=${gateway.length} models.dev=${Object.keys(modelsDev).length} pi-ai 0.87.1=${piApi.size}`)

out('gateway models with NO protocol metadata anywhere', gateway.filter(id => !piApi.has(id)).join(', '))
out('gateway ∩ pi-ai', gateway.filter(id => piApi.has(id)).length + ' models')
out('models.dev-only (not on gateway)', Object.keys(modelsDev).filter(id => !gateway.includes(id)).join(', '))

out('family -> api rule check (pi-ai catalog)', Object.entries(pi).map(([api, models]) =>
  `${api}: ${Object.keys(models).map(id => id.split('-')[0]).join(' ')}`).join('\n'))

out('models.dev entries carrying provider/status', JSON.stringify(
  Object.fromEntries(Object.entries(modelsDev)
    .filter(([, model]) => 'provider' in model || 'status' in model)
    .map(([id, model]) => [id, { provider: model.provider, status: model.status, npm: model.npm }])), null, 2))

out('sample full models.dev entry (glm-5)', JSON.stringify(modelsDev['glm-5'], null, 2))
out('sample full models.dev entry (grok-4.5)', JSON.stringify(modelsDev['grok-4.5'], null, 2))
