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
 * No model id is pinned any more: the installed pi-ai catalog rotates on its
 * own release cadence (1.3.0 dropped the id this script used to name), so the
 * script picks the cheapest model the catalog actually prices, and refuses an
 * explicit `--model` it cannot price while printing the candidates it can.
 * `--check-only` runs every local pre-flight check and stops before the first
 * network call, which makes the cheap half of this script runnable offline.
 *
 * The exit code is part of the contract, because a check that prints a failure
 * and still exits 0 is how a failed verification gets recorded as a pass:
 *
 *   0  every check passed — a reply streamed, or `--check-only` / `--list-models` / `--help`
 *   1  a pre-flight refusal, a failed assertion, or a failed probe
 *   2  a live request was asked for without `--allow-live`
 *
 * Usage:
 *   node tools/verify/live-check.mjs --allow-live [--model=<id>] [--session=<id>] [--allow-expensive]
 *   node tools/verify/live-check.mjs --check-only [--model=<id>]   # local pre-flight, no request
 *   node tools/verify/live-check.mjs --list-models                 # priced candidates, no request
 * Requires the recording proxy on 127.0.0.1:8787 unless PROXY_BASE is set.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { assertCheapModel } from './cost-guard.mjs'

const USAGE = [
  'usage: node tools/verify/live-check.mjs --allow-live [--model=<id>] [--session=<id>] [--allow-expensive]',
  '       node tools/verify/live-check.mjs --check-only [--model=<id>]',
  '       node tools/verify/live-check.mjs --list-models',
].join('\n')

/** Prompt tokens a one-word probe carries; mirrors cost-guard's estimate. */
const INPUT_TOKENS_ESTIMATE = 150

/** Reasoning headroom folded into billed output; mirrors cost-guard's estimate. */
const REASONING_HEADROOM_TOKENS = 8000

/** Session id used when the caller names none. */
const DEFAULT_SESSION_ID = 'session-livecheck-0001'

/** The header the gateway requires, from src/session-header.ts. */
const SESSION_HEADER = 'x-opencode-session'

/** Session affinity header for gateway routing and prompt caching. */
const SESSION_AFFINITY_HEADER = 'x-session-affinity'

/** Why a model could not be picked, in words a caller can act on. */
const REFUSAL = {
  'unknown-model': 'the installed pi-ai catalog has no such model',
  'unpriced-model': 'the installed pi-ai catalog publishes no price for that model',
  'empty-catalog': 'the installed pi-ai catalog prices no model at all',
}

/**
 * Read this script's command line.
 * @param argv - the arguments after the script path.
 * @returns the flags and options the check needs.
 */
export function parseLiveCheckArgs(argv) {
  const option = name => {
    const inline = argv.find(arg => arg.startsWith(`--${name}=`))
    if (inline !== undefined) return inline.slice(name.length + 3)
    const index = argv.indexOf(`--${name}`)
    const value = index === -1 ? undefined : argv[index + 1]
    return value === undefined || value.startsWith('-') ? undefined : value
  }
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    allowLive: argv.includes('--allow-live'),
    allowExpensive: argv.includes('--allow-expensive'),
    checkOnly: argv.includes('--check-only'),
    listModels: argv.includes('--list-models'),
    requested: option('model'),
    sessionId: option('session'),
  }
}

/** The capped generation length for one check. */
function probeMaxTokens() {
  return Math.min(256, Math.max(1, Number(process.env['PROBE_MAX_TOKENS'] ?? 64)))
}

/**
 * Worst-case dollars for one probe, the same shape cost-guard prices.
 * @param price - published input/output dollars per million tokens.
 * @param maxTokens - the capped generation length.
 * @returns the worst-case estimate in dollars.
 */
export function estimateWorstCaseUsd(price, maxTokens) {
  return (INPUT_TOKENS_ESTIMATE * price.input + (maxTokens + REASONING_HEADROOM_TOKENS) * price.output) / 1_000_000
}

/**
 * Every model the installed catalog prices, cheapest first.
 * @param maxTokens - the capped generation length the estimate assumes.
 * @returns candidates with their worst-case dollar estimate.
 */
export function pricedCandidates(maxTokens) {
  return getBuiltinModels('opencode-go')
    .filter(model => typeof model.cost?.input === 'number' && typeof model.cost?.output === 'number')
    .map(model => ({ id: model.id, estimateUsd: estimateWorstCaseUsd(model.cost, maxTokens) }))
    .sort((left, right) => left.estimateUsd - right.estimateUsd || left.id.localeCompare(right.id))
}

/**
 * Pick the model this check will probe.
 * @param requested - the `--model` value, when the caller named one.
 * @param maxTokens - the capped generation length the estimate assumes.
 * @returns the pick, or the reason it refused plus the candidates it can price.
 */
export function resolveProbeModel(requested, maxTokens) {
  const candidates = pricedCandidates(maxTokens)
  if (requested !== undefined) {
    const entry = getBuiltinModels('opencode-go').find(model => model.id === requested)
    if (entry === undefined) return { ok: false, reason: 'unknown-model', requested, candidates }
    if (typeof entry.cost?.input !== 'number' || typeof entry.cost?.output !== 'number') {
      return { ok: false, reason: 'unpriced-model', requested, candidates }
    }
    return { ok: true, model: requested, requested, estimateUsd: estimateWorstCaseUsd(entry.cost, maxTokens), candidates }
  }
  // A zero-price entry (a free or contributor tier) is not a better default:
  // those channels are account-gated, and a $0 estimate says nothing about
  // whether the price guard works. Prefer the cheapest model this catalog
  // actually charges for, and fall back to the free ones only if there is none.
  const cheapest = candidates.find(candidate => candidate.estimateUsd > 0) ?? candidates[0]
  if (cheapest === undefined) return { ok: false, reason: 'empty-catalog', requested, candidates }
  return { ok: true, model: cheapest.id, requested, estimateUsd: cheapest.estimateUsd, candidates }
}

/**
 * The inference calls among the observed requests.
 *
 * The adapter also reads models.dev, the provider documentation, and the
 * gateway listing, and every one of those is a GET; an inference call is a
 * POST whatever protocol it speaks. Method is therefore what separates the
 * wire call this check asserts on from the reads around it.
 * @param request - one observed request.
 * @returns true when the request is an inference call.
 */
export function isInferenceRequest(request) {
  return request.method !== 'GET'
}

/**
 * Observe every HTTP request the adapter makes, without changing it.
 *
 * pi-ai reads the global `fetch` at call time, so wrapping it is the only way
 * to assert on the wire (the session header, the status) from outside the
 * adapter. The wrapper forwards the real fetch untouched; it only records.
 * @param observed - the array each observed request is appended to.
 * @returns a restore function that puts the original fetch back.
 */
export function watchRequests(observed) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined))
    const entry = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      session: headers.get(SESSION_HEADER),
      affinity: headers.get(SESSION_AFFINITY_HEADER),
    }
    observed.push(entry)
    try {
      const response = await realFetch(input, init)
      entry.status = response.status
      return response
    } catch (error) {
      entry.error = String(error?.message ?? error)
      throw error
    }
  }
  return () => { globalThis.fetch = realFetch }
}

/**
 * Whether a finish chunk reports a failed generation.
 * @param reason - the finish chunk's `reason`, a `{ kind }` object in the
 *   Harness protocol (stream.ts maps failures to `{ kind: 'error' }`).
 * @returns true when the generation failed.
 */
function isErrorFinish(reason) {
  return reason === 'error' || (typeof reason === 'object' && reason !== null && reason.kind === 'error')
}

/**
 * Every claim this check makes about one probe, as a list of failures.
 * @param result - what the probe observed and yielded.
 * @returns the failed assertions, empty when the probe passed.
 */
export function assertProbeOutcome({ observed, chunks, sessionId }) {
  const failures = []
  const inference = observed.filter(isInferenceRequest)
  if (inference.length === 0) {
    const seen = observed.map(request => `${request.method} ${request.url}`).join(', ')
    failures.push(`no inference request reached the wire; observed ${observed.length} request(s): ${seen || '(none)'}`)
  }
  for (const request of inference) {
    if (request.session !== sessionId) {
      failures.push(`${SESSION_HEADER} was ${JSON.stringify(request.session ?? null)}, expected the conversation's own id ${JSON.stringify(sessionId)}`)
    }
    if (request.affinity !== sessionId) {
      failures.push(`${SESSION_AFFINITY_HEADER} was ${JSON.stringify(request.affinity ?? null)}, expected ${JSON.stringify(sessionId)}`)
    }
    if (request.error !== undefined) {
      failures.push(`the request to ${request.url} failed before a response: ${request.error}`)
    } else if (request.status !== 200) {
      failures.push(`the request to ${request.url} answered HTTP ${String(request.status)}`)
    }
  }
  if (chunks.length === 0) failures.push('the adapter yielded no chunks')
  if (!chunks.some(chunk => chunk.type === 'text-delta')) failures.push('the stream carried no text delta')
  const last = chunks.at(-1)
  if (last === undefined || last.type !== 'finish') {
    failures.push(`the stream did not close with a finish chunk (last: ${JSON.stringify(last ?? null)})`)
  } else if (isErrorFinish(last.reason)) {
    failures.push(`the stream closed with finish reason "error": ${JSON.stringify(last.reason)}`)
  }
  return failures
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

/** Render candidates for a refusal message. */
function describeCandidates(candidates, limit) {
  return candidates.slice(0, limit)
    .map(candidate => `  ${candidate.id}  worst case ~$${candidate.estimateUsd.toFixed(6)}`)
    .join('\n')
}

/**
 * Run the live check.
 * @param argv - the arguments after the script path.
 * @returns the exit code: 0 pass, 1 refusal or failed assertion, 2 usage error.
 */
export async function main(argv) {
  const args = parseLiveCheckArgs(argv)
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  if (args.listModels) {
    const candidates = pricedCandidates(probeMaxTokens())
    console.log(`priced models in the installed pi-ai catalog (${candidates.length}):`)
    console.log(describeCandidates(candidates, 12))
    return 0
  }
  if (!args.allowLive && !args.checkOnly) {
    console.error('refusing to spend money: this sends 1 live request.' +
      ' Pass --allow-live only when the answer is worth its price,' +
      ' or --check-only for the local pre-flight without a request.')
    return 2
  }

  const maxTokens = probeMaxTokens()
  const sessionId = args.sessionId ?? DEFAULT_SESSION_ID
  const picked = resolveProbeModel(args.requested, maxTokens)
  if (!picked.ok) {
    console.error(`REFUSED ${REFUSAL[picked.reason]}${args.requested === undefined ? '' : ` ("${args.requested}")`}.`)
    console.error('name one of these priced candidates with --model=<id>:')
    console.error(describeCandidates(picked.candidates, 8))
    return 1
  }
  // Price-checked: the ceiling and the unknown-price rule still apply, and the
  // default pick is the cheapest priced model rather than a pinned id.
  try {
    assertCheapModel(picked.model, maxTokens, { allowExpensive: args.allowExpensive })
  } catch (error) {
    console.error(`REFUSED ${String(error?.message ?? error)}`)
    return 1
  }
  console.log(`${picked.requested === undefined ? 'default' : 'named'} model: ${picked.model}` +
    ` (worst case ~$${picked.estimateUsd.toFixed(6)})`)

  let apiKey
  try {
    apiKey = readApiKey()
  } catch (error) {
    console.error(`REFUSED ${String(error?.message ?? error)}`)
    return 1
  }

  if (args.checkOnly) {
    console.log(`pre-flight OK: model=${picked.model}  max_tokens=${maxTokens}  session=${sessionId}`)
    console.log(`the request would carry ${SESSION_HEADER}: ${sessionId} and ${SESSION_AFFINITY_HEADER}: ${sessionId}`)
    console.log('check-only: no request was sent (zero tokens, zero cost)')
    return 0
  }

  const baseURL = process.env['PROXY_BASE'] ?? 'http://127.0.0.1:8787/zen/go/v1'
  // Loaded here rather than at module load so the exit-code contract test can
  // import the pure helpers above without pulling in the built adapter.
  const { OpencodeGoAdapter } = await import('../../lib/index.js')
  const usage = []
  const adapter = new OpencodeGoAdapter({
    config: () => ({
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
    }),
    resolveApiKey: async () => apiKey,
    onUsage: (detail) => usage.push(detail),
    onFallback: (detail) => console.log('fallback:', detail.url, String(detail.error)),
    onUnconfigured: (entries) => console.log('unconfigured:', entries.map(entry => entry.id).join(', ')),
    onReplayDegrade: (reason) => console.log('replay degrade:', reason),
  })

  const observed = []
  const restoreFetch = watchRequests(observed)
  try {
    const listed = await adapter.listModels('opencode-go')
    console.log(`catalog: ${listed.length} models advertised by the gateway`)
    if (listed.length === 0) {
      console.error(`FAILED the gateway at ${baseURL} advertised no models;` +
        ' start the recording proxy or point PROXY_BASE at a reachable gateway, then retry.')
      return 1
    }
    if (!listed.some(model => model.id === picked.model)) {
      console.error(`FAILED the gateway does not advertise "${picked.model}"; it advertises: ` +
        listed.slice(0, 12).map(model => model.id).join(', '))
      console.error('the gateway listing decides membership: pass --model=<id> with one of those ids.')
      return 1
    }

    console.log(`LIVE 1 request: model=${picked.model}  max_tokens=${maxTokens}  session=${sessionId}  gateway=${baseURL}`)
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'opencode-go',
      model: picked.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: pong' }] }],
      sessionId,
      maxTokens,
    })) chunks.push(chunk)
    const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
    console.log(`reply: ${JSON.stringify(text)}`)
    console.log(`chunks: ${chunks.length}  finish: ${JSON.stringify(chunks.at(-1))}`)
    console.log(`usage: ${JSON.stringify(usage)}`)

    const failures = assertProbeOutcome({ observed, chunks, sessionId })
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAILED ${failure}`)
      return 1
    }
    console.log(`OK ${SESSION_HEADER}: ${sessionId} on ${observed.filter(isInferenceRequest).length} inference request(s);` +
      ' HTTP 200; the stream closed with a finish chunk')
    return 0
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    console.error(`FAILED ${code} ${String(error?.message ?? error)}`)
    if (observed.length > 0) console.error(`observed: ${JSON.stringify(observed)}`)
    return 1
  } finally {
    restoreFetch()
  }
}

const invoked = process.argv[1]
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href.toLowerCase() === import.meta.url.toLowerCase()) {
  process.exitCode = await main(process.argv.slice(2))
}
