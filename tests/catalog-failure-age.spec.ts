/**
 * What an outage costs, and how long it lasts.
 *
 * The catalog is stale-while-revalidate: a snapshot that has outlived its TTL
 * is still served, and the refresh goes on behind it. The failure path has one
 * job beyond keeping the last known models: it must not make the outage look
 * like a fresh reading.
 *
 * A failed refresh used to stamp the snapshot with the time of the failure,
 * which reset the TTL. The refresh behind it then waited a whole TTL before
 * asking again, so a gateway that came back after a minute was not noticed
 * until an hour had passed — and the five-minute back-off never ran at all,
 * because a TTL that had not expired never reached it.
 *
 * These cases hold the line: a failure keeps the age of the last reading that
 * succeeded, the back-off governs how often a down gateway is asked, and a
 * gateway that comes back is picked up within that window.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpencodeGoCatalog } from '../src/catalog/index.ts'
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

beforeEach(() => {
  // Only the clock is faked: the catalog measures its age with `Date.now()`,
  // and the network must stay real.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
})

afterEach(async () => {
  await Promise.all(catalogs.splice(0).map(catalog => catalog.settled()))
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.useRealTimers()
})

const DEFAULTS = { contextWindow: 262_144, maxTokens: 32_768, input: ['text'] as const }
const ONE_HOUR_MS = 60 * 60_000
const FIVE_MINUTES_MS = 5 * 60_000

/** The moment the clock reads, in epoch milliseconds. */
function now(): number {
  return Date.now()
}

/** Move the clock forward by a number of milliseconds. */
function advance(ms: number): void {
  vi.setSystemTime(new Date(now() + ms))
}

/** A fresh cache directory. */
function cacheDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dshopencodego-failure-'))
  directories.push(directory)
  return directory
}

/** How many times the gateway listing was read. */
function listingReads(server: MockGateway): number {
  return server.requests.filter(request => request.path.endsWith('/models')).length
}

/** A catalog over one gateway, on the production cache lifetime. */
function catalogFor(server: MockGateway): OpencodeGoCatalog {
  const catalog = new OpencodeGoCatalog({
    baseURL: server.baseURL,
    refreshMs: ONE_HOUR_MS,
    defaults: DEFAULTS,
    overrides: {},
    cacheDir: cacheDir(),
    readDocument: offlineDocument(),
  })
  catalogs.push(catalog)
  return catalog
}

/** A gateway that answers, and the models.dev document behind it. */
async function gatewayAndDocument(): Promise<{
  server: MockGateway
  restore: () => void
}> {
  const server = await startMockGateway({ listing: ['glm-5.3'] })
  gateways.push(server)
  const stub = stubModelsDev(modelsDevDocument({
    'glm-5.3': {
      name: 'GLM-5.3',
      reasoning: true,
      limit: { context: 1000, output: 100 },
    },
  }))
  return { server, restore: stub.restore }
}

describe('an outage', () => {
  it('keeps the age of the last reading that succeeded', async () => {
    const { server, restore } = await gatewayAndDocument()
    try {
      const catalog = catalogFor(server)
      const good = await catalog.snapshot(true)
      expect(good.live).toBe(true)
      const succeededAt = good.fetchedAtMs
      expect(succeededAt).toBe(now())

      server.setListingStatus(500)
      advance(60_000)
      const failed = await catalog.snapshot(true)
      expect(failed.live).toBe(false)
      // The models are the ones that were known, so the reading is as old as
      // they are. The failure is not new knowledge.
      expect([...failed.facts.keys()]).toEqual(['glm-5.3'])
      expect(failed.fetchedAtMs).toBe(succeededAt)
    } finally {
      restore()
    }
  })

  it('is asked once while it lasts, and recovers within the back-off', async () => {
    const { server, restore } = await gatewayAndDocument()
    try {
      const catalog = catalogFor(server)
      await catalog.snapshot(true)
      const readsWhenHealthy = listingReads(server)
      expect(readsWhenHealthy).toBe(1)

      // The gateway goes down, and the TTL runs out.
      server.setListingStatus(500)
      advance(ONE_HOUR_MS + 60_000)
      await catalog.snapshot()
      await catalog.settled()
      const readsWhenDown = listingReads(server)
      expect(readsWhenDown).toBe(2)
      expect((await catalog.snapshot()).live).toBe(false)

      // The gateway comes back with a model it did not have before.
      server.setListingStatus(200)
      server.setListing(['glm-5.3', 'brand-new-model'])

      // Inside the back-off window the gateway is not asked again.
      advance(2 * 60_000)
      await catalog.snapshot()
      await catalog.settled()
      expect(listingReads(server)).toBe(readsWhenDown)
      expect([...(await catalog.snapshot()).facts.keys()]).not.toContain('brand-new-model')

      // Past it, the next call asks, and the recovery is seen at once.
      advance(4 * 60_000)
      await catalog.snapshot()
      await catalog.settled()
      expect(listingReads(server)).toBe(readsWhenDown + 1)
      const recovered = await catalog.snapshot()
      expect(recovered.live).toBe(true)
      expect([...recovered.facts.keys()]).toContain('brand-new-model')
    } finally {
      restore()
    }
  })

  it('does not ask a down gateway again after a failed forced refresh', async () => {
    const { server, restore } = await gatewayAndDocument()
    try {
      const catalog = catalogFor(server)
      await catalog.snapshot(true)
      // The failure lands close to the end of the TTL, so the TTL is about to
      // run out while the back-off is still in force. That is the only window
      // in which the two rules disagree, and it is the window that matters:
      // without the back-off the gateway would be asked again at once.
      advance(58 * 60_000)
      server.setListingStatus(500)
      const failed = await catalog.snapshot(true)
      expect(failed.live).toBe(false)
      const readsAfterFailure = listingReads(server)

      // The TTL has now run out, but the back-off has not.
      advance(3 * 60_000)
      await catalog.snapshot()
      await catalog.settled()
      expect(listingReads(server)).toBe(readsAfterFailure)

      // A human may ask again at any time.
      server.setListingStatus(200)
      server.setListing(['glm-5.3', 'brand-new-model'])
      const forced = await catalog.snapshot(true)
      expect(forced.live).toBe(true)
      expect([...forced.facts.keys()]).toContain('brand-new-model')
    } finally {
      restore()
    }
  })

  it('treats a first reading that never answered as already stale', async () => {
    const { server, restore } = await gatewayAndDocument()
    try {
      server.setListingStatus(500)
      const catalog = catalogFor(server)
      const first = await catalog.snapshot(true)
      expect(first.live).toBe(false)
      expect([...first.facts.keys()]).toEqual([])
      // Nothing was ever known, so there is no age to keep: the reading is
      // stale from the start rather than freshly built.
      expect(first.fetchedAtMs).toBe(0)

      const readsAfterFailure = listingReads(server)
      await catalog.snapshot()
      await catalog.settled()
      expect(listingReads(server)).toBe(readsAfterFailure)

      // And the back-off, not the TTL, decides when it is asked again.
      advance(FIVE_MINUTES_MS + 60_000)
      server.setListingStatus(200)
      server.setListing(['glm-5.3'])
      await catalog.snapshot()
      await catalog.settled()
      expect(listingReads(server)).toBe(readsAfterFailure + 1)
    } finally {
      restore()
    }
  })
})
