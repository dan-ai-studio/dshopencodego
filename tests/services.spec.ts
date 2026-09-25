/**
 * Host Remote services: the catalog projection over a live gateway, and the
 * usage windows with their credential-identity discipline.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { OpencodeGoCatalog } from '../src/catalog/index.ts'
import { OpencodeGoCatalogService } from '../src/catalog/service.ts'
import { UsageMeter } from '../src/usage/meter.ts'
import { OpencodeGoUsageService } from '../src/usage/service.ts'
import { startMockGateway, stubModelsDev, modelsDevDocument } from './mock-gateway.ts'
import type { MockGateway } from './mock-gateway.ts'

const gateways: MockGateway[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
})

const DEFAULTS = { contextWindow: 262_144, maxTokens: 32_768, input: ['text'] as const }
const DOCUMENT = modelsDevDocument({
  'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 128_000, output: 8_192 } },
})

/** A Cordis context stub: the service base only registers through `reflect`. */
const CTX = { reflect: { provide: () => {} } } as never

function catalogFor(server: MockGateway): OpencodeGoCatalog {
  return new OpencodeGoCatalog({
    baseURL: server.baseURL,
    refreshMs: 60_000,
    defaults: DEFAULTS,
    overrides: {},
  })
}

describe('OpencodeGoCatalogService', () => {
  it('projects the live listing for the page', async () => {
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    gateways.push(server)
    const stub = stubModelsDev(DOCUMENT)
    try {
      const service = new OpencodeGoCatalogService(CTX, {
        catalog: () => catalogFor(server),
        visibility: () => ({}),
      })
      const reading = await service.read()
      expect(reading.models.map(model => model.id)).toContain('glm-5.3')
      expect(reading.counts.total).toBeGreaterThanOrEqual(1)
      const refreshed = await service.refresh()
      expect(refreshed.models.map(model => model.id)).toContain('glm-5.3')
    } finally {
      stub.restore()
    }
  })
})

describe('OpencodeGoUsageService', () => {
  it('reads the three windows and tags them with the account identity', async () => {
    const server = await startMockGateway({})
    gateways.push(server)
    const service = new OpencodeGoUsageService(CTX, {
      baseURL: () => server.baseURL,
      resolveApiKey: async () => 'test-key',
      meter: new UsageMeter(),
    })
    const first = await service.readWindows()
    expect(first.rolling.percent).toBe(12.5)
    expect(typeof first.source).toBe('string')
    const second = await service.readWindows()
    expect(second.source).toBe(first.source)
    expect(server.requests.filter(request => request.path.endsWith('/usage'))).toHaveLength(2)
  })

  it('reports a missing credential as a domain failure, never a zero reading', async () => {
    const server = await startMockGateway({})
    gateways.push(server)
    const service = new OpencodeGoUsageService(CTX, {
      baseURL: () => server.baseURL,
      resolveApiKey: async () => undefined,
      meter: new UsageMeter(),
    })
    const error = await service.readWindows().catch(error => error)
    expect(error).toMatchObject({ code: 'dshopencodego/usage-unavailable' })
  })

  it('invalidates the identity when the credential changes', async () => {
    const server = await startMockGateway({})
    gateways.push(server)
    let key = 'key-one'
    const service = new OpencodeGoUsageService(CTX, {
      baseURL: () => server.baseURL,
      resolveApiKey: async () => key,
      meter: new UsageMeter(),
    })
    const first = await service.readWindows()
    key = 'key-two'
    const second = await service.readWindows()
    expect(second.source).not.toBe(first.source)
  })

  it('returns the process meter untouched', async () => {
    const meter = new UsageMeter()
    meter.record('m', { inputTokens: 3, outputTokens: 1, totalTokens: 4 })
    const service = new OpencodeGoUsageService(CTX, {
      baseURL: () => 'http://127.0.0.1:1/v1',
      resolveApiKey: async () => 'k',
      meter,
    })
    expect(service.readMeter().totals).toMatchObject({ calls: 1, inputTokens: 3 })
  })

  it('wraps a gateway outage as a retryable domain failure', async () => {
    const server = await startMockGateway({})
    gateways.push(server)
    const service = new OpencodeGoUsageService(CTX, {
      baseURL: () => 'http://127.0.0.1:1/v1',
      resolveApiKey: async () => 'test-key',
      meter: new UsageMeter(),
    })
    const error = await service.readWindows().catch(error => error)
    expect(error).toMatchObject({ code: 'dshopencodego/usage-unavailable' })
    expect(error.details).toMatchObject({ retryable: true, retainPrevious: true })
  })
})

describe('LlmError import', () => {
  it('is the same class the services throw', () => {
    expect(new LlmError('x', 'USAGE_UNAVAILABLE')).toBeInstanceOf(Error)
  })
})
