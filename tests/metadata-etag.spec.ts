/**
 * The ETag, and what it saves.
 *
 * The model metadata document is 5.6 MB. A new process that knows the
 * document's ETag can ask whether it changed and be answered with a
 * `304 Not Modified` — a round trip and no body. A new process that does
 * not know it downloads the whole document again, and that download is the
 * wait a new session begins with.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFactsCache, writeFactsCache } from '../src/catalog/metadata-cache.ts'
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
const realFetch = globalThis.fetch
afterEach(async () => {
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
  const directory = mkdtempSync(join(tmpdir(), 'dshopencodego-etag-'))
  directories.push(directory)
  return directory
}

describe('the remembered ETag', () => {
  it('is written down and read back', () => {
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
    writeFactsCache(directory, facts, '"v1"')
    expect(readFactsCache(directory)?.etag).toBe('"v1"')
    // A cache written without one is still a cache.
    writeFactsCache(directory, facts)
    expect(readFactsCache(directory)?.etag).toBeUndefined()
  })
})

describe('a new process that knows the ETag', () => {
  it('asks whether the document changed instead of downloading it', async () => {
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    gateways.push(server)
    const directory = cacheDir()

    // The first process reads the document and writes down what it said.
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
    } finally {
      stub.restore()
    }
    expect(readFactsCache(directory)?.etag).toBe('"v1"')

    // The second process asks. The registry says: unchanged.
    const conditional: string[] = []
    const answering = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      // Everything that is not models.dev — the gateway listing, the
      // document — goes out as it normally would.
      if (!url.startsWith('https://models.dev/')) return realFetch(input as RequestInfo, init)
      const headers = new Headers(init?.headers)
      const etag = headers.get('if-none-match')
      if (etag !== null) conditional.push(etag)
      // A 304 carries no body, and the Response constructor refuses one.
      if (etag !== null) return new Response(null, { status: 304, headers: { etag: '"v1"' } })
      return new Response(JSON.stringify(modelsDevDocument(THINKING_MODEL)), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"v1"' },
      })
    })
    vi.stubGlobal('fetch', answering)
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
      // It asked, with the ETag it remembered.
      expect(conditional).toEqual(['"v1"'])
      // And the answer it has is the one it wrote down — the model still
      // declares the levels it thinks at.
      expect(snapshot.facts.get('glm-5.3')?.thinkingLevelMap?.low).toBe('low')
      expect(snapshot.degradations ?? []).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
