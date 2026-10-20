/**
 * Remembering the whole catalog.
 *
 * The parsed metadata facts and the provider's document are remembered
 * already, but they are remembered as *evidence* — what to ask about, and
 * what to fall back to when an answer cannot be had. This file remembers
 * the *answer*: the catalog as it stood, so that a process can serve it
 * without waiting for the network at all.
 *
 * That is the difference between a wait and a stale page. A process that
 * starts with nothing must ask the gateway, the metadata document, and the
 * provider's page before it can name a model — and a new session's first
 * message waits for that. A process that starts with a remembered catalog
 * can name a model immediately, and refresh what it remembered afterwards.
 *
 * The listing is the authority on which models exist, so a remembered
 * catalog can only describe the models the gateway advertised when it was
 * written. A model the gateway has since added is missing from it — and a
 * model the gateway has since retired is still in it, which is why the
 * remembered catalog is always presented as being *from* the past.
 *
 * @module @dan-ai-studio/dshopencodego/catalog/snapshot-cache
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GoQuota } from '../go-limits.ts'
import type { ModelFacts } from './metadata.ts'
import type { WireProtocol } from './protocol.ts'

/** The cache file inside the plugin's cache directory. */
const CACHE_FILE = 'catalog-snapshot.json'

/** The cache format's version, so a future change can be recognised. */
const CACHE_VERSION = 1

/** What the cache file holds. */
interface SnapshotFile {
  readonly version: number
  /** The facts, by model id. */
  readonly facts: Record<string, ModelFacts>
  /** The provider's allowances, by model id. */
  readonly quotas?: Record<string, GoQuota>
  /** The provider's protocols, by model id. */
  readonly protocols?: Record<string, WireProtocol>
  /** When the catalog was built. */
  readonly updatedAt: number
}

/**
 * The catalog a previous build produced.
 *
 * A cache that cannot be read is no cache: the caller then builds the
 * catalog the ordinary way, which waits, and no worse.
 * @param cacheDir - the plugin's cache directory.
 * @returns the remembered catalog, or undefined.
 */
export function readSnapshotCache(cacheDir: string | undefined): {
  readonly facts: ReadonlyMap<string, ModelFacts>
  readonly quotas: ReadonlyMap<string, GoQuota>
  readonly protocols: ReadonlyMap<string, WireProtocol>
  readonly updatedAt: number
} | undefined {
  if (cacheDir === undefined) return undefined
  try {
    const parsed = JSON.parse(readFileSync(join(cacheDir, CACHE_FILE), 'utf8')) as Partial<SnapshotFile>
    if (parsed.version !== CACHE_VERSION) return undefined
    if (parsed.facts === null || typeof parsed.facts !== 'object') return undefined
    const facts = new Map<string, ModelFacts>()
    for (const [id, fact] of Object.entries(parsed.facts)) {
      if (fact === null || typeof fact !== 'object') continue
      if (typeof fact.id !== 'string' || typeof fact.api !== 'string') continue
      facts.set(id, fact as ModelFacts)
    }
    if (facts.size === 0) return undefined
    const quotas = new Map<string, GoQuota>()
    for (const [id, quota] of Object.entries(parsed.quotas ?? {})) {
      if (quota === null || typeof quota !== 'object') continue
      quotas.set(id, quota as GoQuota)
    }
    const protocols = new Map<string, WireProtocol>()
    for (const [id, protocol] of Object.entries(parsed.protocols ?? {})) {
      if (typeof protocol !== 'string') continue
      protocols.set(id, protocol as WireProtocol)
    }
    return {
      facts,
      quotas,
      protocols,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    }
  } catch {
    return undefined
  }
}

/**
 * Remember the catalog a build produced.
 *
 * A cache directory that cannot be written costs a wait, and nothing else.
 * @param cacheDir - the plugin's cache directory.
 * @param facts - the facts the build produced.
 * @param quotas - the provider's allowances.
 * @param protocols - the provider's protocols.
 */
export function writeSnapshotCache(
  cacheDir: string | undefined,
  facts: ReadonlyMap<string, ModelFacts>,
  quotas: ReadonlyMap<string, GoQuota>,
  protocols: ReadonlyMap<string, WireProtocol>,
): void {
  if (cacheDir === undefined || facts.size === 0) return
  try {
    mkdirSync(cacheDir, { recursive: true })
    const file: SnapshotFile = {
      version: CACHE_VERSION,
      facts: Object.fromEntries(facts),
      ...quotas.size === 0 ? {} : { quotas: Object.fromEntries(quotas) },
      ...protocols.size === 0 ? {} : { protocols: Object.fromEntries(protocols) },
      updatedAt: Date.now(),
    }
    writeFileSync(join(cacheDir, CACHE_FILE), `${JSON.stringify(file)}\n`, 'utf8')
  } catch {
    // A cache that cannot be written is not an error the user can act on.
  }
}
