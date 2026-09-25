/**
 * One live request through the built adapter for a single model, so a gateway
 * rejection can be read verbatim while the recording proxy keeps the exact
 * request body that produced it.
 *
 * Usage: node tools/verify/model-probe.mjs <model> [reasoningEffort]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpencodeGoAdapter } from '../../lib/index.js'

const model = process.argv[2] ?? 'mimo-v2.6-flash'
const effort = process.argv[3]
const baseURL = process.env['PROXY_BASE'] ?? 'http://127.0.0.1:8787/zen/go/v1'

const credentialsPath = join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.dsh', '.credentials.yaml')
const apiKey = /OPENCODE_GO_API_KEY:\s*([^\s,}]+)/.exec(readFileSync(credentialsPath, 'utf8'))?.[1]
if (apiKey === undefined) throw new Error(`no OPENCODE_GO_API_KEY reference in ${credentialsPath}`)

const config = {
  enabled: true,
  modelVisibility: {},
  apiKeyEnv: 'OPENCODE_GO_API_KEY',
  baseURL,
  refreshMinutes: 60,
  streamIdleTimeoutMs: 60_000,
  maxRequestImageBytes: 6_000_000,
  requestImagePixelBudget: 1_440_000,
  requestImageMaxBytes: 400_000,
  modelLimits: {},
  modelProtocols: {},
}

const adapter = new OpencodeGoAdapter({
  config: () => config,
  resolveApiKey: async () => apiKey,
})

console.log(`model: ${model}  effort: ${effort ?? '(unset)'}`)
try {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'opencode-go',
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: pong' }] }],
    sessionId: 'session-model-probe',
    ...effort === undefined ? {} : { reasoningEffort: effort },
  })) chunks.push(chunk)
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  console.log(`OK reply: ${JSON.stringify(text)}`)
  console.log(`finish: ${JSON.stringify(chunks.at(-1))}`)
} catch (error) {
  const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  console.log(`FAILED ${code} ${String(error?.message ?? error)}`)
}
