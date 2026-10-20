/**
 * Keeping what the last successful metadata read said.
 *
 * The online metadata is the only source that states which models can think
 * and at which levels. When it cannot be read, the plugin still knows some of
 * that — from the last time it could — and throwing that away turns a
 * degraded catalog into a broken one: a model that does think is declared
 * unable to think, the host's own check refuses the effort the session is
 * already using, and the run fails before it starts.
 *
 * So the parsed facts are written down. What is written is deliberately
 * small: the capabilities, the capacities, the prices — not the document.
 * The listing stays the authority on which models exist, so a stale file can
 * never introduce a model the gateway does not serve; it can only describe
 * the ones it does, with what was true when the file was written.
 *
 * @module @dan-ai-studio/dshopencodego/catalog/metadata-cache
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelFacts } from './metadata.ts'

/** The cache file inside the plugin's cache directory. */
const CACHE_FILE = 'models-dev-facts.json'

/** The cache format's version, so a future change can be recognised. */
const CACHE_VERSION = 1

/** What the cache file holds. */
interface FactsFile {
  readonly version: number
  /** The parsed facts, by model id. */
  readonly facts: Record<string, ModelFacts>
  /** When the file was written. */
  readonly updatedAt: number
}

/**
 * The facts a previous successful read produced.
 *
 * A cache that cannot be read is no cache: the caller then has nothing to
 * fall back on and says so, rather than pretending the models have no
 * capabilities.
 * @param cacheDir - the plugin's cache directory.
 * @returns the remembered facts and when they were written, or undefined.
 */
export function readFactsCache(
  cacheDir: string | undefined,
): { readonly facts: ReadonlyMap<string, ModelFacts>; readonly updatedAt: number } | undefined {
  if (cacheDir === undefined) return undefined
  try {
    const parsed = JSON.parse(readFileSync(join(cacheDir, CACHE_FILE), 'utf8')) as Partial<FactsFile>
    if (parsed.version !== CACHE_VERSION || parsed.facts === null || typeof parsed.facts !== 'object') return undefined
    const facts = new Map<string, ModelFacts>()
    for (const [id, fact] of Object.entries(parsed.facts)) {
      if (fact === null || typeof fact !== 'object') continue
      if (typeof fact.id !== 'string' || typeof fact.api !== 'string') continue
      facts.set(id, fact as ModelFacts)
    }
    if (facts.size === 0) return undefined
    return { facts, updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0 }
  } catch {
    return undefined
  }
}

/**
 * Remember the facts a successful read produced.
 *
 * A cache directory that cannot be written costs a degraded catalog after the
 * next restart, and nothing else: the run continues with what it has.
 * @param cacheDir - the plugin's cache directory.
 * @param facts - the parsed facts to remember.
 */
export function writeFactsCache(cacheDir: string | undefined, facts: ReadonlyMap<string, ModelFacts>): void {
  if (cacheDir === undefined || facts.size === 0) return
  try {
    mkdirSync(cacheDir, { recursive: true })
    const file: FactsFile = {
      version: CACHE_VERSION,
      facts: Object.fromEntries(facts),
      updatedAt: Date.now(),
    }
    writeFileSync(join(cacheDir, CACHE_FILE), `${JSON.stringify(file)}\n`, 'utf8')
  } catch {
    // A cache that cannot be written is not an error the user can act on.
  }
}
