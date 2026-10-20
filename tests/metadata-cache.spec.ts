/**
 * Keeping what the last successful metadata read said.
 *
 * The online metadata is the only source that states which models can think
 * and at which levels. A host that cannot read it used to declare every
 * model unable to think, and the host's own check then refused the effort
 * the session was already using — failing a run that had nothing wrong with
 * it. These cases hold the fallback in place: a cold process that cannot
 * read the document still knows what the last one said.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFactsCache, writeFactsCache } from '../src/catalog/metadata-cache.ts'
import { OpencodeGoCatalog } from '../src/catalog/index.ts'
import { OpencodeGoAdapter } from '../src/adapter.ts'
import { catalogReading } from '../src/catalog/reading.ts'
import type { OpencodeGoConfig } from '../src/config.ts'
import {
  modelsDevDocument,
  offlineDocument,
  startMockGateway,
  stubModelsDev,
} from './mock-gateway.ts'
import type { MockGateway } from './mock-gateway.ts'

const gateways: MockGateway[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const DEFAULTS = { contextWindow: 262_144, maxTokens: 32_768, input: ['text'] as const }

/** A configuration for one base URL. */
function configFor(baseURL: string, overrides: Partial<OpencodeGoConfig> = {}): OpencodeGoConfig {
  return {
    baseURL,
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    refreshMinutes: 60,
    modelVisibility: {},
    modelProtocols: {},
    modelLimits: {},
    ...overrides,
  } as OpencodeGoConfig
}

/** A fresh cache directory. */
function cacheDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dshopencodego-facts-'))
  directories.push(directory)
  return directory
}

/** One model that thinks, with the levels it thinks at. */
const THINKING_MODEL = {
  'glm-5.3': {
    name: 'GLM-5.3',
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
    limit: { context: 1000, output: 100 },
  },
}

describe('the facts cache', () => {
  it('remembers what a successful read said, and reads it back', () => {
    const directory = cacheDir()
    const facts = new Map([
      ['glm-5.3', {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        api: 'openai-completions' as const,
        protocolSource: 'online' as const,
        contextWindow: 1000,
        maxInputTokens: undefined,
        maxTokens: 100,
        assumedLimits: false,
        input: ['text'] as const,
        inputModalities: undefined,
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
        compat: {},
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        deprecated: false,
        releaseDate: undefined,
      }],
    ])
    writeFactsCache(directory, facts)
    const cached = readFactsCache(directory)
    expect(cached?.facts.get('glm-5.3')?.thinkingLevelMap?.low).toBe('low')
    expect(cached?.facts.get('glm-5.3')?.reasoning).toBe(true)
  })

  it('treats an unreadable or corrupt cache as no cache', () => {
    const directory = cacheDir()
    expect(readFactsCache(directory)).toBeUndefined()
    writeFileSync(join(directory, 'models-dev-facts.json'), '{not json', 'utf8')
    expect(readFactsCache(directory)).toBeUndefined()
    writeFileSync(join(directory, 'models-dev-facts.json'), JSON.stringify({ version: 99, facts: {} }), 'utf8')
    expect(readFactsCache(directory)).toBeUndefined()
    expect(readFactsCache(undefined)).toBeUndefined()
  })
})

describe('a cold process that cannot read the metadata', () => {
  it('still knows which models think, because the last read said so', async () => {
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    gateways.push(server)
    const directory = cacheDir()

    // One successful read, in one process.
    const stub = stubModelsDev(modelsDevDocument(THINKING_MODEL))
    try {
      const first = new OpencodeGoCatalog({
        baseURL: server.baseURL,
        refreshMs: 0,
        defaults: DEFAULTS,
        overrides: {},
        cacheDir: directory,
        readDocument: offlineDocument(),
      })
      await first.snapshot(true)
      // The successful read wrote down what it learned.
      expect(readFactsCache(directory)?.facts.get('glm-5.3')?.thinkingLevelMap?.low).toBe('low')
    } finally {
      stub.restore()
    }

    // A second process, which cannot read the document at all.
    const failing = stubModelsDev({}, 503)
    try {
      const second = new OpencodeGoCatalog({
        baseURL: server.baseURL,
        refreshMs: 0,
        defaults: DEFAULTS,
        overrides: {},
        cacheDir: directory,
        readDocument: offlineDocument(),
      })
      const snapshot = await second.snapshot(true)
      const fact = snapshot.facts.get('glm-5.3')
      // The model still declares that it thinks, and at which levels — which
      // is what the host's own effort check reads.
      expect(fact?.reasoning).toBe(true)
      expect(fact?.thinkingLevelMap?.low).toBe('low')
      // And the page is told the numbers are old.
      expect(snapshot.factsCachedAt).toBeGreaterThan(0)
      const reading = catalogReading(snapshot, {})
      expect(reading.factsCachedAt).toBe(snapshot.factsCachedAt)
    } finally {
      failing.restore()
    }
  })

  it('gives the host a thinking model it can accept an effort for', async () => {
    // The failure this guards is the host's own: it refuses a request that
    // names an effort for a model the route says cannot think. A degraded
    // catalog that reports "cannot think" for a model that does think is what
    // turns a working session into a failed run.
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    gateways.push(server)
    const directory = cacheDir()

    const stub = stubModelsDev(modelsDevDocument(THINKING_MODEL))
    try {
      const first = new OpencodeGoAdapter({
        config: () => configFor(server.baseURL),
        resolveApiKey: async () => 'test-key',
        cacheDir: directory,
        readDocument: offlineDocument(),
      })
      await first.catalogOf(configFor(server.baseURL)).snapshot(true)
    } finally {
      stub.restore()
    }

    const failing = stubModelsDev({}, 503)
    try {
      const second = new OpencodeGoAdapter({
        config: () => configFor(server.baseURL),
        resolveApiKey: async () => 'test-key',
        cacheDir: directory,
        readDocument: offlineDocument(),
      })
      const info = await second.resolveModel('opencode-go', 'glm-5.3')
      // The host reads these to decide whether the session's effort is legal.
      expect(info.reasoning?.efforts.map(effort => effort.id)).toContain('low')
    } finally {
      failing.restore()
    }
  })

  it('retries the read once before giving up', async () => {
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    gateways.push(server)
    let attempts = 0
    const stub = stubModelsDev(modelsDevDocument(THINKING_MODEL))
    // The first attempt answers 503; the second answers the document.
    const original = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.startsWith('https://models.dev/')) return original(input as RequestInfo, init)
      attempts += 1
      if (attempts === 1) return new Response('nope', { status: 503 })
      return original(input as RequestInfo, init)
    })
    try {
      const catalog = new OpencodeGoCatalog({
        baseURL: server.baseURL,
        refreshMs: 0,
        defaults: DEFAULTS,
        overrides: {},
        readDocument: offlineDocument(),
      })
      const snapshot = await catalog.snapshot(true)
      expect(attempts).toBe(2)
      expect(snapshot.facts.get('glm-5.3')?.reasoning).toBe(true)
      expect(snapshot.degradations ?? []).toEqual([])
    } finally {
      vi.unstubAllGlobals()
      stub.restore()
    }
  })
})
