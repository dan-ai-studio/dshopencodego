/**
 * The request log: bounded, redacted, and inert when disabled.
 *
 * Three properties make this log safe to keep next to the request path, and
 * each is asserted here rather than trusted to a comment:
 *
 * - disabled costs nothing observable: `start` returns undefined and no
 *   span — and no entry — is ever constructed;
 * - the credential can never reach a record: the recorder takes no headers
 *   argument at all, so even a caller that tried to hand one over has
 *   nowhere to put it, and the snapshot is asserted to carry no secret;
 * - the ring is bounded: the oldest entries are dropped past the configured
 *   maximum, pool events are capped separately, and lowering the bound trims
 *   immediately rather than on the next request.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { estimateImageWireBytes, OpencodeGoAdapter } from '../src/adapter.ts'
import type { OpencodeGoConfig } from '../src/config.ts'
import { parseRequestLogSnapshot } from '../src/request-log/contract.ts'
import { RequestLog } from '../src/request-log/store.ts'
import type { RequestLogGates, RequestStart } from '../src/request-log/store.ts'
import { modelsDevDocument, offlineDocument, startMockGateway, stubModelsDev } from './mock-gateway.ts'
import type { MockGateway } from './mock-gateway.ts'
function gates(overrides: Partial<{ enabled: boolean; debug: boolean; maxEntries: number }> = {}): RequestLogGates {
  return {
    enabled: () => overrides.enabled ?? true,
    debug: () => overrides.debug ?? false,
    maxEntries: () => overrides.maxEntries ?? 200,
  }
}

function start(detail: Partial<RequestStart> = {}): RequestStart {
  return {
    model: 'glm-5.3',
    sessionId: 'session-abcdef0123456789',
    messageCount: 3,
    hasImage: false,
    toolCount: 0,
    headers: {},
    ...detail,
  }
}

function record(log: RequestLog, detail: Partial<RequestStart> = {}): void {
  const span = log.start(start(detail))
  expect(span).toBeDefined()
  span?.token()
  span?.status(200)
  span?.finish(true, undefined, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 })
}

describe('RequestLog', () => {
  it('records nothing while disabled, not even a span', () => {
    const log = new RequestLog(gates({ enabled: false }))
    expect(log.start(start())).toBeUndefined()
    expect(log.snapshot()).toEqual({
      entries: [],
      poolEvents: [],
      totalRecords: 0,
      droppedRecords: 0,
      newConnections: 0,
    })
  })

  it('records one entry per finished span, newest first', () => {
    const log = new RequestLog(gates())
    record(log)
    record(log, { model: 'kimi-k3' })
    const snapshot = log.snapshot()
    expect(snapshot.entries).toHaveLength(2)
    expect(snapshot.entries.map(entry => entry.model)).toEqual(['kimi-k3', 'glm-5.3'])
    expect(snapshot.entries.map(entry => entry.seq)).toEqual([2, 1])
    expect(snapshot.totalRecords).toBe(2)
    expect(snapshot.droppedRecords).toBe(0)
    const first = snapshot.entries[1]!
    expect(first.ok).toBe(true)
    expect(first.status).toBe(200)
    expect(first.inputTokens).toBe(10)
    expect(first.outputTokens).toBe(5)
    expect(first.cacheReadTokens).toBe(3)
    expect(first.durationMs).toBeGreaterThanOrEqual(0)
    expect(first.firstTokenMs).toBeGreaterThanOrEqual(0)
    expect(first.shape).toEqual({ messages: 3, hasImage: false, tools: 0 })
  })

  it('closes an unfinished span with the failure code, exactly once', () => {
    const log = new RequestLog(gates())
    const span = log.start(start())
    span?.status(500)
    span?.finish(false, 'TRANSPORT')
    span?.finish(false, 'TRANSPORT')
    const snapshot = log.snapshot()
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0]).toMatchObject({ ok: false, code: 'TRANSPORT', status: 500 })
    expect(snapshot.totalRecords).toBe(1)
  })

  it('publishes a running row at start and completes it in place', () => {
    // A request is visible from the moment it begins, not only after it ends.
    const log = new RequestLog(gates())
    const span = log.start(start())
    expect(span).toBeDefined()
    const running = log.snapshot()
    expect(running.entries).toHaveLength(1)
    expect(running.entries[0]).toMatchObject({ ok: false, running: true })
    expect(running.totalRecords).toBe(1)
    // The wire line lands in the visible row as it arrives.
    span?.request('POST', 'https://opencode.ai/inference/go/v1/chat/completions', 128)
    span?.status(200)
    span?.token()
    expect(log.snapshot().entries[0]).toMatchObject({ method: 'POST', status: 200 })
    // So does the first token's arrival: the first-token column fills while running.
    expect(log.snapshot().entries[0]?.firstTokenMs).toEqual(expect.any(Number))
    span?.finish(true, undefined, { inputTokens: 10, outputTokens: 5 })
    const done = log.snapshot()
    // Same row, same sequence, completed — counted once, not twice.
    expect(done.entries).toHaveLength(1)
    const entry = done.entries[0]!
    expect(entry.seq).toBe(running.entries[0]!.seq)
    expect(entry.running).toBeUndefined()
    expect(entry.ok).toBe(true)
    expect(done.totalRecords).toBe(1)
    expect(done.droppedRecords).toBe(0)
  })

  it('re-appends a completion whose running row fell out of the ring', () => {
    const log = new RequestLog(gates({ maxEntries: 1 }))
    const first = log.start(start({ model: 'old-model' }))
    expect(first).toBeDefined()
    // A newer start evicts the still-running row.
    const second = log.start(start({ model: 'new-model' }))
    expect(second).toBeDefined()
    expect(log.snapshot().entries.map(entry => entry.model)).toEqual(['new-model'])
    expect(log.snapshot().droppedRecords).toBe(1)
    // The completion must not be lost with its row.
    first?.finish(true, undefined, { inputTokens: 1, outputTokens: 1 })
    const snapshot = log.snapshot()
    expect(snapshot.entries.map(entry => entry.model)).toEqual(['old-model'])
    expect(snapshot.entries[0]).toMatchObject({ ok: true })
    expect(snapshot.entries[0]?.running).toBeUndefined()
    expect(snapshot.totalRecords).toBe(2)
    second?.finish(true, undefined, { inputTokens: 1, outputTokens: 1 })
    expect(log.snapshot().totalRecords).toBe(2)
  })

  it('carries the running flag across the wire codec', () => {
    const log = new RequestLog(gates())
    log.start(start())
    const parsed = parseRequestLogSnapshot(JSON.parse(JSON.stringify(log.snapshot())))
    expect(parsed.entries[0]?.running).toBe(true)
    expect(parsed.entries[0]?.ok).toBe(false)
  })

  it('keeps the session id whole, in both modes', () => {
    // A truncated session cannot tell two conversations apart: it is a
    // conversation identity, not a credential, so it is stored whole.
    const plain = new RequestLog(gates())
    record(plain)
    expect(plain.snapshot().entries[0]?.session).toBe('session-abcdef0123456789')

    const debug = new RequestLog(gates({ debug: true }))
    record(debug)
    expect(debug.snapshot().entries[0]?.session).toBe('session-abcdef0123456789')
  })

  it('keeps only allowlisted headers, and never the credential', () => {
    const debug = new RequestLog(gates({ debug: true }))
    const span = debug.start(start({
      headers: {
        session: 'session-abcdef0123456789',
        userAgent: 'deepseek-harness/0.2.1',
        // A caller that tried to smuggle a credential has nowhere to put it:
        // the type carries no such field, so this only compiles by force.
        authorization: 'Bearer SECRET',
      } as RequestStart['headers'] & { authorization: string },
    }))
    span?.finish(true)
    const snapshot = debug.snapshot()
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0]?.headers).toEqual({
      session: 'session-abcdef0123456789',
      userAgent: 'deepseek-harness/0.2.1',
    })
    expect(JSON.stringify(snapshot)).not.toContain('SECRET')
    expect(JSON.stringify(snapshot)).not.toContain('authorization')
  })

  it('drops the oldest entries past the bound and counts them', () => {
    const log = new RequestLog(gates({ maxEntries: 3 }))
    for (let index = 0; index < 5; index++) record(log, { model: `model-${index}` })
    const snapshot = log.snapshot()
    expect(snapshot.entries.map(entry => entry.model)).toEqual(['model-4', 'model-3', 'model-2'])
    expect(snapshot.totalRecords).toBe(5)
    expect(snapshot.droppedRecords).toBe(2)
  })

  it('trims immediately when the bound is lowered', () => {
    const log = new RequestLog(gates({ maxEntries: 200 }))
    for (let index = 0; index < 5; index++) record(log)
    expect(log.snapshot().entries).toHaveLength(5)
    log.setMaxEntries(2)
    const snapshot = log.snapshot()
    expect(snapshot.entries).toHaveLength(2)
    expect(snapshot.droppedRecords).toBe(3)
    // Raising it backfills nothing.
    log.setMaxEntries(200)
    expect(log.snapshot().entries).toHaveLength(2)
  })

  it('ignores a nonsense bound instead of emptying the log', () => {
    const log = new RequestLog(gates())
    record(log)
    log.setMaxEntries(0)
    log.setMaxEntries(Number.NaN)
    expect(log.snapshot().entries).toHaveLength(1)
  })

  it('records pool lifecycle only in debug mode', () => {
    const plain = new RequestLog(gates())
    plain.poolEvent('create', 'host@addr@1')
    plain.poolEvent('close', 'host@addr@1')
    expect(plain.snapshot().poolEvents).toEqual([])

    const debug = new RequestLog(gates({ debug: true }))
    debug.poolEvent('create', 'host@addr@1')
    debug.poolEvent('close', 'host@addr@1')
    expect(debug.snapshot().poolEvents.map(event => event.type)).toEqual(['close', 'create'])
    expect(debug.snapshot().poolKey).toBeUndefined()
  })

  it('tracks the pool in force and the reuse denominator', () => {
    const debug = new RequestLog(gates({ debug: true }))
    debug.poolEvent('create', 'host@addr@1')
    debug.connectionOpened()
    debug.connectionOpened()
    record(debug)
    record(debug)
    record(debug)
    const snapshot = debug.snapshot()
    expect(snapshot.poolKey).toBe('host@addr@1')
    expect(snapshot.newConnections).toBe(2)
    expect(snapshot.totalRecords).toBe(3)
  })

  it('reports the decode window and the rate it implies', async () => {
    const log = new RequestLog(gates())
    const span = log.start(start())
    expect(span).toBeDefined()
    // Tokens arrive, then more tokens arrive: an evenly streamed reply.
    // The sleeps keep the three marks on different milliseconds, so the
    // ordering assertions below do not depend on timer granularity.
    await new Promise(resolve => { setTimeout(resolve, 20) })
    span?.token()
    await new Promise(resolve => { setTimeout(resolve, 200) })
    span?.token()
    await new Promise(resolve => { setTimeout(resolve, 20) })
    span?.finish(true, undefined, { inputTokens: 10, outputTokens: 30, cacheReadTokens: 3 })
    const entry = log.snapshot().entries[0]!
    // The decode window is measured from the first token to the terminal
    // event, so it is shorter than the whole request.
    expect(entry.decodeMs).toBeGreaterThanOrEqual(200)
    expect(entry.decodeMs).toBeLessThan(entry.durationMs ?? Number.MAX_SAFE_INTEGER)
    // And the rate is the output tokens over that window.
    expect(entry.tps).toBeCloseTo(30 / ((entry.decodeMs ?? 1) / 1000), 6)
  })

  it('reports no rate when the request produced no token', () => {
    const log = new RequestLog(gates())
    const span = log.start(start())
    span?.finish(true, undefined, { inputTokens: 10, outputTokens: 30 })
    const entry = log.snapshot().entries[0]!
    // A rate over a window that never opened is not a rate.
    expect(entry.decodeMs).toBeUndefined()
    expect(entry.tps).toBeUndefined()
  })

  it('reports no rate when the whole output arrived in one burst', () => {
    // The gateway held a reasoning turn and flushed it at the end: the
    // first and last token share a millisecond, while a generation-speed
    // reading would need a window the output actually streamed in.
    const log = new RequestLog(gates())
    const span = log.start(start())
    expect(span).toBeDefined()
    span?.token()
    span?.token()
    span?.finish(true, undefined, { inputTokens: 10, outputTokens: 130 })
    const entry = log.snapshot().entries[0]!
    // The wait itself is still recorded — only the rate is withheld.
    expect(entry.durationMs).toEqual(expect.any(Number))
    expect(entry.firstTokenMs).toEqual(expect.any(Number))
    expect(entry.outputTokens).toBe(130)
    expect(entry.tps).toBeUndefined()
  })

  it('round-trips through the wire codec and refuses garbage', () => {
    const log = new RequestLog(gates({ debug: true }))
    log.poolEvent('create', 'host@addr@1')
    record(log)
    const snapshot = log.snapshot()
    expect(parseRequestLogSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
    expect(() => parseRequestLogSnapshot(null)).toThrow()
    expect(() => parseRequestLogSnapshot({})).toThrow()
    expect(() => parseRequestLogSnapshot({ ...snapshot, entries: [{ ...snapshot.entries[0], seq: -1 }] })).toThrow()
  })

  it('records the protocol, the reasoning split, and the price', () => {
    const log = new RequestLog(gates())
    const span = log.start(start({ protocol: 'openai-responses' }))
    expect(span).toBeDefined()
    span?.token()
    span?.request('POST', 'https://opencode.ai/inference/go/v1/responses', 3_621_468)
    span?.status(200)
    span?.finish(
      true,
      undefined,
      { inputTokens: 950, outputTokens: 390, cacheReadTokens: 566_769, reasoningTokens: 120 },
      0.00130654,
    )
    const entry = log.snapshot().entries[0]!
    expect(entry.protocol).toBe('openai-responses')
    expect(entry.reasoningTokens).toBe(120)
    expect(entry.costUsd).toBeCloseTo(0.00130654, 8)
    expect(entry.requestBytes).toBe(3_621_468)
    // The second request call never rewrites the first line.
    span?.request('POST', 'https://example.invalid/other', 1)
    expect(log.snapshot().entries[0]?.url).toContain('/responses')
    expect(log.snapshot().entries[0]?.requestBytes).toBe(3_621_468)
  })

  it('records the image share and the wire format keeps it', () => {
    const log = new RequestLog(gates())
    const span = log.start(start({ imageBytes: 2_700_000 }))
    expect(span).toBeDefined()
    span?.request('POST', 'https://opencode.ai/inference/go/v1/responses', 2_815_544)
    span?.status(200)
    span?.finish(true)
    const entry = log.snapshot().entries[0]!
    expect(entry.imageBytes).toBe(2_700_000)
    // The wire codec carries it like any other optional count.
    const parsed = parseRequestLogSnapshot(JSON.parse(JSON.stringify(log.snapshot())))
    expect(parsed.entries[0]?.imageBytes).toBe(2_700_000)
  })

  it('drops a protocol it does not know instead of the snapshot', () => {
    const log = new RequestLog(gates())
    record(log)
    const snapshot = log.snapshot()
    const tampered = {
      ...snapshot,
      entries: [{ ...snapshot.entries[0], protocol: 'carrier-pigeon' }],
    }
    expect(parseRequestLogSnapshot(JSON.parse(JSON.stringify(tampered))).entries[0]).not.toHaveProperty('protocol')
  })
})

describe('image share estimate', () => {
  const text = (text: string) => ({
    role: 'user' as const,
    id: MessageId('m-text'),
    source: { kind: 'user' as const },
    content: [{ type: 'text' as const, text }],
  })
  const image = (id: string, bytes: number, offloaded?: true) => ({
    role: 'user' as const,
    id: MessageId(`m-${id}`),
    source: { kind: 'user' as const },
    content: [{
      type: 'image' as const,
      attachment: { attachmentId: AttachmentId(id), mediaType: 'image/png' as const, bytes, width: 64, height: 64 },
      ...offloaded === true ? { offloaded: true as const } : {},
    }],
  })

  it('is absent for text-only requests and ignores text', () => {
    expect(estimateImageWireBytes([], 400_000)).toBeUndefined()
    expect(estimateImageWireBytes([text('hi')], 400_000)).toBeUndefined()
  })

  it('counts base64 bytes once per attachment and skips offloaded placeholders', () => {
    const messages = [image('a', 3_000), image('a', 3_000), image('b', 4, true), text('hi')]
    // 3,000 bytes -> 4,000 base64; the duplicate and the offloaded one add nothing.
    expect(estimateImageWireBytes(messages, 400_000)).toBe(4_000)
  })

  it('caps each image at the route target', () => {
    expect(estimateImageWireBytes([image('a', 3_000_000)], 400_000)).toBe(Math.ceil(400_000 / 3) * 4)
  })
})

/** A full adapter config; the request-log fields ride along like any other. */
function configFor(baseURL: string): OpencodeGoConfig {
  return {
    enabled: true,
    modelVisibility: {},
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    baseURL,
    refreshMinutes: 60,
    streamIdleTimeoutMs: 30_000,
    keepAliveTimeoutMs: 600_000,
    imageBudgetPreset: 'dsh',
    modelLimits: {},
    modelProtocols: {},
    pinnedAddresses: {},
    requestLogEnabled: true,
    requestLogDebug: false,
    requestLogMaxEntries: 200,
  }
}

const gateways: MockGateway[] = []

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
})

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of stream) {
    if (chunk === undefined) break
  }
}

describe('request log on the wire', () => {
  it('records a completed request with the wire line and the terminal counts', async () => {
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    gateways.push(server)
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 128_000, output: 8_192 } },
    }))
    const log = new RequestLog({
      enabled: () => true,
      debug: () => false,
      maxEntries: () => 200,
    })
    try {
      const adapter = new OpencodeGoAdapter({
        config: () => configFor(server.baseURL),
        resolveApiKey: async () => 'test-key',
        readDocument: offlineDocument(),
        fetch: () => globalThis.fetch,
        requestLog: log,
      })
      await drain(adapter.stream({
        provider: 'opencode-go',
        model: 'glm-5.3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        sessionId: 'session-abcdef0123456789' as never,
      }))
      const snapshot = log.snapshot()
      expect(snapshot.entries).toHaveLength(1)
      const entry = snapshot.entries[0]!
      expect(entry.model).toBe('glm-5.3')
      // The whole conversation identity, so the log can group one turn's
      // requests without guessing.
      expect(entry.session).toBe('session-abcdef0123456789')
      expect(entry.method).toBe('POST')
      expect(entry.url).toContain('/chat/completions')
      expect(entry.status).toBe(200)
      expect(entry.ok).toBe(true)
      expect(entry.code).toBeUndefined()
      // The mock answers 11 prompt tokens with 5 served from cache.
      expect(entry.inputTokens).toBe(6)
      expect(entry.outputTokens).toBe(3)
      expect(entry.cacheReadTokens).toBe(5)
      expect(entry.durationMs).toEqual(expect.any(Number))
      expect(entry.firstTokenMs).toEqual(expect.any(Number))
      expect(entry.headers).toBeUndefined()
    } finally {
      stub.restore()
    }
  })

  it('records nothing when disabled, and the request is untouched', async () => {
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    gateways.push(server)
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 128_000, output: 8_192 } },
    }))
    const log = new RequestLog({
      enabled: () => false,
      debug: () => false,
      maxEntries: () => 200,
    })
    try {
      const adapter = new OpencodeGoAdapter({
        config: () => configFor(server.baseURL),
        resolveApiKey: async () => 'test-key',
        readDocument: offlineDocument(),
        fetch: () => globalThis.fetch,
        requestLog: log,
      })
      let text = false
      for await (const chunk of adapter.stream({
        provider: 'opencode-go',
        model: 'glm-5.3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) {
        if (chunk.type === 'text-delta') text = true
      }
      expect(text).toBe(true)
      expect(log.snapshot().totalRecords).toBe(0)
    } finally {
      stub.restore()
    }
  })

  it('records an abandoned stream instead of losing it', async () => {
    // A caller that stops consuming never reaches the terminal chunk, so no
    // usage chunk and no finish chunk ever arrive. The adapter must still
    // close the running row — otherwise a cancelled turn vanishes entirely.
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    gateways.push(server)
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 128_000, output: 8_192 } },
    }))
    const log = new RequestLog({
      enabled: () => true,
      debug: () => false,
      maxEntries: () => 200,
    })
    try {
      const adapter = new OpencodeGoAdapter({
        config: () => configFor(server.baseURL),
        resolveApiKey: async () => 'test-key',
        readDocument: offlineDocument(),
        fetch: () => globalThis.fetch,
        requestLog: log,
      })
      const iterator = adapter.stream({
        provider: 'opencode-go',
        model: 'glm-5.3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })[Symbol.asyncIterator]()
      const first = await iterator.next()
      expect(first.done).toBe(false)
      // The running row is already there before anything finished.
      expect(log.snapshot().entries).toHaveLength(1)
      expect(log.snapshot().entries[0]).toMatchObject({ running: true, ok: false })
      await iterator.return?.(undefined)
      const snapshot = log.snapshot()
      expect(snapshot.entries).toHaveLength(1)
      expect(snapshot.entries[0]).toMatchObject({ ok: false, code: 'ABORTED' })
      expect(snapshot.entries[0]?.running).toBeUndefined()
      expect(snapshot.totalRecords).toBe(1)
    } finally {
      stub.restore()
    }
  })

  it('records a failed request with its code', async () => {
    const server = await startMockGateway({
      listing: ['glm-5.3'],
      streamBody: 'data: {"error":{"message":"Streaming response failed: [internal_error] Internal server error. Please retry your request."}}\n\n',
    })
    gateways.push(server)
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 128_000, output: 8_192 } },
    }))
    const log = new RequestLog({
      enabled: () => true,
      debug: () => false,
      maxEntries: () => 200,
    })
    try {
      const adapter = new OpencodeGoAdapter({
        config: () => configFor(server.baseURL),
        resolveApiKey: async () => 'test-key',
        readDocument: offlineDocument(),
        fetch: () => globalThis.fetch,
        requestLog: log,
      })
      await drain(adapter.stream({
        provider: 'opencode-go',
        model: 'glm-5.3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }))
      const snapshot = log.snapshot()
      expect(snapshot.entries).toHaveLength(1)
      expect(snapshot.entries[0]).toMatchObject({ ok: false, code: 'SERVER', status: 200 })
    } finally {
      stub.restore()
    }
  })
})
