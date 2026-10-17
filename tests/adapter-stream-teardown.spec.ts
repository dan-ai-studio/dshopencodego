/**
 * Regression: an idle stream timeout must reach the caller as a `TIMEOUT`
 * failure — never hang, and never leak the watchdog's raw reason.
 *
 * Two things in the adapter's `finally` used to break that:
 *
 * 1. It released an abandoned iterator demand with
 *    `await iterator.return(undefined)`. An async generator queues its own
 *    return behind its outstanding `next()`, and an aborted transport read can
 *    leave that demand pending forever — exactly why `@deepseek-ai/dsh-timeout`'s
 *    `IdleWatchdog.next` documents that "callers must not await it". On such a
 *    transport the awaited release parked the deadline behind the demand it was
 *    abandoning and swallowed the failure.
 * 2. It classified the deadline from the fused signal *after*
 *    `consumer.abort(...)`. `AbortSignal.any` reports the reason of the last
 *    source to abort when both abort in the same turn, so the adapter's own
 *    cancellation could overwrite the watchdog's `TimeoutReason` and the catch
 *    rethrew that bare reason instead of the `TIMEOUT` LlmError.
 *
 * This suite drives a real HTTP server that answers the catalog listing and
 * then emits a partial Chat Completions SSE response before going silent with
 * the socket still open (the production shape `tools/verify/stream-blackhole.mjs`
 * creates), and bounds its own wait so either failure mode fails the suite
 * rather than hanging it.
 *
 * The suite owns a dedicated server fixture instead of extending
 * `tests/mock-gateway.ts`: that file is shared by 30+ suites, and a "never
 * answer" mode would put a stalled socket in every one of them.
 */

import { once } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { OpencodeGoAdapter } from '../src/adapter.ts'
import type { OpencodeGoConfig } from '../src/config.ts'
import { modelsDevDocument, offlineDocument, startMockGateway, stubModelsDev } from './mock-gateway.ts'

/**
 * The stall window.
 *
 * It has to outlast the adapter's ramp-up — catalog fetch, models.dev read,
 * SSE handshake, first bytes — on a *loaded* machine, because
 * `npm run test:coverage` runs every spec file in parallel with v8
 * instrumentation on. At 100 ms this test failed intermittently there (`received`
 * was still empty when the watchdog fired) while passing in isolation: the
 * assertion below wants a stall *after* partial output, so the window must clear
 * the ramp-up rather than merely the stall.
 */
const IDLE_TIMEOUT_MS = 750

/**
 * The ceiling the assertions race against. The first failure mode parks the
 * adapter in `iterator.return()` forever, so without this bound the suite would
 * hang CI instead of failing it. It stays well above `IDLE_TIMEOUT_MS` so a
 * loaded run reports the stall, not the deadline.
 */
const HARD_DEADLINE_MS = 5_000

/** SSE headers with no `content-length`: the body stays open until the server says so. */
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }

/** One Chat Completions delta, byte-for-byte the shape the gateway sends. */
function chatChunk(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-stall',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'glm-5.3',
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`
}

/** A running server that goes silent mid-stream. */
interface StalledGateway {
  /** Base URL to configure the plugin with, ending in `/v1`. */
  readonly baseURL: string
  /** Drop the stalled sockets, then stop listening. */
  close(): Promise<void>
}

/** Read (and discard) a request body so the response can be written. */
async function drainRequest(request: IncomingMessage): Promise<void> {
  if (request.readableEnded) return
  request.resume()
  await once(request, 'end')
}

/**
 * Start a real HTTP server that advertises one model, then answers the
 * inference request with two SSE deltas and never another byte.
 * @returns the running gateway; call `close()` to stop it.
 */
async function startStalledGateway(): Promise<StalledGateway> {
  const server: Server = createServer((request, response) => {
    void (async () => {
      await drainRequest(request)
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (path.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'glm-5.3', object: 'model', created: 0, owned_by: 'opencode' }],
        }))
        return
      }
      if (path.endsWith('/chat/completions')) {
        response.writeHead(200, SSE_HEADERS)
        // Partial output on the wire, then silence with the socket open: the
        // stalled transport the idle watchdog exists to catch.
        response.write(chatChunk({ role: 'assistant', content: '' }))
        response.write(chatChunk({ content: 'partial output' }))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `no stalled mock for ${path}` } }))
    })()
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => {
      // The stalled response never drains on its own; keep-alive sockets are
      // dropped before closing, exactly as tests/mock-gateway.ts does.
      server.closeAllConnections()
      server.close(error => { if (error === undefined) resolve(); else reject(error) })
    }),
  }
}

const gateways: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
})

function configFor(baseURL: string, streamIdleTimeoutMs: number): OpencodeGoConfig {
  return {
    enabled: true,
    modelVisibility: {},
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    baseURL,
    refreshMinutes: 60,
    streamIdleTimeoutMs,
    maxRequestImageBytes: 6_000_000,
    requestImagePixelBudget: 1_440_000,
    requestImageMaxBytes: 400_000,
    modelLimits: {},
    modelProtocols: {},
  }
}

/** The models.dev record for the one id the stalled gateway advertises. */
const DOCUMENT = modelsDevDocument({
  'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 128_000, output: 8_192 } },
})

function userMessage(text: string): GenerateOptions['messages'][number] {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function options(): GenerateOptions {
  return { provider: 'opencode-go', model: 'glm-5.3', messages: [userMessage('hi')] }
}

/** Outcome of one bounded wait: the work settled, or it never did. */
type Bounded<T> = { kind: 'settled'; value: T } | { kind: 'hung' }

/**
 * Bound a promise so a never-settling adapter fails the assertion instead of
 * the suite.
 * @param work - the promise to bound.
 * @returns its settled value, or `hung` once the hard deadline elapses.
 */
async function withHardDeadline<T>(work: Promise<T>): Promise<Bounded<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(value => ({ kind: 'settled' as const, value })),
      new Promise<{ kind: 'hung' }>(resolve => {
        timer = setTimeout(() => resolve({ kind: 'hung' }), HARD_DEADLINE_MS)
        // A still-armed timer must not hold the worker open after a fast pass.
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function adapterFor(baseURL: string): OpencodeGoAdapter {
  return new OpencodeGoAdapter({
    config: () => configFor(baseURL, IDLE_TIMEOUT_MS),
    resolveApiKey: async () => 'test-key',
    readDocument: offlineDocument(),
  })
}

describe('stream idle timeout teardown', () => {
  it('throws a TIMEOUT LlmError when the stream stalls after partial output, instead of hanging', async () => {
    const server = await startStalledGateway()
    gateways.push(server)
    const stub = stubModelsDev(DOCUMENT)
    try {
      const adapter = adapterFor(server.baseURL)
      const received: StreamChunk[] = []
      const startedAt = Date.now()
      const bounded = await withHardDeadline((async () => {
        for await (const chunk of adapter.stream(options())) received.push(chunk)
      })().then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ))
      const elapsedMs = Date.now() - startedAt

      // An awaited `iterator.return()` queues this loop behind the very demand
      // it abandons, so the call never settles and the deadline never surfaces.
      expect(
        bounded.kind,
        `adapter neither failed nor finished within ${HARD_DEADLINE_MS}ms; the idle timeout was swallowed by iterator teardown`,
      ).toBe('settled')
      if (bounded.kind !== 'settled') return
      const outcome = bounded.value

      expect(outcome.kind, 'the stalled stream must fail, not finish').toBe('rejected')
      if (outcome.kind !== 'rejected') return

      // The watchdog's own reason is not the contract: the caller routes on
      // the LlmError code, which the teardown must not overwrite.
      expect(outcome.error).toBeInstanceOf(LlmError)
      expect((outcome.error as LlmError).code).toBe('TIMEOUT')

      // The stall happened after real output, not before the first byte.
      expect(received.map(chunk => chunk.type)).toContain('text-delta')

      // The elapsed time is the idle interval, not an indefinite wait.
      expect(elapsedMs).toBeGreaterThanOrEqual(IDLE_TIMEOUT_MS - 10)
      expect(elapsedMs).toBeLessThan(HARD_DEADLINE_MS)
    } finally {
      stub.restore()
    }
  })

  it('leaves a stream that completes on its own untouched', async () => {
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    gateways.push(server)
    const stub = stubModelsDev(DOCUMENT)
    try {
      const chunks: StreamChunk[] = []
      for await (const chunk of adapterFor(server.baseURL).stream(options())) chunks.push(chunk)
      // Detaching the teardown must not disturb a stream that ended by itself.
      expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    } finally {
      stub.restore()
    }
  })
})
