/**
 * The catalog wire contract: a reading survives the round trip with every
 * settings-facing field intact, and malformed payloads are refused.
 */
import { describe, expect, it } from 'vitest'
import { parseCatalogReading } from '../src/catalog/contract.ts'
import type { CatalogReading } from '../src/catalog/contract.ts'

const READING: CatalogReading = {
  models: [
    {
      id: 'priced',
      name: 'Priced',
      contextWindow: 100_000,
      maxInputTokens: 90_000,
      maxTokens: 10_000,
      releaseDate: '2026-09-20',
      goQuota: { monthlyUsd: 60, monthlyRequests: 150_400 },
      cost: { input: 0.14, output: 0.28, cacheRead: 0.0028 },
      protocolSource: 'builtin',
      assumedLimits: false,
      inputModalities: ['text', 'image'],
    },
    { id: 'old', name: 'Old', deprecated: true, protocolSource: 'inferred' },
    { id: 'ghost', name: 'ghost', configurationMissing: 'unknown protocol' },
  ],
  stale: false,
  fetchedAtMs: 7,
  counts: { total: 3, enabled: 1, deprecated: 1, unconfigured: 1, inferred: 1 },
}

describe('parseCatalogReading', () => {
  it('round-trips every settings-facing field', () => {
    const parsed = parseCatalogReading(JSON.parse(JSON.stringify(READING)))
    expect(parsed).toEqual(READING)
    expect(parsed.models[0]).toMatchObject({
      maxInputTokens: 90_000,
      releaseDate: '2026-09-20',
      goQuota: { monthlyUsd: 60, monthlyRequests: 150_400 },
      cost: { input: 0.14, output: 0.28, cacheRead: 0.0028 },
      inputModalities: ['text', 'image'],
    })
  })

  it('refuses malformed readings and models', () => {
    expect(() => parseCatalogReading(null)).toThrow(/invalid catalog reading/)
    expect(() => parseCatalogReading({ ...READING, counts: { total: -1 } })).toThrow()
    expect(() => parseCatalogReading({ ...READING, models: [{ id: '', name: 'x' }] })).toThrow(/invalid catalog model id/)
    expect(() => parseCatalogReading({ ...READING, models: [{ id: 'x', goQuota: { monthlyUsd: 'much' } }] })).toThrow()
    expect(() => parseCatalogReading({ ...READING, models: [{ id: 'x', cost: { input: -1, output: 0 } }] })).toThrow()
    expect(() => parseCatalogReading({ ...READING, models: [{ id: 'x', releaseDate: 'tomorrow' }] })).not.toThrow()
    // A modality the client cannot label is dropped instead of crossing the wire.
    expect(parseCatalogReading({ ...READING, models: [{ id: 'x', inputModalities: ['hologram'] }] }).models[0])
      .toEqual({ id: 'x', name: 'x' })
  })

  it('tolerates a reading without the newer optional fields', () => {
    const parsed = parseCatalogReading({
      models: [{ id: 'plain', name: 'Plain' }],
      stale: true,
      fetchedAtMs: 1,
      counts: { total: 1, enabled: 0, deprecated: 0, unconfigured: 0, inferred: 0 },
    })
    expect(parsed.models[0]).toEqual({ id: 'plain', name: 'Plain' })
  })
})
