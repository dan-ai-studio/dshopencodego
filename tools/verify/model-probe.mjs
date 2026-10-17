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
 * The exit code is part of the contract, because a probe that prints FAILED
 * and still exits 0 is how a failed verification gets recorded as a pass:
 *
 *   0  the probe completed and streamed a reply (or `--help` was asked for)
 *   1  the probe ran and failed, or a pre-flight check refused it: an unpriced
 *      or over-ceiling model, or a credential the store does not carry
 *   2  usage error: no model argument, or `--allow-live` missing
 *
 * Usage:
 *   node tools/verify/model-probe.mjs <model> [reasoningEffort] --allow-live
 *   PROBE_MAX_TOKENS=16 node tools/verify/model-probe.mjs <model> --allow-live
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertCheapModel } from './cost-guard.mjs'

const USAGE = 'usage: node tools/verify/model-probe.mjs <model> [reasoningEffort] --allow-live [--allow-expensive]'

/**
 * Read this script's command line.
 * @param argv - the arguments after the script path.
 * @returns the flags and positionals the probe needs; `model` is undefined
 *   when the caller named none.
 */
export function parseProbeArgs(argv) {
  const positional = argv.filter(arg => !arg.startsWith('-'))
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    allowLive: argv.includes('--allow-live'),
    allowExpensive: argv.includes('--allow-expensive'),
    model: positional[0],
    effort: positional[1],
  }
}

/** The capped generation length for one probe. */
function probeMaxTokens() {
  return Math.min(256, Math.max(1, Number(process.env['PROBE_MAX_TOKENS'] ?? 64)))
}

/**
 * The credential the adapter authenticates with.
 * @returns the key referenced by the Harness credential store.
 * @throws when the store is unreadable or does not name the key.
 */
function readApiKey() {
  const credentialsPath = join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.dsh', '.credentials.yaml')
  let document
  try {
    document = readFileSync(credentialsPath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read the Harness credential store ${credentialsPath}: ${String(error?.message ?? error)}`)
  }
  const apiKey = /OPENCODE_GO_API_KEY:\s*([^\s,}]+)/.exec(document)?.[1]
  if (apiKey === undefined) throw new Error(`no OPENCODE_GO_API_KEY reference in ${credentialsPath}`)
  return apiKey
}

/**
 * Run one probe.
 * @param argv - the arguments after the script path.
 * @returns the exit code: 0 pass, 1 refusal or probe failure, 2 usage error.
 */
export async function main(argv) {
  const args = parseProbeArgs(argv)
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  if (args.model === undefined) {
    console.error(USAGE)
    return 2
  }
  if (!args.allowLive) {
    console.error(`refusing to spend money: this would send 1 live request to "${args.model}"` +
      ` (effort ${args.effort ?? 'unset'}, max_tokens ${probeMaxTokens()}).` +
      ' Pass --allow-live only when the answer is worth its price.')
    return 2
  }
  const maxTokens = probeMaxTokens()
  // Price-checked: expensive or unpriced models refuse here, before any
  // credential is read or any request goes out. Override with --allow-expensive.
  try {
    assertCheapModel(args.model, maxTokens, { allowExpensive: args.allowExpensive })
  } catch (error) {
    console.error(`REFUSED ${String(error?.message ?? error)}`)
    return 1
  }

  let apiKey
  try {
    apiKey = readApiKey()
  } catch (error) {
    console.error(`REFUSED ${String(error?.message ?? error)}`)
    return 1
  }

  const baseURL = process.env['PROXY_BASE'] ?? 'http://127.0.0.1:8787/zen/go/v1'
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
  // Loaded here rather than at module load so this file can be imported for its
  // pure helpers (the exit-code contract test does exactly that) without
  // pulling in the built adapter.
  const { OpencodeGoAdapter } = await import('../../lib/index.js')
  const adapter = new OpencodeGoAdapter({
    config: () => config,
    resolveApiKey: async () => apiKey,
  })

  console.log(`LIVE 1 request: model=${args.model}  effort=${args.effort ?? '(unset)'}  max_tokens=${maxTokens}  gateway=${baseURL}`)
  try {
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'opencode-go',
      model: args.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: pong' }] }],
      sessionId: 'session-model-probe',
      maxTokens,
      ...args.effort === undefined ? {} : { reasoningEffort: args.effort },
    })) chunks.push(chunk)
    const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
    console.log(`OK reply: ${JSON.stringify(text)}`)
    console.log(`finish: ${JSON.stringify(chunks.at(-1))}`)
    return 0
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    console.log(`FAILED ${code} ${String(error?.message ?? error)}`)
    return 1
  }
}

const invoked = process.argv[1]
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href.toLowerCase() === import.meta.url.toLowerCase()) {
  process.exitCode = await main(process.argv.slice(2))
}
