/**
 * Catalog contract: the four-level protocol ladder, online metadata parsing,
 * and the caching/failure behaviour of the live snapshot.
 *
 * The gateway is a real HTTP server and models.dev is intercepted at the fetch
 * boundary, so these tests exercise the same code path a session does.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OpencodeGoCatalog, discoverCatalogModels } from '../src/catalog/index.ts'
import { readOnlineMetadata, toPiModel } from '../src/catalog/metadata.ts'
import { decideProtocol, inferProtocol, protocolOfNpm } from '../src/catalog/protocol.ts'
import { startMockGateway, stubModelsDev, modelsDevDocument } from './mock-gateway.ts'
import type { MockGateway } from './mock-gateway.ts'

const DEFAULTS = { contextWindow: 262_144, maxTokens: 32_768, input: ['text'] as const }

const gateways: MockGateway[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
})

async function gateway(options?: Parameters<typeof startMockGateway>[0]): Promise<MockGateway> {
  const started = await startMockGateway(options)
  gateways.push(started)
  return started
}

function catalogFor(baseURL: string, overrides: Record<string, string> = {}, observers = {}): OpencodeGoCatalog {
  return new OpencodeGoCatalog({
    baseURL,
    refreshMs: 60_000,
    defaults: DEFAULTS,
    overrides,
    observers,
  })
}

describe('protocol ladder', () => {
  it('prefers the installed entry over the online hint', () => {
    expect(decideProtocol('minimax-m2.7', { builtin: 'openai-completions', online: 'anthropic-messages' }))
      .toEqual({ api: 'openai-completions', source: 'builtin' })
  })

  it('falls back to the online hint when nothing is installed', () => {
    expect(decideProtocol('minimax-m2.5', { online: 'anthropic-messages' }))
      .toEqual({ api: 'anthropic-messages', source: 'online' })
  })

  it('lets an explicit override win over every source', () => {
    expect(decideProtocol('glm-5', { builtin: 'openai-completions', online: 'anthropic-messages', override: 'openai-responses' }))
      .toEqual({ api: 'openai-responses', source: 'override' })
  })

  it('infers only the two families the installed catalog agrees on', () => {
    for (const id of ['grok-4.5', 'gpt-6-luna', 'muse-spark-1.4']) expect(inferProtocol(id)).toBe('openai-responses')
    // Qwen and MiniMax are deliberately not family rules: the catalog serves
    // qwen3.8-flash and minimax-m3 over messages while serving qwen3.6-plus,
    // qwen3.7-max and minimax-m2.7 over completions.
    for (const id of ['qwen3.9-max', 'minimax-m4', 'deepseek-flash', 'hy3-preview']) {
      expect(inferProtocol(id)).toBe('openai-completions')
    }
  })

  it('maps the three AI SDK package names models.dev uses', () => {
    expect(protocolOfNpm('@ai-sdk/anthropic')).toBe('anthropic-messages')
    expect(protocolOfNpm('@ai-sdk/openai')).toBe('openai-responses')
    expect(protocolOfNpm('@ai-sdk/openai-compatible')).toBe('openai-completions')
    expect(protocolOfNpm('@ai-sdk/google')).toBeUndefined()
    expect(protocolOfNpm(undefined)).toBeUndefined()
  })
})

describe('online metadata parsing', () => {
  const sources = { builtin: new Map(), defaults: DEFAULTS, overrides: {} }

  it('takes protocol, capacities, modalities, pricing and lifecycle from models.dev', () => {
    const { models, errors } = readOnlineMetadata(modelsDevDocument({
      'glm-5.3': {
        name: 'GLM-5.3', reasoning: true, modalities: { input: ['text', 'image'] },
        limit: { context: 1_000_000, output: 131_072 },
        cost: { input: 1.4, output: 4.4, cache_read: 0.26 },
        release_date: '2026-09-01', interleaved: { field: 'reasoning_content' },
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
    }), sources)
    expect(errors.size).toBe(0)
    const facts = models.get('glm-5.3')!
    expect(facts).toMatchObject({
      api: 'openai-completions', protocolSource: 'online', contextWindow: 1_000_000, maxTokens: 131_072,
      input: ['text', 'image'], reasoning: true, deprecated: false, assumedLimits: false, releaseDate: '2026-09-01',
    })
    expect(facts.cost).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 })
    expect(facts.compat).toMatchObject({
      supportsStore: false, maxTokensField: 'max_tokens', requiresReasoningContentOnAssistantMessages: true,
    })
    expect(facts.thinkingLevelMap).toMatchObject({ low: 'low', high: 'high', off: null })
  })

  it('marks a model whose capacities no source states as assumed', () => {
    const { models } = readOnlineMetadata(modelsDevDocument({ 'mystery-model': { reasoning: true } }), sources)
    const facts = models.get('mystery-model')!
    expect(facts).toMatchObject({ assumedLimits: true, contextWindow: DEFAULTS.contextWindow, maxTokens: DEFAULTS.maxTokens })
  })

  it('gives Responses models the affinity format the gateway needs', () => {
    const { models } = readOnlineMetadata(modelsDevDocument({
      'grok-4.7': { reasoning: true, provider: { npm: '@ai-sdk/openai' }, limit: { context: 500_000, output: 500_000 } },
    }), sources)
    expect(models.get('grok-4.7')!.compat).toMatchObject({ sessionAffinityFormat: 'openai-nosession' })
  })

  it('marks a deprecated model and keeps it addressable', () => {
    const { models } = readOnlineMetadata(modelsDevDocument({
      'glm-5': { reasoning: true, status: 'deprecated', limit: { context: 1000, output: 100 } },
    }), sources)
    expect(models.get('glm-5')).toMatchObject({ deprecated: true, api: 'openai-completions' })
  })

  it('isolates a bad entry instead of discarding the document', () => {
    const { models, errors } = readOnlineMetadata(modelsDevDocument({
      good: { reasoning: true, limit: { context: 1000, output: 100 } },
      bad: { reasoning: true, limit: { context: 'many', output: 0 } },
    }), { ...sources, overrides: { bad: 'not-a-protocol' } })
    expect([...models.keys()]).toEqual(['good'])
    expect(errors.get('bad')).toContain('not-a-protocol')
  })

  it('refuses a document with no opencode-go models object', () => {
    expect(() => readOnlineMetadata({ 'opencode-go': {} }, sources)).toThrow(/models object/)
  })

  it('inherits wire quirks from a known sibling in the same family', () => {
    const builtin = new Map([['deepseek-v4-flash', {
      id: 'deepseek-v4-flash', api: 'openai-completions', compat: { thinkingFormat: 'deepseek' },
    }]]) as never
    const { models } = readOnlineMetadata(modelsDevDocument({
      'deepseek-v4.1-flash': {
        reasoning: true, family: 'deepseek', limit: { context: 1000, output: 100 },
      },
    }), { builtin, defaults: DEFAULTS, overrides: {} })
    expect(models.get('deepseek-v4.1-flash')!.compat).toMatchObject({ thinkingFormat: 'deepseek' })
  })

  it('keeps the Anthropic base URL free of the /v1 the SDK appends', () => {
    const { models } = readOnlineMetadata(modelsDevDocument({
      'minimax-m3': { reasoning: true, provider: { npm: '@ai-sdk/anthropic' }, limit: { context: 1000, output: 100 } },
    }), sources)
    const model = toPiModel(models.get('minimax-m3')!, 'https://opencode.ai/zen/go/v1')
    expect(model.api).toBe('anthropic-messages')
    expect(model.baseUrl).toBe('https://opencode.ai/zen/go')
  })
})

describe('live catalog', () => {
  it('takes membership from the gateway and capability from models.dev', async () => {
    const server = await gateway({ listing: ['glm-5.3', 'minimax-m2.5', 'kimi-k3', 'brand-new-model'] })
    const stub = stubModelsDev(modelsDevDocument({
      // Known to the installed catalog: level 1 supplies the protocol, level 2
      // still supplies the capacities.
      'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 1000, output: 100 } },
      // Absent from the installed catalog, present online with an explicit
      // protocol hint: level 2 supplies both.
      'minimax-m2.5': {
        name: 'MiniMax-M2.5', reasoning: true, provider: { npm: '@ai-sdk/anthropic' },
        limit: { context: 200_000, output: 65_536 },
      },
    }))
    try {
      const snapshot = await catalogFor(server.baseURL).snapshot()
      expect([...snapshot.facts.keys()]).toEqual(['glm-5.3', 'minimax-m2.5', 'kimi-k3', 'brand-new-model'])
      expect(snapshot.live).toBe(true)
      expect(snapshot.facts.get('glm-5.3')).toMatchObject({
        protocolSource: 'builtin', api: 'openai-completions', contextWindow: 1000, assumedLimits: false,
      })
      expect(snapshot.facts.get('minimax-m2.5')).toMatchObject({
        protocolSource: 'online', api: 'anthropic-messages', contextWindow: 200_000,
      })
      // kimi-k3 is absent from this document but present in the installed
      // catalog: the ladder's first rung supplies its protocol and capacities.
      expect(snapshot.facts.get('kimi-k3')).toMatchObject({ protocolSource: 'builtin', assumedLimits: false })
      // brand-new-model is described by nothing at all: the family rule picks
      // the gateway's own default protocol and the route sizes it.
      expect(snapshot.facts.get('brand-new-model')).toMatchObject({
        api: 'openai-completions', protocolSource: 'inferred', assumedLimits: true,
      })
    } finally {
      stub.restore()
    }
  })

  it('serves a cached snapshot inside the refresh interval', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(modelsDevDocument({}))
    try {
      const catalog = catalogFor(server.baseURL)
      await catalog.snapshot()
      await catalog.snapshot()
      expect(server.requests.filter(request => request.path.endsWith('/models'))).toHaveLength(1)
      expect(stub.requests).toHaveLength(1)
    } finally {
      stub.restore()
    }
  })

  it('revalidates when an unknown model is requested', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(modelsDevDocument({}))
    try {
      const catalog = catalogFor(server.baseURL)
      await catalog.snapshot()
      server.setListing(['glm-5.3', 'brand-new'])
      const snapshot = await catalog.forModel('brand-new')
      expect(snapshot.facts.has('brand-new')).toBe(true)
      expect(server.requests.filter(request => request.path.endsWith('/models'))).toHaveLength(2)
    } finally {
      stub.restore()
    }
  })

  it('keeps the last successful listing when the gateway fails, and refuses explicit discovery', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(modelsDevDocument({}))
    const fallbacks: unknown[] = []
    try {
      const catalog = catalogFor(server.baseURL, {}, { onFallback: (detail: unknown) => fallbacks.push(detail) })
      await catalog.snapshot()
      // Fail the live listing instead of closing the socket: a closed port
      // races the HTTP client's keep-alive pool and occasionally completes.
      server.setListingStatus(500)
      const stale = await catalog.snapshot(true)
      expect(stale.live).toBe(false)
      expect([...stale.facts.keys()]).toEqual(['glm-5.3'])
      expect(fallbacks).toHaveLength(1)
      await expect(discoverCatalogModels(catalog)).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    } finally {
      stub.restore()
    }
  })

  it('reports an unconfigured id instead of failing the whole listing', async () => {
    const server = await gateway({ listing: ['glm-5.3', 'bad-model'] })
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { reasoning: true, limit: { context: 1000, output: 100 } },
      'bad-model': { reasoning: true },
    }))
    const reported: { id: string; reason: string }[] = []
    try {
      const catalog = catalogFor(server.baseURL, { 'bad-model': 'nonsense' }, {
        onUnconfigured: (detail: { id: string; reason: string }[]) => reported.push(...detail),
      })
      const snapshot = await catalog.snapshot()
      expect([...snapshot.facts.keys()]).toEqual(['glm-5.3'])
      expect(snapshot.unavailable.get('bad-model')).toContain('nonsense')
      expect(reported).toHaveLength(1)
      await expect(catalog.forModel('bad-model')).rejects.toMatchObject({ code: 'MODEL_METADATA_UNAVAILABLE' })
    } finally {
      stub.restore()
    }
  })

  it('survives a models.dev outage after one successful read', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 4096, output: 512 } },
    }))
    const fallbacks: unknown[] = []
    try {
      const catalog = catalogFor(server.baseURL, {}, { onFallback: (detail: unknown) => fallbacks.push(detail) })
      const first = await catalog.snapshot()
      expect(first.facts.get('glm-5.3')).toMatchObject({ contextWindow: 4096, assumedLimits: false })
      stub.restore()
      const failing = stubModelsDev({}, 500)
      try {
        const second = await catalog.snapshot(true)
        // The last successful document is better evidence than the installed
        // catalog alone, so its capacities survive the outage.
        expect(second.facts.get('glm-5.3')).toMatchObject({ contextWindow: 4096, maxTokens: 512, assumedLimits: false })
        expect(second.live).toBe(true)
        expect(fallbacks).toHaveLength(1)
      } finally {
        failing.restore()
      }
    } finally {
      stub.restore()
    }
  })

  it('builds a pi-ai provider holding exactly the callable models', async () => {
    const server = await gateway({ listing: ['glm-5.3', 'kimi-k3'] })
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 1000, output: 100 } },
    }))
    try {
      const snapshot = await catalogFor(server.baseURL).snapshot()
      expect(snapshot.provider.id).toBe('opencode-go')
      expect(snapshot.provider.getModels().map(model => model.id).sort()).toEqual(['glm-5.3', 'kimi-k3'])
      expect(snapshot.provider.getModels().find(model => model.id === 'glm-5.3')!.baseUrl)
        .toBe(server.baseURL)
    } finally {
      stub.restore()
    }
  })
})
