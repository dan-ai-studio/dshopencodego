/**
 * Live verification: one real, minimal request through the built plugin.
 *
 * The adapter is driven exactly as a session drives it, but against the real
 * gateway (through the recording proxy), with the real credential from the
 * Harness credential store. This is the only check that can prove the two
 * claims end to end: the catalog follows the live gateway, and the wire request
 * carries the conversation's session id.
 *
 * It spends the account's real money, so it refuses to run without
 * `--allow-live` and caps the generated length. See tools/verify/README.md.
 *
 * Usage: node tools/verify/live-check.mjs [session-id] --allow-live
 * Requires the recording proxy on 127.0.0.1:8787 unless PROXY_BASE is set.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpencodeGoAdapter } from '../../lib/index.js'

const args = process.argv.slice(2)
if (!args.includes('--allow-live')) {
  console.error('refusing to spend money: this sends 1 live request. Pass --allow-live only when the answer is worth its price.')
  process.exit(2)
}
const sessionId = args.find(arg => !arg.startsWith('--')) ?? 'session-livecheck-0001'
const maxTokens = Math.min(256, Math.max(1, Number(process.env['PROBE_MAX_TOKENS'] ?? 64)))
const baseURL = process.env['PROXY_BASE'] ?? 'http://127.0.0.1:8787/zen/go/v1'

const credentialsPath = join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.dsh', '.credentials.yaml')
const credentials = readFileSync(credentialsPath, 'utf8')
const apiKey = /OPENCODE_GO_API_KEY:\s*([^\s,}]+)/.exec(credentials)?.[1]
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

const usage = []
const adapter = new OpencodeGoAdapter({
  config: () => config,
  resolveApiKey: async () => apiKey,
  onUsage: (detail) => usage.push(detail),
  onFallback: (detail) => console.log('fallback:', detail.url, String(detail.error)),
  onUnconfigured: (entries) => console.log('unconfigured:', entries.map(entry => entry.id).join(', ')),
  onReplayDegrade: (reason) => console.log('replay degrade:', reason),
})

const listed = await adapter.listModels('opencode-go')
console.log(`catalog: ${listed.length} models advertised by the gateway`)
console.log(`has deepseek-v4-flash: ${listed.some(model => model.id === 'deepseek-v4-flash')}`)
console.log(`has a model the installed pi-ai catalog does not know: ${listed.some(model => model.id === 'deepseek-v4.1-flash')}`)

console.log(`LIVE 1 request: model=deepseek-v4-flash  max_tokens=${maxTokens}  gateway=${baseURL}`)
const chunks = []
process.stdout.write('reply: ')
for await (const chunk of adapter.stream({
  provider: 'opencode-go',
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: pong' }] }],
  sessionId,
  maxTokens,
})) {
  chunks.push(chunk)
  if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
}
console.log('')
console.log(`chunks: ${chunks.length}`)
console.log(`finish: ${JSON.stringify(chunks.at(-1))}`)
console.log(`usage: ${JSON.stringify(usage)}`)
