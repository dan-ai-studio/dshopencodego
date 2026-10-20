/**
 * Remembering the provider's document.
 *
 * The document is small, but every process that builds a catalog fetches it,
 * and on a desktop build that fetch is hundreds of milliseconds. The
 * registry serves an ETag, so a process that remembers it can ask whether
 * the document changed and be answered with `304 Not Modified` — no body at
 * all — and use the copy it already has.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDocCache, writeDocCache } from '../src/catalog/go-doc-cache.ts'
import { fetchGoDocument, GO_DOC_URLS } from '../src/catalog/go-doc.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A fresh cache directory. */
function cacheDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dshopencodego-doc-'))
  directories.push(directory)
  return directory
}

/** A document body that carries the endpoint table the parser reads. */
const DOCUMENT = [
  '## Endpoints',
  '',
  '| Model | Model ID | Endpoint | AI SDK Package |',
  '| --- | --- | --- | --- |',
  '| GLM-5.3 | glm-5.3 | `https://opencode.ai/inference/go/openai/v1/chat/completions` | `@ai-sdk/openai-compatible` |',
].join('\n')

describe('the document cache', () => {
  it('remembers the document and where it came from', () => {
    const directory = cacheDir()
    writeDocCache(directory, { url: GO_DOC_URLS[0]!, etag: '"v1"', body: DOCUMENT })
    const cached = readDocCache(directory)
    expect(cached?.url).toBe(GO_DOC_URLS[0])
    expect(cached?.etag).toBe('"v1"')
    expect(cached?.body).toBe(DOCUMENT)
  })

  it('treats an unreadable or corrupt cache as no cache', () => {
    const directory = cacheDir()
    expect(readDocCache(directory)).toBeUndefined()
    writeFileSync(join(directory, 'go-doc-cache.json'), '{not json', 'utf8')
    expect(readDocCache(directory)).toBeUndefined()
    writeFileSync(join(directory, 'go-doc-cache.json'), JSON.stringify({ version: 99, url: 'x', body: 'y' }), 'utf8')
    expect(readDocCache(directory)).toBeUndefined()
    expect(readDocCache(undefined)).toBeUndefined()
  })
})

describe('fetchGoDocument with a remembered document', () => {
  it('asks whether it changed and uses the copy it has when it did not', async () => {
    const directory = cacheDir()
    writeDocCache(directory, { url: GO_DOC_URLS[0]!, etag: '"v1"', body: DOCUMENT })
    const asked: (string | null)[] = []
    const bodies: number[] = []
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.startsWith('https://raw.githubusercontent.com/') && !url.startsWith('https://cdn.jsdelivr.net/')) {
        return realFetch(input as RequestInfo, init)
      }
      const headers = new Headers(init?.headers)
      asked.push(headers.get('if-none-match'))
      if (headers.get('if-none-match') !== null) {
        // A 304 carries no body, and the Response constructor refuses one.
        return new Response(null, { status: 304, headers: { etag: '"v1"' } })
      }
      const response = new Response(DOCUMENT, { status: 200, headers: { etag: '"v1"' } })
      bodies.push((await response.clone().text()).length)
      return response
    })
    try {
      const document = await fetchGoDocument(undefined, { cacheDir: directory })
      // It asked with the ETag it remembered...
      expect(asked).toEqual(['"v1"'])
      // ...and no body was downloaded.
      expect(bodies).toEqual([])
      // And the document it has is the one it wrote down.
      expect(document.protocols.get('glm-5.3')).toBe('openai-completions')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('takes the new document when the registry says it changed', async () => {
    const directory = cacheDir()
    writeDocCache(directory, { url: GO_DOC_URLS[0]!, etag: '"old"', body: DOCUMENT })
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.startsWith('https://raw.githubusercontent.com/') && !url.startsWith('https://cdn.jsdelivr.net/')) {
        return realFetch(input as RequestInfo, init)
      }
      const headers = new Headers(init?.headers)
      if (headers.get('if-none-match') === '"old"') {
        // The document changed: the registry sends it again.
        return new Response(DOCUMENT, { status: 200, headers: { etag: '"new"' } })
      }
      return new Response('gone', { status: 404 })
    })
    try {
      const document = await fetchGoDocument(undefined, { cacheDir: directory })
      expect(document.protocols.get('glm-5.3')).toBe('openai-completions')
      // And the new ETag is what the next process will ask with.
      expect(readDocCache(directory)?.etag).toBe('"new"')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('falls back to the other sources when the remembered copy carries no table', async () => {
    const directory = cacheDir()
    writeDocCache(directory, { url: GO_DOC_URLS[0]!, etag: '"v1"', body: '# nothing useful here' })
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://raw.githubusercontent.com/') || url.startsWith('https://cdn.jsdelivr.net/')) {
        const headers = new Headers(init?.headers)
        if (headers.get('if-none-match') !== null) return new Response(null, { status: 304 })
        return new Response(DOCUMENT, { status: 200, headers: { etag: '"v1"' } })
      }
      return realFetch(input as RequestInfo, init)
    })
    try {
      const document = await fetchGoDocument(undefined, { cacheDir: directory })
      // The remembered copy was useless, so the other source answered.
      expect(document.protocols.get('glm-5.3')).toBe('openai-completions')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
