/**
 * Finding the provider's document, and remembering what was found.
 *
 * A hardcoded path is a promise the provider never made: it moved `go.mdx`
 * once already, and the plugin then read 404 from both mirrors for as long as
 * the old path was declared. These cases pin the behaviour that replaces that
 * promise — the path is discovered, the discovered paths are remembered, and
 * a remembered path is only ever another candidate to try.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discoverDocumentPaths,
  discoveryAllowed,
  mirrorsOf,
  readCachedPaths,
  rememberAttempt,
  rememberPaths,
  selectDocumentPaths,
  DISCOVERY_COOLDOWN_MS,
} from '../src/catalog/go-doc-discovery.ts'
import { fetchGoDocument } from '../src/catalog/go-doc.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A fresh cache directory. */
function cacheDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dshopencodego-cache-'))
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

describe('selectDocumentPaths', () => {
  it('keeps the documentation file and drops everything else', () => {
    const paths = selectDocumentPaths([
      'services/www/src/docs/content/console/go.mdx',
      'packages/web/src/content/docs/go.mdx',
      'packages/web/src/content/docs/providers/go.mdx',
      'packages/sdk/src/go.ts',
      'packages/sdk/src/go.mdx',
      'services/www/src/docs/content/console/models.mdx',
    ])
    expect(paths).toContain('services/www/src/docs/content/console/go.mdx')
    expect(paths).toContain('packages/web/src/content/docs/go.mdx')
    // A Go file that is not the provider's document, and a fixture in a
    // package's source tree, are not candidates.
    expect(paths).not.toContain('packages/sdk/src/go.ts')
    expect(paths).not.toContain('packages/sdk/src/go.mdx')
    expect(paths).not.toContain('services/www/src/docs/content/console/models.mdx')
  })
})

describe('mirrorsOf', () => {
  it('names the repository and its CDN cache', () => {
    expect(mirrorsOf('services/www/src/docs/content/console/go.mdx')).toEqual([
      'https://raw.githubusercontent.com/anomalyco/opencode/dev/services/www/src/docs/content/console/go.mdx',
      'https://cdn.jsdelivr.net/gh/anomalyco/opencode@dev/services/www/src/docs/content/console/go.mdx',
    ])
  })
})

describe('discoverDocumentPaths', () => {
  it('reads the provider repository listing', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      tree: [
        { path: 'services/www/src/docs/content/console/go.mdx' },
        { path: 'packages/sdk/src/index.ts' },
      ],
    }), { status: 200 }))
    const paths = await discoverDocumentPaths(undefined, fetchImpl as unknown as typeof fetch)
    expect(paths).toEqual(['services/www/src/docs/content/console/go.mdx'])
  })

  it('finds nothing when the listing cannot be read', async () => {
    const failed = vi.fn(async () => new Response('nope', { status: 403 }))
    expect(await discoverDocumentPaths(undefined, failed as unknown as typeof fetch)).toEqual([])
    const thrown = vi.fn(async () => { throw new Error('offline') })
    expect(await discoverDocumentPaths(undefined, thrown as unknown as typeof fetch)).toEqual([])
  })
})

describe('the path cache', () => {
  it('remembers discovered paths and reads them back', () => {
    const directory = cacheDir()
    const merged = rememberPaths(directory, ['services/www/src/docs/content/console/go.mdx'])
    expect(merged).toEqual(['services/www/src/docs/content/console/go.mdx'])
    expect(readCachedPaths(directory)).toEqual(['services/www/src/docs/content/console/go.mdx'])
  })

  it('merges rather than replaces, so a concurrent write loses nothing', () => {
    const directory = cacheDir()
    rememberPaths(directory, ['a/go.mdx'])
    const merged = rememberPaths(directory, ['b/go.mdx'])
    expect(merged).toEqual(['b/go.mdx', 'a/go.mdx'])
  })

  it('treats an unreadable or corrupt cache as an empty one', () => {
    const directory = cacheDir()
    expect(readCachedPaths(directory)).toEqual([])
    writeFileSync(join(directory, 'go-doc-paths.json'), '{not json', 'utf8')
    expect(readCachedPaths(directory)).toEqual([])
    writeFileSync(join(directory, 'go-doc-paths.json'), JSON.stringify({ version: 99, paths: ['x'] }), 'utf8')
    expect(readCachedPaths(directory)).toEqual([])
    // A cache directory that does not exist is not an error either.
    expect(readCachedPaths(join(directory, 'missing'))).toEqual([])
  })
})

describe('the discovery budget', () => {
  it('asks the repository at most once an hour', () => {
    const directory = cacheDir()
    // Nothing has been asked, so the question is allowed.
    expect(discoveryAllowed(directory)).toBe(true)
    rememberAttempt(directory)
    // It has just been asked, so it is not asked again.
    expect(discoveryAllowed(directory)).toBe(false)
    // An hour later it may be.
    writeFileSync(
      join(directory, 'go-doc-paths.json'),
      JSON.stringify({ version: 1, paths: [], updatedAt: 0, lastAttemptAt: Date.now() - DISCOVERY_COOLDOWN_MS }),
      'utf8',
    )
    expect(discoveryAllowed(directory)).toBe(true)
  })

  it('counts a question that came back empty as a question', () => {
    const directory = cacheDir()
    rememberAttempt(directory)
    // No paths were found, and the paths are still empty — but the budget was
    // spent, so the repository is not asked again straight away.
    expect(readCachedPaths(directory)).toEqual([])
    expect(discoveryAllowed(directory)).toBe(false)
  })
})

describe('fetchGoDocument with discovery', () => {
  /** A path the known list does not carry: the provider moved the file. */
  const MOVED = 'services/www/src/docs/content/console/go-v2.mdx'

  it('finds the document when every known path has failed, and remembers it', async () => {
    const directory = cacheDir()
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('go-v2.mdx')) return new Response(DOCUMENT, { status: 200 })
      return new Response('gone', { status: 404 })
    })
    try {
      const discover = vi.fn(async () => [MOVED])
      const document = await fetchGoDocument(undefined, { cacheDir: directory, discover })
      expect(document.protocols.get('glm-5.3')).toBe('openai-completions')
      expect(discover).toHaveBeenCalledTimes(1)
      // The answer is on disk, so the next process starts with it.
      expect(readCachedPaths(directory)).toEqual([MOVED])
    } finally {
      spy.mockRestore()
    }
  })

  it('does not ask the provider again once a path is remembered', async () => {
    const directory = cacheDir()
    rememberPaths(directory, [MOVED])
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('go-v2.mdx')) return new Response(DOCUMENT, { status: 200 })
      return new Response('gone', { status: 404 })
    })
    try {
      const discover = vi.fn(async () => [] as readonly string[])
      const document = await fetchGoDocument(undefined, { cacheDir: directory, discover })
      expect(document.protocols.get('glm-5.3')).toBe('openai-completions')
      // The remembered path answered, so the rate-limited listing was never
      // consulted.
      expect(discover).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('fails with the reason when neither the known paths nor a discovery can answer', async () => {
    const directory = cacheDir()
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('gone', { status: 404 }))
    try {
      await expect(fetchGoDocument(undefined, { cacheDir: directory, discover: async () => [] }))
        .rejects.toMatchObject({ code: 'DOCUMENT_UNAVAILABLE' })
    } finally {
      spy.mockRestore()
    }
  })
})
