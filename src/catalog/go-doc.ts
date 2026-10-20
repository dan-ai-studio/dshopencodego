/**
 * The provider's own Go documentation as a data source.
 *
 * No API exposes the per-model allowances: the gateway's `/models` answers ids,
 * and `/usage` answers account-wide percentages. The numbers live on a docs page
 * whose source is a markdown file in the provider's repository, so this module
 * fetches that file and parses its tables — allowances (with the provider's own
 * request estimates) and the endpoint table that names each model's protocol.
 *
 * The document is the primary source. The transcribed table in `go-limits.ts`
 * stays behind it as a startup seed and a permanent fallback for the day the
 * URL moves, and its age is surfaced wherever it is used.
 *
 * @module @dan-ai-studio/dshopencodego/catalog/go-doc
 */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { GoQuota } from '../go-limits.ts'
import { METADATA_FETCH_TIMEOUT_MS } from './constants.ts'
import { readBoundedText } from './json-response.ts'
import { discoverDocumentPaths, mirrorsOf, readCachedPaths, rememberPaths } from './go-doc-discovery.ts'
import { readDocCache, writeDocCache } from './go-doc-cache.ts'
import type { WireProtocol } from './protocol.ts'

/**
 * Documentation sources, tried in order.
 *
 * The repository file is the source of truth; the jsDelivr entry caches the
 * same path and is tried when GitHub itself is unreachable.
 *
 * The path is the provider's own, and it moves: `go.mdx` used to live at
 * `packages/web/src/content/docs/go.mdx` and the `packages/web` tree was
 * restructured, after which every request answered 404. A document that cannot
 * be read costs the endpoint table — the provider's own statement of each
 * model's protocol — so the path is asserted against the live repository by
 * `tests/go-doc-url.spec.ts` rather than left to rot unnoticed.
 */
export const GO_DOC_URLS: readonly string[] = [
  'https://raw.githubusercontent.com/anomalyco/opencode/dev/services/www/src/docs/content/console/go.mdx',
  'https://cdn.jsdelivr.net/gh/anomalyco/opencode@dev/services/www/src/docs/content/console/go.mdx',
]

/** The document is about 30 KB; the cap leaves room without inviting a flood. */
const GO_DOC_MAX_BYTES = 1024 * 1024

/** What one parse of the document yields. */
export interface GoDoc {
  /** Per-model allowances, keyed by the gateway's model id. */
  readonly quotas: ReadonlyMap<string, GoQuota>
  /** Per-model protocol, straight from the provider's endpoint table. */
  readonly protocols: ReadonlyMap<string, WireProtocol>
}

/** The protocol each documented endpoint path names. */
const ENDPOINT_PROTOCOLS: Readonly<Record<string, WireProtocol>> = {
  '/chat/completions': 'openai-completions',
  '/messages': 'anthropic-messages',
  '/responses': 'openai-responses',
}

/** Strip markdown decoration (`**bold**`, `` `code` ``) from one cell. */
function cell(value: string | undefined): string {
  return (value ?? '').replace(/[*`]/g, '').trim()
}

/**
 * A display name without its tier suffix, so the three tables join.
 * `Qwen3.7 Plus (≤ 256K tokens)` and `DeepSeek V4 Pro (Peak)` both reduce to the
 * name the endpoint table carries.
 */
function baseName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '').trim()
}

/** `$60` → 60; `Unlimited 限时` → `unlimited`; anything else → undefined. */
function parseAllowance(value: string): number | 'unlimited' | undefined {
  if (/^unlimited\b/i.test(value) || value.startsWith('无限制')) return 'unlimited'
  const match = value.match(/\$([\d,]+(?:\.\d+)?)/)
  if (match?.[1] === undefined) return undefined
  const amount = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(amount) ? amount : undefined
}

/** `6,320` → 6320; `Unlimited` → `unlimited`; anything else → undefined. */
function parseCount(value: string): number | 'unlimited' | undefined {
  if (/^unlimited\b/i.test(value) || value.startsWith('无限制')) return 'unlimited'
  const amount = Number(value.replace(/,/g, ''))
  return value.length > 0 && Number.isFinite(amount) ? amount : undefined
}

/**
 * The protocol a documented endpoint names.
 *
 * Matched by path suffix: the table spells full URLs, and every supported API
 * lives at a distinct tail (`/chat/completions`, `/messages`, `/responses`).
 */
function protocolOfEndpoint(endpoint: string): WireProtocol | undefined {
  for (const [suffix, protocol] of Object.entries(ENDPOINT_PROTOCOLS)) {
    if (endpoint.endsWith(suffix)) return protocol
  }
  return undefined
}

/**
 * The data rows of the table whose header carries `required`.
 *
 * Data starts after the header and its separator, and ends at the first line
 * that is not a table row, so three tables in one document stay apart.
 * @param lines - the document, split into lines.
 * @param required - a header cell that table alone carries.
 * @returns one array of trimmed cells per data row.
 */
function tableRows(lines: readonly string[], required: string): readonly (readonly string[])[] {
  const start = lines.findIndex(line => line.startsWith('|') && line.includes(required))
  if (start < 0) return []
  const rows: string[][] = []
  for (let index = start + 2; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (!line.startsWith('|')) break
    rows.push(line.split('|').slice(1, -1).map(entry => entry.trim()))
  }
  return rows
}

/**
 * Parse the Go documentation into the two data sets this plugin consumes.
 *
 * Titles are the join key: the allowance tables name models the way the page
 * presents them while the endpoint table carries the ids, so ids come from the
 * endpoint table and the other two attach by normalised display name. A row
 * that names no known model, or states no usable number, is skipped rather than
 * guessed; a tiered model whose rows disagree is dropped entirely.
 *
 * The two tables are read independently because the provider's page has
 * carried them at different times: the endpoint table names each model's
 * protocol, and the allowance table states the monthly allowance. A document
 * that keeps one and drops the other is still worth reading — the one it
 * keeps is evidence the other source cannot supply.
 * @param markdown - the raw document text.
 * @returns the parsed allowances and protocols; both may be empty when the
 *   document does not carry the expected tables.
 */
export function parseGoDocument(markdown: string): GoDoc {
  const lines = markdown.split('\n')
  const ids = new Map<string, string>()
  const protocols = new Map<string, WireProtocol>()
  for (const row of tableRows(lines, 'Model ID')) {
    const name = cell(row[0])
    const id = cell(row[1])
    if (name.length === 0 || id.length === 0) continue
    ids.set(name, id)
    const protocol = protocolOfEndpoint(cell(row[2]))
    if (protocol !== undefined) protocols.set(id, protocol)
  }

  const quotas = new Map<string, GoQuota>()
  for (const row of tableRows(lines, 'Monthly limit')) {
    const id = ids.get(baseName(cell(row[0])))
    if (id === undefined) continue
    const monthlyUsd = parseAllowance(cell(row[5]))
    if (monthlyUsd === undefined) continue
    const previous = quotas.get(id)
    // Tiered rows (token bands, peak/off-peak) repeat one allowance; the first
    // row wins, and a disagreement drops the model instead of picking a band.
    if (previous === undefined) quotas.set(id, { monthlyUsd })
    else if (previous.monthlyUsd !== monthlyUsd) quotas.delete(id)
  }
  for (const row of tableRows(lines, 'requests per month')) {
    const id = ids.get(baseName(cell(row[0])))
    if (id === undefined) continue
    const monthlyRequests = parseCount(cell(row[3]))
    const quota = quotas.get(id)
    if (monthlyRequests === undefined || quota === undefined) continue
    quotas.set(id, { ...quota, monthlyRequests })
  }
  return { quotas, protocols }
}

/** One source's attempt: the parsed document, or why that source failed. */
type SourceRead =
  | { readonly url: string; readonly document: GoDoc; readonly body: string; readonly etag: string | undefined }
  | { readonly url: string; readonly notModified: true }
  | { readonly url: string; readonly failure: string }

/**
 * Read and parse one source, bounded by the shared fetch timeout.
 *
 * A source that answers without a usable table is a failure, not an empty
 * document: that is what a moved or restructured page looks like, and the
 * caller must keep its previous data rather than blank the page.
 *
 * The two tables are independent evidence, so one missing table does not
 * disqualify the other. The provider's endpoint table names each model's
 * protocol — the most authoritative statement there is — and it outlived the
 * allowance table when the provider restructured its page; the allowances fell
 * back to the frozen seed in `go-limits.ts`, which was written for exactly
 * this. Only a document that carries neither is a document this build does
 * not understand.
 * @param url - the source to read.
 * @param signal - caller cancellation.
 * @param etag - the ETag a previous read was given, which makes the request
 *   conditional: the registry answers `304 Not Modified` and sends no body.
 * @returns what the source said.
 */
async function readSource(url: string, signal?: AbortSignal, etag?: string): Promise<SourceRead> {
  const timeout = AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      redirect: 'error',
      headers: {
        ...attributionHeaders(),
        accept: 'text/plain',
        'cache-control': 'no-cache',
        ...etag === undefined ? {} : { 'if-none-match': etag },
      },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    if (response.status === 304) {
      await response.body?.cancel().catch(() => {})
      return { url, notModified: true }
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return { url, failure: `${url} answered HTTP ${response.status}` }
    }
    const body = await readBoundedText(response, GO_DOC_MAX_BYTES)
    const document = parseGoDocument(body)
    if (document.quotas.size === 0 && document.protocols.size === 0) {
      return { url, failure: `${url} carried neither an allowance table nor an endpoint table` }
    }
    return { url, document, body, etag: response.headers.get('etag') ?? undefined }
  } catch (error: unknown) {
    return { url, failure: `${url}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * How the document is found and where the answer is kept.
 *
 * The discovery is injectable so a test can decide what the provider's
 * repository says without reaching the network — which is the only way this
 * module can be exercised offline at all.
 */
export interface GoDocOptions {
  /** Where the discovered document paths are remembered. */
  readonly cacheDir?: string | undefined
  /**
   * Ask the provider's repository where its document is.
   *
   * Defaults to the real listing. A test injects a fixed answer.
   */
  readonly discover?: (signal?: AbortSignal) => Promise<readonly string[]>
}

/**
 * Fetch and parse the documentation, asking every source concurrently.
 *
 * The second URL is a CDN cache of the same file, so waiting for the first to
 * fail before asking the second doubled the worst case on a cold process —
 * 10 s per source — while the catalog build awaits this document only for the
 * quota badge and the protocol fallback. `GO_DOC_URLS` order still decides:
 * the repository file is examined before its cache mirror, and a source that
 * fails is reported with its own reason.
 *
 * The known paths are tried first, then the paths a previous discovery
 * remembered, and only then is the provider's repository asked where its
 * document is. That order is what keeps the cost at one request in the common
 * case while still surviving the provider moving the file: a path that is
 * there is used, and a path that is not is replaced by a discovered one.
 * @param signal - caller cancellation; it reaches every source's fetch and
 *   aborts all of them, so a cancelled discovery stops waiting on the network.
 * @param options - where the discovered paths are remembered.
 * @returns the parsed document from the first source that carried one.
 * @throws {LlmError} `DOCUMENT_UNAVAILABLE` when every source failed.
 */
export async function fetchGoDocument(
  signal?: AbortSignal,
  options: GoDocOptions = {},
): Promise<GoDoc> {
  const failures: string[] = []
  const known = await readSources(GO_DOC_URLS, signal, options.cacheDir)
  if (known.document !== undefined) return known.document
  failures.push(...known.failures)

  // The paths a previous discovery found, in the order it found them. A path
  // the known list already carries is skipped: asking for it twice would
  // spend a request to learn the same answer twice.
  const remembered = readCachedPaths(options.cacheDir)
    .filter(path => !GO_DOC_URLS.some(url => url.endsWith(path)))
  if (remembered.length > 0) {
    const cached = await readSources(remembered.flatMap(mirrorsOf), signal, options.cacheDir)
    if (cached.document !== undefined) return cached.document
    failures.push(...cached.failures)
  }

  // Nothing known worked: ask the provider's repository where the document
  // is. The listing is rate-limited, so this runs only when it must.
  const discover = options.discover ?? discoverDocumentPaths
  const discovered = await discover(signal)
  if (discovered.length === 0) {
    failures.push('the provider repository named no document')
  } else {
    const merged = rememberPaths(options.cacheDir, discovered)
    // A discovered path whose mirrors the known list already holds would be
    // read a second time for the same answer. That is what happens when the
    // known paths failed for a reason other than their address — a network
    // hiccup — and asking again rarely differs. A path the provider has
    // actually moved is a different one, and that is the case worth a read.
    const fresh = merged
      .filter(path => !GO_DOC_URLS.some(url => url.endsWith(path)))
      .flatMap(mirrorsOf)
    if (fresh.length === 0) {
      failures.push('the provider repository named the path that was already tried')
    } else {
      const result = await readSources(fresh, signal, options.cacheDir)
      if (result.document !== undefined) return result.document
      failures.push(...result.failures)
    }
  }

  // Every reason, not just the first stage's: a user reading this has to be
  // able to tell "the path moved and the discovery could not follow it" from
  // "every source timed out".
  throw new LlmError(
    `could not read the Go documentation (${failures.join('; ')})`,
    'DOCUMENT_UNAVAILABLE',
  )
}

/**
 * Read a set of URLs, keeping the first document that carries one.
 *
 * The remembered document is asked for first, and asked for conditionally:
 * the registry answers `304 Not Modified` and sends no body, so a process
 * that knows the ETag gets the document for the price of a round trip. Only
 * when that does not answer are the other sources tried, and then they are
 * tried at once.
 * @param urls - the URLs to read.
 * @param signal - caller cancellation, forwarded to every read.
 * @param cacheDir - where the document is remembered.
 * @returns the first document found, or every failure that was seen.
 */
async function readSources(
  urls: readonly string[],
  signal: AbortSignal | undefined,
  cacheDir: string | undefined,
): Promise<{ readonly document?: GoDoc; readonly failures: readonly string[] }> {
  const failures: string[] = []
  const cached = readDocCache(cacheDir)
  if (cached !== undefined && urls.includes(cached.url)) {
    const attempt = await readSource(cached.url, signal, cached.etag)
    if ('notModified' in attempt) {
      // The registry says the document has not changed, so the one this
      // process wrote down is the one it would have been sent.
      const document = parseGoDocument(cached.body)
      if (document.quotas.size > 0 || document.protocols.size > 0) {
        return { document, failures }
      }
      failures.push(`${attempt.url} answered 304, and the remembered copy carries no table this build can read`)
    } else if ('document' in attempt) {
      writeDocCache(cacheDir, { url: attempt.url, etag: attempt.etag, body: attempt.body })
      return { document: attempt.document, failures }
    } else {
      failures.push(attempt.failure)
    }
  }
  // The remembered address already had its turn; the others have not.
  const rest = cached === undefined ? urls : urls.filter(url => url !== cached.url)
  const attempts = await Promise.all(rest.map(url => readSource(url, signal)))
  for (const attempt of attempts) {
    if ('document' in attempt) {
      writeDocCache(cacheDir, { url: attempt.url, etag: attempt.etag, body: attempt.body })
      return { document: attempt.document, failures }
    }
    // A `notModified` cannot happen here: these requests carry no ETag, so
    // the registry has nothing to compare against.
    if ('failure' in attempt) failures.push(attempt.failure)
  }
  return { failures }
}
