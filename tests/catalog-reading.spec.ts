/**
 * The settings-facing catalog projection: what the page shows, and what it can
 * say about each model without asking the Host again.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { catalogReading } from '../src/catalog/reading.ts'
import { parseCatalogReading } from '../src/catalog/contract.ts'
import { OpencodeGoCatalog } from '../src/catalog/index.ts'
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

const DEFAULTS = { contextWindow: 262_144, maxTokens: 32_768, input: ['text'] as const }

describe('settings catalog reading', () => {
  it('keeps unconfigurable models visible, counts what the page shows, and sorts new first', async () => {
    const server = await gateway({ listing: ['glm-5.3', 'glm-5', 'brand-new', 'broken'] })
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 1000, output: 100 } },
      'glm-5': { name: 'GLM-5', reasoning: true, status: 'deprecated', limit: { context: 1000, output: 100 } },
      'brand-new': { name: 'Brand New', reasoning: true, release_date: '2026-09-23', limit: { context: 1000, output: 100 } },
      broken: { name: 'Broken', reasoning: true },
    }))
    try {
      const catalog = new OpencodeGoCatalog({
        baseURL: server.baseURL,
        refreshMs: 60_000,
        defaults: DEFAULTS,
        overrides: { broken: 'nonsense' },
      })
      const snapshot = await catalog.snapshot()
      const reading = catalogReading(snapshot, {})
      expect(reading.stale).toBe(false)
      expect(reading.models.map(model => model.id)).toEqual(['brand-new', 'glm-5.3', 'broken', 'glm-5'])
      expect(reading.counts).toEqual({ total: 4, enabled: 2, deprecated: 1, unconfigured: 1, inferred: 0 })
      expect(reading.models.find(model => model.id === 'broken')?.configurationMissing).toContain('nonsense')
      expect(reading.models.find(model => model.id === 'brand-new')?.protocolSource).toBeDefined()
      // An explicit switch flips the enabled count without touching the list.
      expect(catalogReading(snapshot, { 'glm-5': true }).counts.enabled).toBe(3)
    } finally {
      stub.restore()
    }
  })

  it('marks the recommended few when nobody configured switches', async () => {
    const server = await gateway({ listing: ['glm-5.3', 'glm-5'] })
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 1000, output: 100 } },
      'glm-5': { name: 'GLM-5', reasoning: true, status: 'deprecated', limit: { context: 1000, output: 100 } },
    }))
    try {
      const catalog = new OpencodeGoCatalog({
        baseURL: server.baseURL,
        refreshMs: 60_000,
        defaults: DEFAULTS,
        overrides: {},
      })
      const snapshot = await catalog.snapshot()
      const reading = catalogReading(snapshot, {})
      // Neither id carries a transcribed quota, so the default keeps the
      // non-deprecated one; an explicit switch still wins either way.
      expect(reading.models.find(model => model.id === 'glm-5.3')?.recommended).toBe(true)
      expect(reading.models.find(model => model.id === 'glm-5')?.recommended).toBe(false)
      expect(reading.counts.enabled).toBe(1)
      expect(catalogReading(snapshot, { 'glm-5.3': false }).counts.enabled).toBe(0)
    } finally {
      stub.restore()
    }
  })

  it('marks a retained reading stale and names the failure', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 1000, output: 100 } },
    }))
    try {
      const catalog = new OpencodeGoCatalog({ baseURL: server.baseURL, refreshMs: 60_000, defaults: DEFAULTS, overrides: {} })
      await catalog.snapshot()
      // Fail the live listing rather than closing the socket: a closed port
      // races the HTTP client's keep-alive pool and occasionally completes.
      server.setListingStatus(500)
      const stale = await catalog.snapshot(true)
      const reading = catalogReading(stale, {}, 'the live model listing is unreachable')
      expect(reading.stale).toBe(true)
      expect(reading.error).toBe('the live model listing is unreachable')
      expect(reading.models).toHaveLength(1)
    } finally {
      stub.restore()
    }
  })

  it('round-trips through the wire validator', () => {
    const reading = {
      models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000, maxTokens: 100, protocolSource: 'builtin' as const, assumedLimits: false }],
      stale: false,
      fetchedAtMs: 1,
      counts: { total: 1, enabled: 1, deprecated: 0, unconfigured: 0, inferred: 0 },
    }
    expect(parseCatalogReading(reading)).toEqual(reading)
    expect(() => parseCatalogReading({ ...reading, counts: { total: -1 } })).toThrow(/invalid catalog count/)
    expect(() => parseCatalogReading({ ...reading, models: [{ name: 'no id' }] })).toThrow(/invalid catalog model/)
  })
})
