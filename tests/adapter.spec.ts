/**
 * Adapter contract, asserted on real sockets.
 *
 * Every header and body assertion here is made against a request a real pi-ai
 * transport sent to a real HTTP server, which is the only way to prove the
 * gateway's mandatory session header actually reaches the wire.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OpencodeGoAdapter } from '../src/adapter.ts'
import { providerHeaders, opencodeSessionValue, SESSION_HEADER } from '../src/session-header.ts'
import { classifyPiAiError, mapStopReason, mapUsage } from '../src/conversion/stream.ts'
import { toPiAssistant, toPiReplayState } from '../src/conversion/replay.ts'
import { isModelEnabled, sortModels } from '../src/models.ts'
import type { OpencodeGoConfig } from '../src/config.ts'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { startMockGateway, stubModelsDev, modelsDevDocument } from './mock-gateway.ts'
import type { MockGateway } from './mock-gateway.ts'

const gateways: MockGateway[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
})

async function gateway(options?: Parameters<typeof startMockGateway>[0]): Promise<MockGateway> {
  const started = await startMockGateway(options)
  gateways.push(started)
  return started
}

function configFor(baseURL: string, overrides: Partial<OpencodeGoConfig> = {}): OpencodeGoConfig {
  return {
    enabled: true,
    modelVisibility: {},
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    baseURL,
    refreshMinutes: 60,
    streamIdleTimeoutMs: 30_000,
    maxRequestImageBytes: 6_000_000,
    requestImagePixelBudget: 1_440_000,
    requestImageMaxBytes: 400_000,
    modelLimits: {},
    modelProtocols: {},
    ...overrides,
  }
}

/** A catalog document covering one model per protocol. */
const DOCUMENT = modelsDevDocument({
  'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 128_000, output: 8_192 } },
  'minimax-m3': {
    name: 'MiniMax-M3', reasoning: true, provider: { npm: '@ai-sdk/anthropic' },
    limit: { context: 200_000, output: 8_192 },
  },
  'grok-4.7': {
    name: 'Grok 4.7', reasoning: true, provider: { npm: '@ai-sdk/openai' },
    limit: { context: 500_000, output: 64_000 },
  },
})

function userMessage(text: string): GenerateOptions['messages'][number] {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function options(model: string, extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'opencode-go',
    model,
    messages: [userMessage('hi')],
    ...extra,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function adapterFor(server: MockGateway, config: Partial<OpencodeGoConfig> = {}): OpencodeGoAdapter {
  return new OpencodeGoAdapter({
    config: () => configFor(server.baseURL, config),
    resolveApiKey: async () => 'test-key',
  })
}

describe('session header invariants', () => {
  it('sends the exact Harness session id', () => {
    expect(opencodeSessionValue('session-7f3a')).toBe('session-7f3a')
  })

  it('never invents a shared constant when there is no session id', () => {
    const first = opencodeSessionValue(undefined)
    const second = opencodeSessionValue('')
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(first).not.toBe(second)
  })

  it('keeps the Harness user-agent and lets nothing override the session header', () => {
    const headers = providerHeaders('session-abc')
    expect(headers[SESSION_HEADER]).toBe('session-abc')
    expect(headers['user-agent']).toMatch(/^deepseek-harness\//)
  })
})

describe('adapter on the wire', () => {
  it('carries the session header on a Chat Completions request', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(DOCUMENT)
    try {
      const chunks = await collect(adapterFor(server).stream(options('glm-5.3', { sessionId: 'session-wire' as never })))
      const request = server.requests.find(entry => entry.path.endsWith('/chat/completions'))
      expect(request).toBeDefined()
      expect(request!.headers[SESSION_HEADER]).toBe('session-wire')
      expect(request!.headers['user-agent']).toMatch(/^deepseek-harness\//)
      expect(request!.headers.authorization).toBe('Bearer test-key')
      expect((request!.body as { model?: string }).model).toBe('glm-5.3')
      expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
      const finish = chunks.at(-1)
      expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    } finally {
      stub.restore()
    }
  })

  it('carries the session header on an Anthropic Messages request', async () => {
    const server = await gateway({ listing: ['minimax-m3'] })
    const stub = stubModelsDev(DOCUMENT)
    try {
      await collect(adapterFor(server).stream(options('minimax-m3', { sessionId: 'session-messages' as never })))
      const request = server.requests.find(entry => entry.path.endsWith('/v1/messages'))
      expect(request).toBeDefined()
      expect(request!.headers[SESSION_HEADER]).toBe('session-messages')
      expect(request!.headers['x-api-key']).toBe('test-key')
    } finally {
      stub.restore()
    }
  })

  it('carries the session header on an OpenAI Responses request', async () => {
    const server = await gateway({ listing: ['grok-4.7'] })
    const stub = stubModelsDev(DOCUMENT)
    try {
      const chunks = await collect(adapterFor(server).stream(options('grok-4.7', { sessionId: 'session-responses' as never })))
      const request = server.requests.find(entry => entry.path.endsWith('/responses'))
      expect(request).toBeDefined()
      expect(request!.headers[SESSION_HEADER]).toBe('session-responses')
      expect(request!.headers['user-agent']).toMatch(/^deepseek-harness\//)
      expect(request!.headers.authorization).toBe('Bearer test-key')
      expect(server.requests.some(entry => entry.path.endsWith('/chat/completions'))).toBe(false)
      // The Responses event vocabulary is translated like the other two:
      // text arrives as deltas, and the terminal event carries usage.
      expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''))
        .toBe('hello from responses')
      expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({
        usage: { inputTokens: 6, outputTokens: 4, cacheReadTokens: 3 },
      })
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    } finally {
      stub.restore()
    }
  })

  it('gives each session-less request its own value', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(DOCUMENT)
    try {
      const adapter = adapterFor(server)
      await collect(adapter.stream(options('glm-5.3')))
      await collect(adapter.stream(options('glm-5.3')))
      const values = server.requests
        .filter(entry => entry.path.endsWith('/chat/completions'))
        .map(entry => entry.headers[SESSION_HEADER])
      expect(values).toHaveLength(2)
      expect(values[0]).not.toBe(values[1])
    } finally {
      stub.restore()
    }
  })

  it('maps cache reads out of the provider usage', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(DOCUMENT)
    try {
      const chunks = await collect(adapterFor(server).stream(options('glm-5.3')))
      const usage = chunks.find(chunk => chunk.type === 'usage')
      expect(usage).toMatchObject({ usage: { inputTokens: 6, outputTokens: 3, cacheReadTokens: 5 } })
    } finally {
      stub.restore()
    }
  })

  it('streams a tool call with its id, name, and raw argument JSON', async () => {
    const server = await gateway({ listing: ['glm-5.3'], toolCall: true })
    const stub = stubModelsDev(DOCUMENT)
    try {
      const chunks = await collect(adapterFor(server).stream(options('glm-5.3')))
      const deltas = chunks.filter(chunk => chunk.type === 'tool-call-delta')
      expect(deltas.length).toBeGreaterThan(0)
      expect(deltas[0]).toMatchObject({ id: 'call_1', name: 'read_file' })
      const end = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
      expect(end).toMatchObject({ block: { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' } })
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    } finally {
      stub.restore()
    }
  })

  it('treats an explicit "off" effort as no effort at all', async () => {
    // MiMo offers no levels and no thinking switch; a session that asks for
    // "off" must not turn into a reasoning_effort the gateway rejects.
    const server = await gateway({ listing: ['mimo-v2.6-flash'] })
    const stub = stubModelsDev(modelsDevDocument({
      'mimo-v2.6-flash': {
        name: 'MiMo-V2.6-Flash', reasoning: true, reasoning_options: [],
        limit: { context: 1_048_576, output: 131_072 },
      },
    }))
    try {
      const chunks = await collect(adapterFor(server).stream(options('mimo-v2.6-flash', { reasoningEffort: 'off' })))
      expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
      const request = server.requests.find(entry => entry.path.endsWith('/chat/completions'))
      expect(request).toBeDefined()
      expect(JSON.stringify(request!.body)).not.toContain('reasoning_effort')
    } finally {
      stub.restore()
    }
  })

  it('refuses a request without a credential instead of sending it', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(DOCUMENT)
    try {
      const adapter = new OpencodeGoAdapter({
        config: () => configFor(server.baseURL),
        resolveApiKey: async () => undefined,
      })
      await expect(collect(adapter.stream(options('glm-5.3')))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
      expect(server.requests.some(entry => entry.path.endsWith('/chat/completions'))).toBe(false)
    } finally {
      stub.restore()
    }
  })

  it('reports a provider error with a classified code', async () => {
    const server = await gateway({
      listing: ['glm-5.3'],
      failInference: { status: 400, body: { error: { message: 'invalid request: bad tool schema' } } },
    })
    const stub = stubModelsDev(DOCUMENT)
    try {
      const chunks = await collect(adapterFor(server).stream(options('glm-5.3')))
      const finish = chunks.at(-1)
      expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST' } } })
    } finally {
      stub.restore()
    }
  })

  it('withdraws a deprecated model from the picker unless switched on', async () => {
    const server = await gateway({ listing: ['glm-5.3', 'glm-5'] })
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 128_000, output: 8_192 } },
      'glm-5': { name: 'GLM-5', reasoning: true, status: 'deprecated', limit: { context: 100_000, output: 8_192 } },
    }))
    try {
      const listed = await adapterFor(server).listModels('opencode-go')
      expect(listed.map(model => model.id)).toEqual(['glm-5.3'])
      const switchedOn = await adapterFor(server, { modelVisibility: { 'glm-5': true } }).listModels('opencode-go')
      expect(switchedOn.map(model => model.id).sort()).toEqual(['glm-5', 'glm-5.3'])
    } finally {
      stub.restore()
    }
  })

  it('exposes reasoning levels with a default only where omitting one would disable thinking', async () => {
    const server = await gateway({ listing: ['deepseek-v4-flash'] })
    // No document entry: the installed catalog supplies this model's protocol,
    // capacities, and its DeepSeek thinking format.
    const stub = stubModelsDev(modelsDevDocument({}))
    try {
      const info = await adapterFor(server).resolveModel('opencode-go', 'deepseek-v4-flash')
      expect(info.reasoning?.efforts.length).toBeGreaterThan(0)
      expect(info.reasoning?.defaultEffort).toBe('high')
    } finally {
      stub.restore()
    }
  })

  it('honours a per-model protocol override', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(DOCUMENT)
    try {
      const adapter = adapterFor(server, { modelProtocols: { 'glm-5.3': 'anthropic-messages' } })
      await collect(adapter.stream(options('glm-5.3')))
      expect(server.requests.some(entry => entry.path.endsWith('/v1/messages'))).toBe(true)
      expect(server.requests.some(entry => entry.path.endsWith('/chat/completions'))).toBe(false)
    } finally {
      stub.restore()
    }
  })
})

describe('stream mapping', () => {
  it('maps usage with cache fields only when non-zero', () => {
    expect(mapUsage({ input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 } as never))
      .toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 })
  })

  it('classifies provider failures without guessing', () => {
    expect(classifyPiAiError('401 Unauthorized')).toBe('AUTH')
    expect(classifyPiAiError('429 rate limit exceeded')).toBe('RATE_LIMIT')
    expect(classifyPiAiError('socket hang up')).toBe('TRANSPORT')
    expect(classifyPiAiError('something odd')).toBe('PI_AI_ERROR')
  })

  it('turns a zero-content completion into an error, not an empty success', () => {
    expect(mapStopReason({ stopReason: 'stop', content: [], model: 'm', usage: {} } as never))
      .toMatchObject({ kind: 'error', failure: { code: expect.stringContaining('EMPTY_RESPONSE') } })
  })
})

describe('replay round trip', () => {
  it('keeps signatures and degrades unusable state instead of failing', () => {
    const message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'answer' },
        { type: 'reasoning', text: 'thinking' },
        { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      ],
      source: {
        kind: 'model',
        provider: 'opencode-go',
        model: 'glm-5.3',
        replayState: {
          response: {
            kind: 'pi-ai', version: 2, api: 'openai-completions', provider: 'opencode-go',
            model: 'glm-5.3', stopReason: 'toolUse',
          },
          blocks: [{ type: 'text', textSignature: 'sig-text' }, { type: 'reasoning', thinkingSignature: 'sig-think' }, { type: 'tool-call' }],
        },
      },
    } as unknown as Message
    const native = toPiAssistant(message)
    expect(native.content[0]).toMatchObject({ type: 'text', textSignature: 'sig-text' })
    expect(native.content[1]).toMatchObject({ type: 'thinking', thinkingSignature: 'sig-think' })
    expect(native.content[2]).toMatchObject({ type: 'toolCall', arguments: { path: 'a.txt' } })

    // A mismatched envelope degrades to provider-neutral content.
    const degraded = toPiAssistant({
      ...message,
      source: { ...message.source, replayState: { response: { kind: 'pi-ai', version: 1 }, blocks: [] } },
    } as unknown as Message)
    expect(degraded.api).toBe('dsh-foreign')
    expect(degraded.content).toHaveLength(3)
  })

  it('projects a completed response into an index-aligned envelope', () => {
    const envelope = toPiReplayState({
      api: 'openai-completions', provider: 'opencode-go', model: 'glm-5.3', stopReason: 'stop',
      content: [{ type: 'text', text: 'hi', textSignature: 's' }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    } as never, 'glm-5.3')
    expect(envelope).toMatchObject({
      response: { kind: 'pi-ai', version: 2, model: 'glm-5.3', stopReason: 'stop' },
      blocks: [{ type: 'text', textSignature: 's' }],
    })
  })
})

describe('model summaries', () => {
  it('defaults deprecated models off and always hides unconfigurable ones', () => {
    expect(isModelEnabled({ id: 'a' })).toBe(true)
    expect(isModelEnabled({ id: 'a', deprecated: true })).toBe(false)
    expect(isModelEnabled({ id: 'a', deprecated: true }, { a: true })).toBe(true)
    expect(isModelEnabled({ id: 'a', configurationMissing: 'why' }, { a: true })).toBe(false)
  })

  it('sorts new releases first and deprecated last', () => {
    const now = Date.parse('2026-09-24T00:00:00Z')
    const sorted = sortModels([
      { id: 'old', deprecated: true },
      { id: 'plain' },
      { id: 'fresh', releaseDate: '2026-09-23' },
    ], now)
    expect(sorted.map(model => model.id)).toEqual(['fresh', 'plain', 'old'])
  })
})
