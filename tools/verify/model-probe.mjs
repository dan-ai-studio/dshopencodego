/**
 * One live request through the built adapter for a single model, so a gateway
 * rejection can be read verbatim while the recording proxy keeps the exact
 * request body that produced it.
 *
 * A live request spends the account's real money, so this script never sends
 * one by accident: it refuses unless the caller passes `--allow-live`, it
 * prints what it is about to spend, and it caps the generated length. The
 * repository's rules and the measurements that must not be repeated live in
 * tools/verify/README.md.
 *
 * Usage:
 *   node tools/verify/model-probe.mjs <model> [reasoningEffort] --allow-live
 *   PROBE_MAX_TOKENS=16 node tools/verify/model-probe.mjs <model> --allow-live
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpencodeGoAdapter } from '../../lib/index.js'

const args = process.argv.slice(2)
const allowLive = args.includes('--allow-live')
const positional = args.filter(arg => !arg.startsWith('--'))
const model = positional[0]
const effort = positional[1]
const maxTokens = Math.min(256, Math.max(1, Number(process.env['PROBE_MAX_TOKENS'] ?? 64)))

if (model === undefined) {
  console.error('usage: node tools/verify/model-probe.mjs <model> [reasoningEffort] --allow-live')
  process.exit(2)
}
if (!allowLive) {
  console.error(`refusing to spend money: this would send 1 live request to "${model}"` +
    ` (effort ${effort ?? 'unset'}, max_tokens ${maxTokens}).` +
    ' Pass --allow-live only when the answer is worth its price.')
  process.exit(2)
}

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

console.log(`LIVE 1 request: model=${model}  effort=${effort ?? '(unset)'}  max_tokens=${maxTokens}  gateway=${baseURL}`)
try {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'opencode-go',
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: pong' }] }],
    sessionId: 'session-model-probe',
    maxTokens,
    ...effort === undefined ? {} : { reasoningEffort: effort },
  })) chunks.push(chunk)
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  console.log(`OK reply: ${JSON.stringify(text)}`)
  console.log(`finish: ${JSON.stringify(chunks.at(-1))}`)
} catch (error) {
  const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  console.log(`FAILED ${code} ${String(error?.message ?? error)}`)
}
