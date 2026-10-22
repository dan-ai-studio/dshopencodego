/**
 * Contract test for the OpenCode Console main endpoint (R-C2 / T-21):
 * `https://opencode.ai/inference/v1`.
 *
 * Verifies that the plugin can:
 * 1. Resolve and configure all 86 models advertised by the Console endpoint.
 * 2. Assign valid wire protocols across the four-level ladder (builtin, online,
 *    document, and inferred family rules).
 * 3. Route endpoint URLs correctly for Chat Completions, Responses, and Messages.
 * 4. Perform explicit model discovery for all 86 models.
 * 5. Handle the absence of `/usage` gracefully without crashing.
 * 6. Execute streaming requests carrying session and affinity headers against
 *    a Console baseURL.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { CONSOLE_BASE_URL, DEFAULT_BASE_URL } from '../src/catalog/constants.ts'
import { OpencodeGoCatalog, discoverCatalogModels } from '../src/catalog/index.ts'
import { toPiModel } from '../src/catalog/metadata.ts'
import type { ModelFacts } from '../src/catalog/metadata.ts'
import { OpencodeGoAdapter } from '../src/adapter.ts'
import { OpencodeGoUsageService } from '../src/usage/service.ts'
import { readUsageWindows } from '../src/usage/windows.ts'
import { UsageMeter } from '../src/usage/meter.ts'
import { SESSION_AFFINITY_HEADER, SESSION_HEADER } from '../src/session-header.ts'
import { CONSOLE_MODELS_FIXTURE } from './fixtures/console-models.ts'
import { offlineDocument, startMockGateway, stubModelsDev, modelsDevDocument } from './mock-gateway.ts'
import type { MockGateway } from './mock-gateway.ts'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { LlmError } from '@deepseek-ai/dsh-llm'

const DEFAULTS = { contextWindow: 128_000, maxTokens: 8192, input: ['text'] as const }

function mockFact(partial: Partial<ModelFacts> & Pick<ModelFacts, 'id' | 'api' | 'protocolSource'>): ModelFacts {
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    api: partial.api,
    protocolSource: partial.protocolSource,
    contextWindow: partial.contextWindow ?? 128_000,
    maxInputTokens: undefined,
    maxTokens: partial.maxTokens ?? 8192,
    assumedLimits: partial.assumedLimits ?? false,
    input: partial.input ?? ['text'],
    inputModalities: undefined,
    reasoning: partial.reasoning ?? false,
    thinkingLevelMap: undefined,
    compat: partial.compat ?? ({} as never),
    cost: partial.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    deprecated: partial.deprecated ?? false,
    releaseDate: undefined,
  }
}

const gateways: MockGateway[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(g => g.close()))
})

async function gateway(options?: Parameters<typeof startMockGateway>[0]): Promise<MockGateway> {
  const started = await startMockGateway(options)
  gateways.push(started)
  return started
}

describe('Console endpoint constant', () => {
  it('points to https://opencode.ai/inference/v1', () => {
    expect(CONSOLE_BASE_URL).toBe('https://opencode.ai/inference/v1')
    expect(DEFAULT_BASE_URL).toBe('https://opencode.ai/inference/go/v1')
  })
})

describe('Console 86 models catalog', () => {
  it('parses all 86 advertised models into callable facts with zero unavailable', async () => {
    const server = await gateway({ listing: CONSOLE_MODELS_FIXTURE })
    const stub = stubModelsDev(modelsDevDocument({}))
    try {
      const catalog = new OpencodeGoCatalog({
        baseURL: server.baseURL,
        refreshMs: 60_000,
        defaults: DEFAULTS,
        overrides: {},
        readDocument: offlineDocument(),
      })

      const snapshot = await catalog.snapshot()
      expect(snapshot.live).toBe(true)
      expect(snapshot.facts.size).toBe(86)
      expect(snapshot.unavailable.size).toBe(0)
      expect(snapshot.provider.getModels().length).toBe(86)

      // Verify every model has a valid wire protocol
      const validApis = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])
      for (const [id, fact] of snapshot.facts) {
        expect(validApis.has(fact.api)).toBe(true)
        expect(fact.id).toBe(id)
        expect(fact.contextWindow).toBeGreaterThan(0)
        expect(fact.maxTokens).toBeGreaterThan(0)
      }

      // Family rule verification: GPT, Grok, and Muse models infer openai-responses
      expect(snapshot.facts.get('gpt-5.5')?.api).toBe('openai-responses')
      expect(snapshot.facts.get('grok-4.5')?.api).toBe('openai-responses')
      expect(snapshot.facts.get('muse-spark-1.2')?.api).toBe('openai-responses')

      // Builtin models keep their accurate protocols
      expect(snapshot.facts.get('minimax-m3')?.api).toBe('anthropic-messages')
      expect(snapshot.facts.get('qwen3.8-flash')?.api).toBe('anthropic-messages')
      expect(snapshot.facts.get('glm-5.3')?.api).toBe('openai-completions')

      // Uncataloged new models assume route default limits
      const jev = snapshot.facts.get('jev-1.13')
      expect(jev).toBeDefined()
      expect(jev?.assumedLimits).toBe(true)
      expect(jev?.protocolSource).toBe('inferred')
      expect(jev?.api).toBe('openai-completions')
    } finally {
      stub.restore()
    }
  })

  it('supports explicit model discovery over all 86 models', async () => {
    const server = await gateway({ listing: CONSOLE_MODELS_FIXTURE })
    const stub = stubModelsDev(modelsDevDocument({}))
    try {
      const catalog = new OpencodeGoCatalog({
        baseURL: server.baseURL,
        refreshMs: 60_000,
        defaults: DEFAULTS,
        overrides: {},
        readDocument: offlineDocument(),
      })

      const discovered = await discoverCatalogModels(catalog)
      expect(discovered.length).toBe(86)
      const ids = new Set(discovered.map(m => m.id))
      expect(ids.has('claude-sonnet-4-6')).toBe(true)
      expect(ids.has('gpt-5.5')).toBe(true)
      expect(ids.has('deepseek-v4.1-flash')).toBe(true)
    } finally {
      stub.restore()
    }
  })

  it('formats model base URLs correctly for all three wire protocols on Console', () => {
    const consoleBase = 'https://opencode.ai/inference/v1'

    // Anthropic Messages strips /v1 so SDK can append /v1/messages -> /inference/v1/messages
    const messagesModel = toPiModel(mockFact({
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      api: 'anthropic-messages',
      protocolSource: 'builtin',
      contextWindow: 200_000,
      maxTokens: 8192,
    }), consoleBase)
    expect(messagesModel.baseUrl).toBe('https://opencode.ai/inference')

    // OpenAI Completions keeps /inference/v1 so SDK appends /chat/completions -> /inference/v1/chat/completions
    const completionsModel = toPiModel(mockFact({
      id: 'glm-5.1',
      name: 'GLM 5.1',
      api: 'openai-completions',
      protocolSource: 'inferred',
      assumedLimits: true,
    }), consoleBase)
    expect(completionsModel.baseUrl).toBe('https://opencode.ai/inference/v1')

    // OpenAI Responses keeps /inference/v1 so SDK appends /responses -> /inference/v1/responses
    const responsesModel = toPiModel(mockFact({
      id: 'gpt-5.5',
      name: 'GPT 5.5',
      api: 'openai-responses',
      protocolSource: 'inferred',
      assumedLimits: true,
    }), consoleBase)
    expect(responsesModel.baseUrl).toBe('https://opencode.ai/inference/v1')
  })
})

describe('Console usage degradation', () => {
  it('raises USAGE_UNAVAILABLE when /usage returns 404', async () => {
    // A mock server answering 404 for /usage
    const server = await gateway({ usageStatus: 404, usage: { error: 'Not found' } })
    // Direct readUsageWindows fails with USAGE_UNAVAILABLE
    await expect(readUsageWindows({
      baseURL: server.baseURL,
      apiKey: 'test-key',
    })).rejects.toThrow(LlmError)
  })

  it('converts /usage 404 into a graceful RemoteError in OpencodeGoUsageService', async () => {
    const server = await gateway({ usageStatus: 404, usage: { error: 'Not found' } })
    const ctx = new Context()
    const meter = new UsageMeter()

    // Service pointing to an endpoint where /usage answers 404
    const service = new OpencodeGoUsageService(ctx, {
      baseURL: () => server.baseURL,
      resolveApiKey: () => Promise.resolve('test-key'),
      meter,
    })

    try {
      await service.readWindows()
      expect.fail('should have thrown RemoteError')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(RemoteError)
      const remoteErr = err as RemoteError
      expect(remoteErr.code).toBe('dshopencodego/usage-unavailable')
      expect((remoteErr.details as { retryable?: boolean }).retryable).toBe(true)
    }
  })
})

describe('Console streaming on the wire', () => {
  it('streams chat completions with session and affinity headers against Console endpoint', async () => {
    const server = await gateway({ listing: CONSOLE_MODELS_FIXTURE })
    const stub = stubModelsDev(modelsDevDocument({}))
    try {
      const adapter = new OpencodeGoAdapter({
        config: () => ({
          enabled: true,
          modelVisibility: {},
          apiKeyEnv: 'OPENCODE_API_KEY',
          baseURL: server.baseURL,
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
        }),
        resolveApiKey: () => Promise.resolve('test-key'),
        readDocument: offlineDocument(),
      })

      const chunks: unknown[] = []
      const stream = adapter.stream({
        provider: 'opencode-go',
        model: 'glm-5.1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        sessionId: 'session-console-42' as never,
      })
      for await (const chunk of stream) {
        chunks.push(chunk)
      }

      // Verify request reached server with correct headers
      const request = server.requests.find(r => r.path.endsWith('/chat/completions'))
      expect(request).toBeDefined()
      expect(request!.headers[SESSION_HEADER]).toBe('session-console-42')
      expect(request!.headers[SESSION_AFFINITY_HEADER]).toBe('session-console-42')
      expect(request!.headers.authorization).toBe('Bearer test-key')
      expect(chunks.length).toBeGreaterThan(0)
    } finally {
      stub.restore()
    }
  })
})
