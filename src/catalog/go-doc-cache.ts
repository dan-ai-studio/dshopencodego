/**
 * Remembering the provider's document.
 *
 * The document is fetched by every process that builds a catalog, and on a
 * desktop build that fetch is measured in hundreds of milliseconds. The
 * registry serves an ETag, and a conditional request that comes back
 * `304 Not Modified` carries no body at all.
 *
 * What is remembered is the *parsed* tables, not the raw text. A 304 then
 * costs one round trip and nothing else — no reparse of a document that has
 * not changed. The cache version guards a format or parser change: a stale
 * shape is refused rather than half-read.
 *
 * @module @dan-ai-studio/dshopencodego/catalog/go-doc-cache
 */

import type { GoQuota } from '../go-limits.ts'
import type { WireProtocol } from './protocol.ts'
import type { GoDoc } from './go-doc.ts'
import { readCacheFileSync, writeCacheFile } from './cache-write.ts'

/** The cache file inside the plugin's cache directory. */
const CACHE_FILE = 'go-doc-cache.json'

/** The cache format's version, so a future change can be recognised. */
const CACHE_VERSION = 2

/** What the cache file holds. */
interface DocCacheFile {
  readonly version: number
  /** The URL the document was read from. */
  readonly url: string
  /** The ETag the registry served with it. */
  readonly etag?: string
  /** Parsed allowances, keyed by model id. */
  readonly quotas: Record<string, GoQuota>
  /** Parsed protocols, keyed by model id. */
  readonly protocols: Record<string, WireProtocol>
  /** When it was written. */
  readonly savedAt: number
}

/** The document a previous read produced. */
export interface CachedDoc {
  readonly url: string
  readonly etag: string | undefined
  readonly document: GoDoc
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
export function readDocCache(cacheDir: string | undefined): CachedDoc | undefined {
  const text = readCacheFileSync(cacheDir, CACHE_FILE)
  if (text === undefined) return undefined
  try {
    const parsed = JSON.parse(text) as Partial<DocCacheFile>
    if (parsed.version !== CACHE_VERSION) return undefined
    if (typeof parsed.url !== 'string') return undefined
    if (parsed.quotas === null || typeof parsed.quotas !== 'object') return undefined
    if (parsed.protocols === null || typeof parsed.protocols !== 'object') return undefined
    const quotas = new Map<string, GoQuota>()
    for (const [id, quota] of Object.entries(parsed.quotas)) {
      if (quota === null || typeof quota !== 'object') continue
      if (typeof quota.monthlyUsd !== 'number' && quota.monthlyUsd !== 'unlimited') continue
      quotas.set(id, quota as GoQuota)
    }
    const protocols = new Map<string, WireProtocol>()
    for (const [id, protocol] of Object.entries(parsed.protocols)) {
      if (typeof protocol !== 'string') continue
      protocols.set(id, protocol as WireProtocol)
    }
    if (quotas.size === 0 && protocols.size === 0) return undefined
    return {
      url: parsed.url,
      etag: typeof parsed.etag === 'string' ? parsed.etag : undefined,
      document: { quotas, protocols },
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
    }
  } catch {
    return undefined
  }
}

/**
 * Remember the parsed tables a read produced.
 *
 * A cache directory that cannot be written costs a fetch, and nothing else.
 * @param cacheDir - the plugin's cache directory.
 * @param entry - the document, where it came from, and its ETag.
 */
export function writeDocCache(
  cacheDir: string | undefined,
  entry: { readonly url: string; readonly etag: string | undefined; readonly document: GoDoc },
): void {
  if (cacheDir === undefined) return
  const file: DocCacheFile = {
    version: CACHE_VERSION,
    url: entry.url,
    ...entry.etag === undefined ? {} : { etag: entry.etag },
    quotas: Object.fromEntries(entry.document.quotas),
    protocols: Object.fromEntries(entry.document.protocols),
    savedAt: Date.now(),
  }
  // fire-and-forget: a cache that cannot be written costs a fetch, nothing else.
  writeCacheFile(cacheDir, CACHE_FILE, `${JSON.stringify(file)}\n`)
}
