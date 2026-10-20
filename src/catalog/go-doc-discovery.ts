/**
 * Finding the provider's document without being told where it is.
 *
 * The document is the provider's own statement of each model's protocol, and
 * the provider moves it: `go.mdx` lived at
 * `packages/web/src/content/docs/go.mdx` until the `packages/web` tree was
 * restructured, and the plugin then read 404 from both mirrors for as long as
 * the old path was hardcoded. A hardcoded path is a promise the provider did
 * not make.
 *
 * So the path is discovered instead of declared. The discovery is a read-only
 * listing of the provider's own repository, and it runs only when every known
 * path has already failed — the common case costs one request to a file that
 * is there, and the rare case costs one listing.
 *
 * The paths that discovery finds are remembered on disk, as a *set of paths
 * known to have existed*, not as one current path. That distinction matters:
 * a cache holding a single path would hand back a stale path the moment the
 * provider moved the file again, which is exactly the moment the cache is
 * consulted. A set is only ever a list of candidates to try, so a stale entry
 * costs one failed request and nothing else.
 *
 * @module @dan-ai-studio/dshopencodego/catalog/go-doc-discovery
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The provider's repository, as the file listing API exposes it. */
const DISCOVERY_URL = 'https://api.github.com/repos/anomalyco/opencode/git/trees/dev?recursive=1'

/** The document's name may carry a version suffix; `go-v2.mdx` is still it. */
const DOCUMENT_NAME = /^go[^/]*\.mdx$/i

/** A repository listing is large; the cap keeps a hostile response bounded. */
export const DISCOVERY_MAX_BYTES = 8 * 1024 * 1024

/** The listing must answer within the same budget as the other sources. */
const DISCOVERY_TIMEOUT_MS = 10_000

/** The cache file inside the plugin's cache directory. */
const CACHE_FILE = 'go-doc-paths.json'

/** The cache format's version, so a future change can be recognised. */
const CACHE_VERSION = 1

/**
 * How long the repository listing waits before it is asked again.
 *
 * The listing is unauthenticated, and an unauthenticated GitHub API allows
 * sixty requests an hour. The listing is also large — the provider's whole
 * tree, thousands of entries. Asking it on every build would spend that
 * budget on a provider that is merely unreachable, and would make every
 * build slower for a question with the same answer.
 */
export const DISCOVERY_COOLDOWN_MS = 60 * 60_000

/** What the cache file holds. */
interface CacheFile {
  readonly version: number
  /** Repository-relative paths, most recently discovered first. */
  readonly paths: readonly string[]
  /** When the file was written, for a human reading it. */
  readonly updatedAt: number
  /** When the repository was last asked, whether or not it answered. */
  readonly lastAttemptAt?: number
}

/**
 * The repository paths a discovery run found.
 *
 * A path is only useful if it names the document this plugin parses, and the
 * listing also contains unrelated `go.mdx` files in other packages' fixtures.
 * The path must therefore sit under a documentation tree.
 * @param paths - every repository path the listing mentioned.
 * @returns the paths that name the provider's Go document.
 */
export function selectDocumentPaths(paths: readonly string[]): readonly string[] {
  const selected: string[] = []
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    // The document is the provider's Go page: a markdown file whose name
    // starts with "go". A renamed file (`go-v2.mdx`) is still that page, and
    // requiring the exact name would make a rename indistinguishable from the
    // file being gone.
    if (!DOCUMENT_NAME.test(name)) continue
    // A documentation tree, not a test fixture or a translation of one.
    if (!/(^|\/)(docs?|content|console)\//i.test(path) && !/^packages\/web\/src\/content\/docs\//i.test(path)) continue
    selected.push(path)
  }
  // Longest first: the deeper path is the more specific document when a
  // repository carries several.
  return selected.sort((left, right) => right.length - left.length)
}

/**
 * The mirrors a repository path can be read from.
 *
 * Two hosts, one file: the repository itself and a CDN that caches it. They
 * fail independently, which is why both are tried.
 * @param path - a repository-relative path.
 * @returns the URLs to read that path from.
 */
export function mirrorsOf(path: string): readonly string[] {
  const encoded = path.split('/').map(segment => encodeURIComponent(segment)).join('/')
  return [
    `https://raw.githubusercontent.com/anomalyco/opencode/dev/${encoded}`,
    `https://cdn.jsdelivr.net/gh/anomalyco/opencode@dev/${encoded}`,
  ]
}

/**
 * Ask the provider's repository where its document is.
 *
 * The listing is unauthenticated, so it is rate-limited. That is why this runs
 * only after every known path has failed, and why the paths it finds are
 * remembered: the next process starts with the answer and never asks.
 * @param signal - caller cancellation.
 * @param fetchImpl - the fetch to use; injected for tests.
 * @returns the repository paths that name the document; empty when the
 *   listing could not be read or named nothing.
 */
export async function discoverDocumentPaths(
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly string[]> {
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  try {
    const response = await fetchImpl(DISCOVERY_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dshopencodego' },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    if (!response.ok) return []
    const body = await response.text()
    if (body.length > DISCOVERY_MAX_BYTES) return []
    const listing = JSON.parse(body) as { tree?: { path?: string }[] }
    const paths = (listing.tree ?? [])
      .map(entry => entry.path)
      .filter((path): path is string => typeof path === 'string')
    return selectDocumentPaths(paths)
  } catch {
    // A discovery that fails is a discovery that finds nothing. The caller
    // falls back to what it already knows.
    return []
  }
}

/**
 * The paths the cache remembers, most recently discovered first.
 *
 * A cache that cannot be read is an empty cache: the caller then tries the
 * paths it knows and discovers again.
 * @param cacheDir - the plugin's cache directory.
 * @returns the remembered repository paths.
 */
export function readCachedPaths(cacheDir: string | undefined): readonly string[] {
  if (cacheDir === undefined) return []
  try {
    const parsed = JSON.parse(readFileSync(join(cacheDir, CACHE_FILE), 'utf8')) as Partial<CacheFile>
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.paths)) return []
    return parsed.paths.filter((path): path is string => typeof path === 'string')
  } catch {
    return []
  }
}

/**
 * Remember the paths a discovery run found.
 *
 * The known paths are merged rather than replaced, newest first, so a cache
 * that a concurrent process also wrote does not lose the other process's
 * entry. A cache that cannot be written is not an error: the paths stay in
 * memory for this process and are rediscovered next time.
 * @param cacheDir - the plugin's cache directory.
 * @param discovered - the paths a discovery run found.
 * @returns the merged set, in the order it should be tried.
 */
export function rememberPaths(
  cacheDir: string | undefined,
  discovered: readonly string[],
): readonly string[] {
  const known = readCachedPaths(cacheDir)
  const merged: string[] = []
  for (const path of [...discovered, ...known]) {
    if (!merged.includes(path)) merged.push(path)
  }
  if (cacheDir === undefined || discovered.length === 0) return merged
  try {
    mkdirSync(cacheDir, { recursive: true })
    const file: CacheFile = { version: CACHE_VERSION, paths: merged, updatedAt: Date.now() }
    writeFileSync(join(cacheDir, CACHE_FILE), `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  } catch {
    // A cache directory that cannot be written costs a rediscovery, nothing more.
  }
  return merged
}

/**
 * Whether the repository may be asked again.
 *
 * The question is worth at most an hour: a provider whose document has
 * moved is found within the hour, and one that is merely down is not asked
 * again every minute while it is down.
 * @param cacheDir - the plugin's cache directory.
 * @returns true when the repository may be asked.
 */
export function discoveryAllowed(cacheDir: string | undefined): boolean {
  if (cacheDir === undefined) return true
  try {
    const parsed = JSON.parse(readFileSync(join(cacheDir, CACHE_FILE), 'utf8')) as Partial<CacheFile>
    if (typeof parsed.lastAttemptAt !== 'number') return true
    return Date.now() - parsed.lastAttemptAt >= DISCOVERY_COOLDOWN_MS
  } catch {
    return true
  }
}

/**
 * Record that the repository was asked, whether or not it answered.
 *
 * The attempt is what the budget is spent on, so a question that came back
 * empty counts as a question.
 * @param cacheDir - the plugin's cache directory.
 */
export function rememberAttempt(cacheDir: string | undefined): void {
  if (cacheDir === undefined) return
  try {
    mkdirSync(cacheDir, { recursive: true })
    const file: CacheFile = {
      version: CACHE_VERSION,
      paths: readCachedPaths(cacheDir),
      updatedAt: Date.now(),
      lastAttemptAt: Date.now(),
    }
    writeFileSync(join(cacheDir, CACHE_FILE), `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  } catch {
    // A cache directory that cannot be written costs a rediscovery, nothing more.
  }
}
