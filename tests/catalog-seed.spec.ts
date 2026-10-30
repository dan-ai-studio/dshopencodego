/**
 * The bundled catalog seed: a floor, not a peer.
 *
 * A process that starts with an empty disk cache has nothing to serve, so
 * its first request waits on the gateway listing, the models.dev document,
 * and the provider's documentation — downloads measured in seconds, landing
 * exactly where a user notices them. The seed baked in at publish time
 * fills that hole: the first read is answered at once and refreshed behind
 * it, exactly like a remembered disk reading.
 *
 * These cases pin the three rules that keep a stale bundle honest:
 *
 * - the seed is only served when the disk has nothing and the endpoint
 *   matches — it never overrides a real cache and never crosses endpoints;
 * - staleness has a hard one-day ceiling no TTL can stretch past;
 * - a background refresh that succeeds is written down, so the next
 *   process starts from it instead of from the seed again.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpencodeGoCatalog, snapshotIsFresh } from '../src/catalog/index.ts'
import type { GoDoc } from '../src/catalog/go-doc.ts'
import { DEFAULT_BASE_URL } from '../src/catalog/constants.ts'
import { parseSnapshotFile, readSnapshotCache } from '../src/catalog/snapshot-cache.ts'
import seedFile from '../src/catalog/seed.snapshot.json' with { type: 'json' }
import {
  modelsDevDocument,
  offlineDocument,
  startMockGateway,
  stubModelsDev,
} from './mock-gateway.ts'
import type { MockGateway } from './mock-gateway.ts'

const gateways: MockGateway[] = []
const directories: string[] = []
const catalogs: OpencodeGoCatalog[] = []
afterEach(async () => {
  await Promise.all(catalogs.splice(0).map(catalog => catalog.settled()))
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const DEFAULTS = { contextWindow: 1_000_000, maxTokens: 128_000, input: ['text'] as const }
const HOUR = 3_600_000
const DAY = 24 * HOUR

function cacheDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dshopencodego-seed-'))
  directories.push(directory)
  return directory
}

/** A minimal fact the catalog can project and serve. */
function fact(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    protocolSource: 'inferred',
    contextWindow: 1000,
    maxTokens: 100,
    assumedLimits: true,
    input: ['text'],
    reasoning: false,
    deprecated: false,
    cost: { input: 1, output: 2 },
    compat: {},
  }
}

/** A snapshot document in the file's own shape. */
function seedDoc(baseURL: string, ids: readonly string[], updatedAt: number): unknown {
  return {
    version: 1,
    baseURL,
    facts: Object.fromEntries(ids.map(id => [id, fact(id)])),
    protocols: {},
    updatedAt,
  }
}

function catalogFor(options: {
  baseURL: string
  refreshMs?: number
  directory?: string
  seed?: unknown
  readDocument?: (signal?: AbortSignal) => Promise<GoDoc>
}): OpencodeGoCatalog {
  const catalog = new OpencodeGoCatalog({
    baseURL: options.baseURL,
    refreshMs: options.refreshMs ?? 60_000,
    defaults: DEFAULTS,
    overrides: {},
    ...options.directory === undefined ? {} : { cacheDir: options.directory },
    ...options.seed === undefined ? {} : { seed: options.seed },
    ...options.readDocument === undefined ? {} : { readDocument: options.readDocument },
  })
  catalogs.push(catalog)
  return catalog
}

describe('the bundled seed', () => {
  it('parses, names the gateway it was built for, and is not empty', () => {
    const parsed = parseSnapshotFile(seedFile)
    expect(parsed).toBeDefined()
    expect(parsed?.facts.size).toBeGreaterThan(0)
    // The endpoint check is what keeps one gateway's seed from serving
    // another, so the file must name it.
    expect(parsed?.baseURL).toBe(DEFAULT_BASE_URL)
  })

  it('answers at once when the disk is empty, then refreshes behind it', async () => {
    // No network anywhere: fetch rejects, so the only possible answer is
    // the seed — and it must arrive without waiting for anything.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    try {
      const updatedAt = Date.now() - 48 * HOUR
      const catalog = catalogFor({
        baseURL: 'https://seed.invalid/v1',
        directory: cacheDir(),
        seed: seedDoc('https://seed.invalid/v1', ['seed-model'], updatedAt),
      })
      const started = Date.now()
      const snapshot = await catalog.snapshot()
      expect(Date.now() - started).toBeLessThan(1000)
      expect(snapshot.facts.has('seed-model')).toBe(true)
      expect(snapshot.cached).toBe(true)
      expect(snapshot.live).toBe(false)
      // Served as-is: the age is the seed's, not now.
      expect(snapshot.fetchedAtMs).toBe(updatedAt)
      // The background refresh ran and failed quietly; the seed still stands.
      await catalog.settled()
      const again = await catalog.snapshot()
      expect(again.facts.has('seed-model')).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ignores a seed built for another endpoint', async () => {
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    gateways.push(server)
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 1000, output: 100 } },
    }))
    try {
      const catalog = catalogFor({
        baseURL: server.baseURL,
        directory: cacheDir(),
        seed: seedDoc('https://other.invalid/v1', ['seed-model'], Date.now()),
        readDocument: offlineDocument(),
      })
      const snapshot = await catalog.snapshot()
      // Built from the wire, not the seed.
      expect(snapshot.live).toBe(true)
      expect(snapshot.facts.has('glm-5.3')).toBe(true)
      expect(snapshot.facts.has('seed-model')).toBe(false)
    } finally {
      stub.restore()
    }
  })

  it('prefers the disk over an older seed', async () => {
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    gateways.push(server)
    // No network: the only readable catalog is the one already on disk.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    try {
      const directory = cacheDir()
      const diskUpdatedAt = Date.now()
      writeFileSync(join(directory, 'catalog-snapshot.json'), JSON.stringify({
        version: 1,
        facts: { 'disk-model': fact('disk-model') },
        protocols: {},
        updatedAt: diskUpdatedAt,
      }))
      const catalog = catalogFor({
        baseURL: server.baseURL,
        directory,
        seed: seedDoc(server.baseURL, ['seed-model'], 1),
      })
      const snapshot = await catalog.snapshot()
      expect(snapshot.facts.has('disk-model')).toBe(true)
      expect(snapshot.facts.has('seed-model')).toBe(false)
      expect(snapshot.fetchedAtMs).toBe(diskUpdatedAt)
      await catalog.settled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('persists a successful background refresh, so restarts keep it', async () => {
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    gateways.push(server)
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 1000, output: 100 } },
    }))
    try {
      const directory = cacheDir()
      const oldTime = Date.now() - 48 * HOUR
      writeFileSync(join(directory, 'catalog-snapshot.json'), JSON.stringify({
        version: 1,
        facts: { 'old-model': fact('old-model') },
        protocols: {},
        updatedAt: oldTime,
      }))
      // A seven-day TTL would call this fresh: only the one-day ceiling
      // makes it stale enough to refresh in the background.
      const catalog = catalogFor({
        baseURL: server.baseURL,
        refreshMs: 7 * DAY,
        directory,
        readDocument: offlineDocument(),
      })
      const snapshot = await catalog.snapshot()
      // The old reading answers at once, marked stale.
      expect(snapshot.facts.has('old-model')).toBe(true)
      expect(snapshot.live).toBe(false)
      await catalog.settled()
      // And the refresh that followed wrote the new reading down: the next
      // process starts from the gateway's listing, not from the old file.
      const after = readSnapshotCache(directory)
      expect(after?.updatedAt).toBeGreaterThan(oldTime)
      expect(after?.facts.has('glm-5.3')).toBe(true)
    } finally {
      stub.restore()
    }
  })
})

describe('snapshot freshness', () => {
  const now = 1_700_000_000_000

  it('treats a missing snapshot as stale', () => {
    expect(snapshotIsFresh(0, now, 60_000)).toBe(false)
  })

  it('honours a TTL shorter than the ceiling', () => {
    const hour = 60 * 60_000
    expect(snapshotIsFresh(now - 30 * 60_000, now, hour)).toBe(true)
    expect(snapshotIsFresh(now - 61 * 60_000, now, hour)).toBe(false)
  })

  it('caps a longer TTL at a day', () => {
    const week = 7 * DAY
    expect(snapshotIsFresh(now - 23 * HOUR, now, week)).toBe(true)
    expect(snapshotIsFresh(now - 25 * HOUR, now, week)).toBe(false)
  })
})
