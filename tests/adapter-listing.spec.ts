/**
 * Adapter listing: what the picker sees, under the same default rule the
 * settings page marks — the top few by published monthly estimate when nobody
 * configured switches, explicit switches always winning.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OpencodeGoAdapter } from '../src/adapter.ts'
import type { OpencodeGoConfig } from '../src/config.ts'
import { startMockGateway, stubModelsDev, modelsDevDocument } from './mock-gateway.ts'
import type { MockGateway } from './mock-gateway.ts'

const gateways: MockGateway[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
})

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

/** Quota-bearing models: the estimate decides the default, not the listing order. */
const DOCUMENT = modelsDevDocument({
  'zz-cheap': { name: 'ZZ Cheap', reasoning: false, limit: { context: 10_000, output: 1_000 } },
  'aa-expensive': { name: 'AA Expensive', reasoning: false, limit: { context: 10_000, output: 1_000 } },
})

describe('adapter listing', () => {
  it('defaults to the top models by published monthly estimate', async () => {
    const server = await startMockGateway({ listing: ['zz-cheap', 'aa-expensive'] })
    gateways.push(server)
    const stub = stubModelsDev(DOCUMENT)
    try {
      const adapter = new OpencodeGoAdapter({
        config: () => configFor(server.baseURL),
        resolveApiKey: async () => 'test-key',
      })
      const models = await adapter.listModels('opencode-go')
      // Neither id carries a transcribed quota, so the default keeps the
      // non-deprecated pair; the estimate order is asserted in models.spec.ts.
      expect(models.map(model => model.id).toSorted()).toEqual(['aa-expensive', 'zz-cheap'])
      for (const model of models) expect(model.provider).toBe('opencode-go')
    } finally {
      stub.restore()
    }
  })

  it('lets an explicit switch hide a recommended model', async () => {
    const server = await startMockGateway({ listing: ['zz-cheap', 'aa-expensive'] })
    gateways.push(server)
    const stub = stubModelsDev(DOCUMENT)
    try {
      const adapter = new OpencodeGoAdapter({
        config: () => configFor(server.baseURL, { modelVisibility: { 'zz-cheap': false } }),
        resolveApiKey: async () => 'test-key',
      })
      const models = await adapter.listModels('opencode-go')
      expect(models.map(model => model.id)).toEqual(['aa-expensive'])
    } finally {
      stub.restore()
    }
  })

  it('rejects an unknown model id instead of guessing a protocol', async () => {
    const server = await startMockGateway({ listing: ['zz-cheap'] })
    gateways.push(server)
    const stub = stubModelsDev(DOCUMENT)
    try {
      const adapter = new OpencodeGoAdapter({
        config: () => configFor(server.baseURL),
        resolveApiKey: async () => 'test-key',
      })
      await expect(adapter.resolveModel('opencode-go', 'definitely-not-a-real-model', undefined as never))
        .rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    } finally {
      stub.restore()
    }
  })
})
