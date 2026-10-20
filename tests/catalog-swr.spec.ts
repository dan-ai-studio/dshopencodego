/**
 * Serving what is known while the network works.
 *
 * A process that starts with nothing has to ask the gateway, the metadata
 * document, and the provider's page before it can name a model, and a new
 * session's first message waits for that. A process that starts with a
 * remembered catalog can name a model at once and refresh what it
 * remembered afterwards.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpencodeGoCatalog } from '../src/catalog/index.ts'
import { readSnapshotCache } from '../src/catalog/snapshot-cache.ts'
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

const DEFAULTS = { contextWindow: 262_144, maxTokens: 32_768, input: ['text'] as const }
const THINKING_MODEL = {
  'glm-5.3': {
    name: 'GLM-5.3',
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
    limit: { context: 1000, output: 100 },
  },
}

/** A fresh cache directory. */
function cacheDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dshopencodego-swr-'))
  directories.push(directory)
  return directory
}

/** A catalog over one gateway. */
function catalogFor(server: MockGateway, directory: string): OpencodeGoCatalog {
  const catalog = new OpencodeGoCatalog({
    baseURL: server.baseURL,
    refreshMs: 0,
    defaults: DEFAULTS,
    overrides: {},
    cacheDir: directory,
    readDocument: offlineDocument(),
  })
  catalogs.push(catalog)
  return catalog
}

describe('a process that starts with a remembered catalog', () => {
  it('answers at once and refreshes in the background', async () => {
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    gateways.push(server)
    const directory = cacheDir()

    // One build, which writes the catalog down.
    const stub = stubModelsDev(modelsDevDocument(THINKING_MODEL))
    try {
      await catalogFor(server, directory).snapshot(true)
    } finally {
      stub.restore()
    }
    expect(readSnapshotCache(directory)?.facts.size).toBeGreaterThan(0)

    // A second process: the metadata service is slow, and the answer must
    // not wait for it.
    let released: (() => void) | undefined
    const gate = new Promise<void>(resolve => { released = resolve })
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://models.dev/')) {
        await gate
        return new Response(JSON.stringify(modelsDevDocument(THINKING_MODEL)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return realFetch(input as RequestInfo, init)
    })
    try {
      const second = catalogFor(server, directory)
      const started = Date.now()
      const snapshot = await second.snapshot()
      const waited = Date.now() - started
      // It answered without waiting for the slow service.
      expect(waited).toBeLessThan(500)
      // The model is there, with the levels it thinks at.
      expect(snapshot.facts.get('glm-5.3')?.thinkingLevelMap?.low).toBe('low')
      // And the page is told the catalog is being brought up to date.
      expect(snapshot.cached).toBe(true)
      expect(snapshot.live).toBe(false)
      // The refresh is under way, and it finishes with a current catalog.
      released?.()
      await second.settled()
      const refreshed = await second.snapshot()
      expect(refreshed.cached).toBeUndefined()
      expect(refreshed.live).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('waits when the caller asks for a refresh', async () => {
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    gateways.push(server)
    const directory = cacheDir()
    const stub = stubModelsDev(modelsDevDocument(THINKING_MODEL))
    try {
      await catalogFor(server, directory).snapshot(true)
    } finally {
      stub.restore()
    }
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://models.dev/')) {
        await new Promise(resolve => { setTimeout(resolve, 30) })
        return new Response(JSON.stringify(modelsDevDocument(THINKING_MODEL)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return realFetch(input as RequestInfo, init)
    })
    try {
      const second = catalogFor(server, directory)
      // A forced refresh is asked for and waited for: that is the settings
      // page's button, and it is the one caller that wants the answer.
      const snapshot = await second.snapshot(true)
      expect(snapshot.cached).toBeUndefined()
      expect(snapshot.live).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps what it knows when the refresh fails', async () => {
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    gateways.push(server)
    const directory = cacheDir()
    const stub = stubModelsDev(modelsDevDocument(THINKING_MODEL))
    try {
      await catalogFor(server, directory).snapshot(true)
    } finally {
      stub.restore()
    }
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://models.dev/')) return new Response('nope', { status: 503 })
      return realFetch(input as RequestInfo, init)
    })
    try {
      const second = catalogFor(server, directory)
      const snapshot = await second.snapshot()
      // The remembered catalog answers...
      expect(snapshot.facts.get('glm-5.3')).toBeDefined()
      // ...and a failed refresh does not take it away.
      await second.settled()
      expect((await second.snapshot()).facts.get('glm-5.3')).toBeDefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
