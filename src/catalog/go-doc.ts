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
import type { WireProtocol } from './protocol.ts'

/**
 * Documentation sources, tried in order.
 *
 * The repository file is the source of truth; the jsDelivr entry caches the
 * same path and is tried when GitHub itself is unreachable.
 */
export const GO_DOC_URLS: readonly string[] = [
  'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx',
  'https://cdn.jsdelivr.net/gh/anomalyco/opencode@dev/packages/web/src/content/docs/go.mdx',
]

/** The document is about 30 KB; the cap leaves room without inviting a flood. */
export const GO_DOC_MAX_BYTES = 1024 * 1024

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

/**
 * Fetch and parse the documentation, trying each source in turn.
 *
 * A source that answers without a usable allowance table counts as a failure,
 * not as an empty document: that is what a moved or restructured page looks
 * like, and the caller must keep its previous data rather than blank the page.
 * @param signal - caller cancellation, if any.
 * @returns the parsed document from the first source that carried one.
 * @throws {LlmError} `DOCUMENT_UNAVAILABLE` when every source failed.
 */
export async function fetchGoDocument(signal?: AbortSignal): Promise<GoDoc> {
  const failures: string[] = []
  for (const url of GO_DOC_URLS) {
    try {
      const timeout = AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS)
      const response = await fetch(url, {
        redirect: 'error',
        headers: { ...attributionHeaders(), accept: 'text/plain', 'cache-control': 'no-cache' },
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        failures.push(`${url} answered HTTP ${response.status}`)
        continue
      }
      const document = parseGoDocument(await readBoundedText(response, GO_DOC_MAX_BYTES))
      if (document.quotas.size === 0) {
        failures.push(`${url} carried no allowance table`)
        continue
      }
      return document
    } catch (error: unknown) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new LlmError(
    `could not read the Go documentation (${failures.join('; ')})`,
    'DOCUMENT_UNAVAILABLE',
  )
}
