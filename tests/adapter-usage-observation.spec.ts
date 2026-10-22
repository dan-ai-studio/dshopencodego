/**
 * What the adapter hands the meter for one completed call.
 *
 * Two facts only exist on the raw pi-ai stream and are dropped by the
 * conversion (`mapUsage` projects counts and nothing else): the reasoning
 * breakdown, and the rates the call ran under. Both have to reach the meter
 * attached to that call, or the spend line either loses the model's price or
 * appends it later at a rate the call never saw.
 *
 * The suite owns a dedicated SSE fixture rather than extending
 * `tests/mock-gateway.ts`: its usage chunk is a fixed shape shared by 30+
 * suites, and a `completion_tokens_details` block would change the counts every
 * one of them asserts on.
 *
 * The last case is a recorded decision: this route declares no request-image
 * pricing on purpose, and a regression that silently invents one should fail
 * here rather than distort the token meter's estimates.
 */

import { once } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { OpencodeGoAdapter } from '../src/adapter.ts'
import type { OpencodeGoConfig } from '../src/config.ts'
import { UsageMeter } from '../src/usage/meter.ts'
import { modelsDevDocument, offlineDocument, stubModelsDev } from './mock-gateway.ts'

/** The gateway's own id, and a sibling the catalog deliberately leaves unpriced. */
const PRICED_MODEL = 'glm-5.3'
const UNPRICED_MODEL = 'glm-5.3-unpriced'

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }

/**
 * The terminal usage chunk: 11 prompt tokens with 5 served from cache (so 6
 * uncached), and 100 completion tokens of which 80 were reasoning.
 */
const USAGE = {
  prompt_tokens: 11,
  completion_tokens: 100,
  total_tokens: 111,
  prompt_tokens_details: { cached_tokens: 5 },
  completion_tokens_details: { reasoning_tokens: 80 },
}

/** One Chat Completions delta, the shape the gateway sends. */
function chatChunk(delta: Record<string, unknown>, finish: string | null, usage?: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-usage',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...usage === undefined ? {} : { usage },
  })}\n\n`
}

/** Read (and discard) a request body so the response can be written. */
async function drainRequest(request: IncomingMessage): Promise<void> {
  if (request.readableEnded) return
  request.resume()
  await once(request, 'end')
}

/** A running gateway that answers the catalog and one reasoning-bearing stream. */
async function startGateway(): Promise<{ baseURL: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    void (async () => {
      await drainRequest(request)
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (path.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          object: 'list',
          data: [PRICED_MODEL, UNPRICED_MODEL].map(id => ({ id, object: 'model', created: 0, owned_by: 'opencode' })),
        }))
        return
      }
      if (path.endsWith('/chat/completions')) {
        response.writeHead(200, SSE_HEADERS)
        response.write(chatChunk({ role: 'assistant', content: '' }, null))
        response.write(chatChunk({ content: 'hi' }, null))
        response.write(chatChunk({}, 'stop', USAGE))
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `no usage mock for ${path}` } }))
    })()
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close(error => { if (error === undefined) resolve(); else reject(error) })
    }),
  }
}

/**
 * One models.dev document with both ids: the priced one states a rate block,
 * the sibling states none at all.
 */
const DOCUMENT = modelsDevDocument({
  [PRICED_MODEL]: {
    name: 'GLM-5.3',
    reasoning: true,
    limit: { context: 128_000, output: 8_192 },
    cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 0 },
  },
  [UNPRICED_MODEL]: { name: 'GLM-5.3 (unpriced)', limit: { context: 128_000, output: 8_192 } },
})

const gateways: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
})

function configFor(baseURL: string): OpencodeGoConfig {
  return {
    enabled: true,
    modelVisibility: {},
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    baseURL,
    refreshMinutes: 60,
    streamIdleTimeoutMs: 30_000,
    keepAliveTimeoutMs: 600_000,
    maxRequestImageBytes: 6_000_000,
    requestImagePixelBudget: 1_440_000,
    requestImageMaxBytes: 400_000,
    modelLimits: {},
    modelProtocols: {},
    pinnedAddresses: {},
    requestLogEnabled: false,
    requestLogDebug: false,
    requestLogMaxEntries: 200,
  }
}

/** Drain one call through a fresh meter and return its reading. */
async function meterAfterCall(baseURL: string, model: string): Promise<ReturnType<UsageMeter['snapshot']>> {
  const meter = new UsageMeter()
  const adapter = new OpencodeGoAdapter({
    config: () => configFor(baseURL),
    resolveApiKey: async () => 'test-key',
    readDocument: offlineDocument(),
    onUsage: ({ model: id, usage }) => meter.record(id, usage),
  })
  const options: GenerateOptions = {
    provider: 'opencode-go',
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
  return meter.snapshot()
}

describe('usage observation', () => {
  it('reports the reasoning breakdown and prices the call at the catalog rates', async () => {
    const server = await startGateway()
    gateways.push(server)
    const stub = stubModelsDev(DOCUMENT)
    try {
      const reading = await meterAfterCall(server.baseURL, PRICED_MODEL)
      // 6 uncached in, 100 out, 5 cache reads — and 80 of the 100 were thinking,
      // so the billed total stays 111 rather than becoming 191.
      expect(reading.totals).toMatchObject({
        calls: 1,
        inputTokens: 6,
        outputTokens: 100,
        cacheReadTokens: 5,
        totalTokens: 111,
        reasoningTokens: 80,
      })
      // 6×$1 + 100×$2 + 5×$0.50, per million tokens.
      expect(reading.totals.estimatedUSD).toBeCloseTo(0.0002085, 12)
      expect(reading.totals.unpricedTokens).toBeUndefined()
    } finally {
      stub.restore()
    }
  })

  it('leaves a model the catalog does not price unpriced, not free', async () => {
    const server = await startGateway()
    gateways.push(server)
    const stub = stubModelsDev(DOCUMENT)
    try {
      const reading = await meterAfterCall(server.baseURL, UNPRICED_MODEL)
      expect(reading.totals.reasoningTokens).toBe(80)
      expect(reading.totals.estimatedUSD).toBeUndefined()
      // No estimate means nothing is "uncovered" — the absence of a figure is
      // itself the statement that this model has no published rate.
      expect(reading.totals.unpricedTokens).toBeUndefined()
      // Absent rather than present-and-zero: `$0` is what a free call looks
      // like, and this model's price is simply unknown.
      expect(reading.models[0]?.model).toBe(UNPRICED_MODEL)
      expect(reading.models[0] !== undefined && 'estimatedUSD' in reading.models[0]).toBe(false)
    } finally {
      stub.restore()
    }
  })

  it('declares no request-image pricing for any model, deliberately', async () => {
    const server = await startGateway()
    gateways.push(server)
    const adapter = new OpencodeGoAdapter({
      config: () => configFor(server.baseURL),
      resolveApiKey: async () => 'test-key',
      readDocument: offlineDocument(),
    })
    // Not an omission to be "fixed" casually: the route fronts several model
    // families whose vision accounting the gateway does not publish, and the
    // token meter spends this answer as if it were measured. See the override's
    // doc comment in src/adapter.ts and notes/fix-ui-notes.md before changing it.
    expect(adapter.imageRequestPricing('opencode-go', PRICED_MODEL)).toBeUndefined()
    expect(adapter.imageRequestPricing('opencode-go', UNPRICED_MODEL)).toBeUndefined()
  })
})
