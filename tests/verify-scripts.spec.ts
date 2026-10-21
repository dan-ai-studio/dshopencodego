/**
 * The exit-code contract for `tools/verify/*.mjs`.
 *
 * A verification script that prints a failure and still exits 0 is worse than
 * no script at all: the failure gets recorded as a pass. These cases run the
 * two live scripts as child processes and assert on the exit code, because
 * that is the only signal a caller or a CI step actually reads.
 *
 * Cost boundary: every child process gets `PROXY_BASE=http://127.0.0.1:1/v1`,
 * a dead local port, so no gateway request can leave the machine and no token
 * is ever billed. The one case that needs a gateway that *answers* points
 * `PROXY_BASE` at a mock on the loopback interface, which is still this
 * machine. The scripts do read the provider documentation and models.dev
 * while building their catalog — read-only GETs that the script itself
 * performs, never a paid inference call. The credential store is a
 * throwaway file in a temp directory, so the real one is never touched.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockGateway } from './mock-gateway.ts'
// The verify scripts are plain ESM JavaScript with no declarations: the
// contract under test is what the process does, not a typed API surface.
// @ts-expect-error - no declarations for the .mjs tooling
import { assertProbeOutcome, estimateWorstCaseUsd, parseLiveCheckArgs, resolveProbeModel } from '../tools/verify/live-check.mjs'
// @ts-expect-error - no declarations for the .mjs tooling
import { parseProbeArgs } from '../tools/verify/model-probe.mjs'

/** A local port nothing listens on: requests fail instantly and cost nothing. */
const DEAD_BASE = 'http://127.0.0.1:1/v1'

const PROBE_SCRIPT = fileURLToPath(new URL('../tools/verify/model-probe.mjs', import.meta.url))
const LIVE_SCRIPT = fileURLToPath(new URL('../tools/verify/live-check.mjs', import.meta.url))

/** A model the installed pi-ai catalog prices, so the price guard passes. */
const PRICED_MODEL = 'mimo-v2.5'

/** The id `live-check.mjs` used to pin; pi-ai 1.3.0 dropped it. */
const RETIRED_ID = 'deepseek-v4-flash'

/** Builds and catalog reads are slower than the default budget on a cold run. */
const SCRIPT_TIMEOUT = 60_000

let credentialsHome: string

beforeAll(() => {
  credentialsHome = mkdtempSync(join(tmpdir(), 'dsh-verify-scripts-'))
  mkdirSync(join(credentialsHome, '.dsh'), { recursive: true })
  writeFileSync(join(credentialsHome, '.dsh', '.credentials.yaml'), 'OPENCODE_GO_API_KEY: test-key-never-used\n')
})

afterAll(() => {
  rmSync(credentialsHome, { recursive: true, force: true })
})

interface RunResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Run one verify script as a child process against the dead gateway. */
function run(script: string, args: readonly string[], env: Readonly<Record<string, string>> = {}): RunResult {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: SCRIPT_TIMEOUT,
    env: {
      ...process.env,
      PROXY_BASE: DEAD_BASE,
      USERPROFILE: credentialsHome,
      HOME: credentialsHome,
      ...env,
    },
  })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Run one verify script as a child process without freezing this one.
 *
 * A child that asks a gateway started in this process needs the event loop
 * to keep turning while it waits: `spawnSync` would freeze the very server
 * the child is asking to answer, and the child would time out on a gateway
 * that is right there.
 * @param script - the script to run.
 * @param args - its arguments.
 * @param env - environment overrides.
 * @returns the exit code and what the script wrote.
 */
function runAsync(script: string, args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        PROXY_BASE: DEAD_BASE,
        USERPROFILE: credentialsHome,
        HOME: credentialsHome,
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${script} did not finish within ${SCRIPT_TIMEOUT}ms`))
    }, SCRIPT_TIMEOUT)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

describe('model-probe.mjs exit codes', () => {
  it('exits 0 for --help', () => {
    const result = run(PROBE_SCRIPT, ['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('usage: node tools/verify/model-probe.mjs')
  })

  it('exits 2 with usage on stderr when no model is named', () => {
    const result = run(PROBE_SCRIPT, [])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage: node tools/verify/model-probe.mjs')
  })

  it('exits 2 when the caller did not pass --allow-live', () => {
    const result = run(PROBE_SCRIPT, [PRICED_MODEL])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('refusing to spend money')
  })

  it('exits 1 when the price guard refuses an unpriced model', () => {
    const result = run(PROBE_SCRIPT, ['definitely-not-a-priced-model', '--allow-live'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('REFUSED')
    expect(result.stderr).toContain('has no published price')
  })

  // The P0 this file exists for: before the fix the main path printed FAILED
  // and still exited 0, so a failed probe was recorded as a pass.
  it('exits 1 when the probe ran and failed', () => {
    const result = run(PROBE_SCRIPT, [PRICED_MODEL, '--allow-live'])
    expect(result.stdout).toContain('FAILED')
    expect(result.status).toBe(1)
  })

  it('parses positionals and flags without treating a flag as a model', () => {
    expect(parseProbeArgs([PRICED_MODEL, 'high', '--allow-live'])).toEqual({
      help: false,
      allowLive: true,
      allowExpensive: false,
      model: PRICED_MODEL,
      effort: 'high',
    })
    expect(parseProbeArgs(['--help']).help).toBe(true)
    expect(parseProbeArgs([]).model).toBeUndefined()
  })
})

describe('live-check.mjs exit codes', () => {
  it('exits 0 for --help', () => {
    const result = run(LIVE_SCRIPT, ['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('usage: node tools/verify/live-check.mjs')
  })

  it('exits 2 when a live request was asked for without --allow-live', () => {
    const result = run(LIVE_SCRIPT, [])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('refusing to spend money')
    expect(result.stderr).toContain('--check-only')
  })

  // The P0 this file exists for: the script used to pin deepseek-v4-flash and
  // died on "has no published price" before it could do anything else.
  it('passes every local pre-flight check with --check-only and sends nothing', () => {
    const result = run(LIVE_SCRIPT, ['--check-only'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('pre-flight OK')
    expect(result.stdout).toContain('check-only: no request was sent')
    expect(`${result.stdout}${result.stderr}`).not.toContain('has no published price')
  })

  it('refuses a retired model id with actionable candidates instead of dying', () => {
    const result = run(LIVE_SCRIPT, ['--check-only', `--model=${RETIRED_ID}`])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('REFUSED')
    expect(result.stderr).toContain('has no such model')
    expect(result.stderr).toContain('--model=<id>')
  })

  it('exits 1 when the gateway advertises nothing', async () => {
    // A gateway that answers, and answers with nothing. Asking the real
    // gateway would make this a question about the network rather than
    // about the script.
    const gateway = await startMockGateway({ listing: [] })
    try {
      const result = await runAsync(LIVE_SCRIPT, ['--allow-live'], { PROXY_BASE: gateway.baseURL })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('advertised no models')
      expect(`${result.stdout}${result.stderr}`).not.toContain('has no published price')
    } finally {
      await gateway.close()
    }
  })

  it('exits 1 when the gateway listing cannot be read', () => {
    // The dead port refuses the connection, so the listing never arrives.
    const result = run(LIVE_SCRIPT, ['--allow-live'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('could not read the model listing')
  })

  it('lists priced candidates with --list-models', () => {
    const result = run(LIVE_SCRIPT, ['--list-models'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('priced models in the installed pi-ai catalog')
  })

  it('parses --model and --session in both spellings', () => {
    expect(parseLiveCheckArgs(['--allow-live'])).toMatchObject({ allowLive: true, checkOnly: false, requested: undefined })
    expect(parseLiveCheckArgs([`--model=${PRICED_MODEL}`])).toMatchObject({ requested: PRICED_MODEL })
    expect(parseLiveCheckArgs(['--model', PRICED_MODEL])).toMatchObject({ requested: PRICED_MODEL })
    expect(parseLiveCheckArgs(['--check-only', '--session=s1'])).toMatchObject({ checkOnly: true, sessionId: 's1' })
  })
})

describe('live-check.mjs model and price selection', () => {
  it('estimates the worst case the way the price guard does', () => {
    // 150 prompt tokens + the 64-token cap + 8000 reasoning headroom, at $1/1M.
    expect(estimateWorstCaseUsd({ input: 1, output: 1 }, 64)).toBeCloseTo((150 + 64 + 8000) / 1_000_000, 12)
  })

  it('defaults to a priced model instead of a pinned id', () => {
    const picked = resolveProbeModel(undefined, 64)
    expect(picked.ok).toBe(true)
    expect(typeof picked.model).toBe('string')
    expect(picked.estimateUsd).toBeGreaterThan(0)
    expect(picked.candidates.length).toBeGreaterThan(1)
  })

  it('refuses an unknown model and still offers candidates', () => {
    const refused = resolveProbeModel('definitely-not-a-model', 64)
    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe('unknown-model')
    expect(refused.candidates.length).toBeGreaterThan(0)
  })

  it('refuses the id the script used to pin', () => {
    // Regression for the pinned-id defect: if the installed catalog ever
    // publishes this id again, the refusal below stops being the reason and
    // this case says so.
    expect(resolveProbeModel(RETIRED_ID, 64)).toMatchObject({ ok: false, reason: 'unknown-model' })
  })

  it('accepts an explicitly named priced model', () => {
    expect(resolveProbeModel(PRICED_MODEL, 64)).toMatchObject({ ok: true, model: PRICED_MODEL, requested: PRICED_MODEL })
  })
})

describe('live-check.mjs assertions', () => {
  const listing = { url: `${DEAD_BASE}/models`, method: 'GET', session: null, affinity: null, status: 200 }
  const call = { url: `${DEAD_BASE}/chat/completions`, method: 'POST', session: 'session-1', affinity: 'session-1', status: 200 }
  const stream = [
    { type: 'text-delta', text: 'pong' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]

  it('passes a well-formed probe', () => {
    expect(assertProbeOutcome({ observed: [listing, call], chunks: stream, sessionId: 'session-1' })).toEqual([])
  })

  it('fails when no inference request reached the wire', () => {
    const failures = assertProbeOutcome({ observed: [listing], chunks: stream, sessionId: 'session-1' })
    expect(failures.join('\n')).toContain('no inference request reached the wire')
  })

  it('fails when the session header is missing or belongs to another session', () => {
    const missing = assertProbeOutcome({
      observed: [listing, { ...call, session: null, affinity: null }],
      chunks: stream,
      sessionId: 'session-1',
    })
    expect(missing.join('\n')).toContain('x-opencode-session was null')
    const other = assertProbeOutcome({
      observed: [listing, call, { ...call, session: 'session-2', affinity: 'session-2' }],
      chunks: stream,
      sessionId: 'session-1',
    })
    expect(other.join('\n')).toContain('"session-2"')
    expect(other.join('\n')).toContain('x-session-affinity')
  })

  it('fails on a non-200 answer and on a request that never got one', () => {
    const rejected = assertProbeOutcome({ observed: [listing, { ...call, status: 500 }], chunks: stream, sessionId: 'session-1' })
    expect(rejected.join('\n')).toContain('answered HTTP 500')
    const broken = assertProbeOutcome({
      observed: [listing, { ...call, error: 'connect ECONNREFUSED 127.0.0.1:1', status: undefined }],
      chunks: stream,
      sessionId: 'session-1',
    })
    expect(broken.join('\n')).toContain('failed before a response')
  })

  it('fails on a stream that never carried text or never finished', () => {
    const empty = assertProbeOutcome({ observed: [listing, call], chunks: [], sessionId: 'session-1' })
    expect(empty.join('\n')).toContain('yielded no chunks')
    const noText = assertProbeOutcome({
      observed: [listing, call],
      chunks: [{ type: 'usage', usage: {} }, { type: 'finish', reason: { kind: 'stop' } }],
      sessionId: 'session-1',
    })
    expect(noText.join('\n')).toContain('no text delta')
    const unterminated = assertProbeOutcome({
      observed: [listing, call],
      chunks: [{ type: 'text-delta', text: 'pong' }],
      sessionId: 'session-1',
    })
    expect(unterminated.join('\n')).toContain('did not close with a finish chunk')
  })

  it('fails on a failed generation even when the transport answered 200', () => {
    const failures = assertProbeOutcome({
      observed: [listing, call],
      chunks: [{ type: 'text-delta', text: 'pong' }, { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }],
      sessionId: 'session-1',
    })
    expect(failures.join('\n')).toContain('finish reason "error"')
  })
})
