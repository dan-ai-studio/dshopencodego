/**
 * Remembering the provider's document.
 *
 * The document is small — tens of kilobytes — but it is fetched by every
 * process that builds a catalog, and a desktop build fetches over the
 * browser's network stack, where that fetch is measured in hundreds of
 * milliseconds. The registry serves an ETag for it, and a conditional
 * request that comes back `304 Not Modified` carries no body at all, so a
 * process that remembers the ETag can have the document for the price of a
 * round trip.
 *
 * What is remembered is the raw text, not the parsed tables. The parsed
 * form is a reading of a document, and a reading can be taken again; the
 * text is the document.
 *
 * @module @dan-ai-studio/dshopencodego/catalog/go-doc-cache
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The cache file inside the plugin's cache directory. */
const CACHE_FILE = 'go-doc-cache.json'

/** The cache format's version, so a future change can be recognised. */
const CACHE_VERSION = 1

/** What the cache file holds. */
interface DocCacheFile {
  readonly version: number
  /** The URL the document was read from. */
  readonly url: string
  /** The ETag the registry served with it. */
  readonly etag?: string
  /** The document's text. */
  readonly body: string
  /** When it was written. */
  readonly savedAt: number
}

/**
 * The document a previous read produced.
 *
 * A cache that cannot be read is no cache: the caller then reads the
 * document the ordinary way, which is slower and no worse.
 * @param cacheDir - the plugin's cache directory.
 * @returns the remembered document, or undefined.
 */
export function readDocCache(
  cacheDir: string | undefined,
): { readonly url: string; readonly etag: string | undefined; readonly body: string; readonly savedAt: number } | undefined {
  if (cacheDir === undefined) return undefined
  try {
    const parsed = JSON.parse(readFileSync(join(cacheDir, CACHE_FILE), 'utf8')) as Partial<DocCacheFile>
    if (parsed.version !== CACHE_VERSION) return undefined
    if (typeof parsed.url !== 'string' || typeof parsed.body !== 'string') return undefined
    if (parsed.body.length === 0) return undefined
    return {
      url: parsed.url,
      etag: typeof parsed.etag === 'string' ? parsed.etag : undefined,
      body: parsed.body,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
    }
  } catch {
    return undefined
  }
}

/**
 * Remember the document a read produced.
 *
 * A cache directory that cannot be written costs a fetch, and nothing else.
 * @param cacheDir - the plugin's cache directory.
 * @param entry - the document, where it came from, and its ETag.
 */
export function writeDocCache(
  cacheDir: string | undefined,
  entry: { readonly url: string; readonly etag: string | undefined; readonly body: string },
): void {
  if (cacheDir === undefined || entry.body.length === 0) return
  try {
    mkdirSync(cacheDir, { recursive: true })
    const file: DocCacheFile = {
      version: CACHE_VERSION,
      url: entry.url,
      ...entry.etag === undefined ? {} : { etag: entry.etag },
      body: entry.body,
      savedAt: Date.now(),
    }
    writeFileSync(join(cacheDir, CACHE_FILE), `${JSON.stringify(file)}\n`, 'utf8')
  } catch {
    // A cache that cannot be written is not an error the user can act on.
  }
}
