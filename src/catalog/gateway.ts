/**
 * The gateway model listing: which ids the subscription can call right now.
 *
 * The endpoint answers an OpenAI-shaped `{ object: 'list', data: [{ id, … }] }`.
 * It decides *membership* — which ids the subscription can call right now — and
 * also carries each model's `recommended_api` and AI SDK package, which name the
 * wire protocol the provider itself serves. Models.dev stays the authority for
 * capacities and lifecycle. A malformed reply is a failure (never "the gateway
 * serves nothing").
 *
 * @module @dan-ai-studio/dshopencodego/catalog/gateway
 */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import { MODEL_LISTING_MAX_BYTES, METADATA_FETCH_TIMEOUT_MS } from './constants.ts'
import { readBoundedJson } from './json-response.ts'
import { protocolOfNpm } from './protocol.ts'
import type { WireProtocol } from './protocol.ts'
import type { GoQuota } from '../go-limits.ts'

/** Read the ids out of a model-listing body. */
export function readModelIds(body: unknown): readonly string[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) throw new Error('the model listing has no "data" array')
  const ids: string[] = []
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  return [...new Set(ids)]
}

/**
 * Read the per-model wire protocols the gateway declares.
 *
 * Each entry names its `recommended_api` and the AI SDK package behind that
 * API; the package maps to a wire protocol exactly as models.dev's `npm` field
 * does. Models whose recommended API this plugin cannot drive (e.g.
 * `generate-content`, an image protocol) are simply absent from the result —
 * the gateway listing still includes them, but no protocol is claimed for
 * them. A malformed `api` block names no protocol rather than failing the whole
 * listing: membership is the endpoint's contract; protocol is a bonus.
 * @param body - a model-listing body already known to have a `data` array.
 * @returns protocol by model id, for the ids the gateway names explicitly.
 */
export function readGatewayProtocols(body: unknown): ReadonlyMap<string, WireProtocol> {
  const data = (body as { data?: unknown } | null)?.data
  const protocols = new Map<string, WireProtocol>()
  if (!Array.isArray(data)) return protocols
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || id.length === 0 || protocols.has(id)) continue
    const row = entry as { recommended_api?: unknown; api?: unknown }
    const recommended = typeof row['recommended_api'] === 'string' ? row['recommended_api'] : undefined
    const api = row['api'] !== null && typeof row['api'] === 'object' && !Array.isArray(row['api'])
      ? row['api'] as Record<string, unknown> : undefined
    const detail = recommended === undefined || api === undefined ? undefined : api[recommended]
    const sdk = detail !== null && typeof detail === 'object' && !Array.isArray(detail)
      ? (detail as { sdk?: { aisdk?: unknown } }).sdk?.aisdk
      : undefined
    const protocol = protocolOfNpm(sdk)
    if (protocol !== undefined) protocols.set(id, protocol)
  }
  return protocols
}

/**
 * Read the Go-tier monthly allowances the gateway declares.
 *
 * Each model's `go.monthly_usage.go` is the Go-tier allowance in USD. A `null`
 * usage (free models) means no monetary limit — `unlimited`. Models that carry
 * no `go` block at all are absent from the result: the frozen seed answers for
 * them. A malformed amount names no allowance rather than failing the listing.
 * @param body - a model-listing body already known to have a `data` array.
 * @returns Go-tier allowance by model id.
 */
export function readGatewayQuotas(body: unknown): ReadonlyMap<string, GoQuota> {
  const data = (body as { data?: unknown } | null)?.data
  const quotas = new Map<string, GoQuota>()
  if (!Array.isArray(data)) return quotas
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || id.length === 0 || quotas.has(id)) continue
    const go = (entry as { go?: unknown }).go
    if (go === null || typeof go !== 'object' || Array.isArray(go)) continue
    const usage = (go as { monthly_usage?: unknown }).monthly_usage
    if (usage === null) {
      // Free model: no monetary limit.
      quotas.set(id, { monthlyUsd: 'unlimited' })
      continue
    }
    if (usage === undefined || typeof usage !== 'object' || Array.isArray(usage)) continue
    const amount = (usage as { go?: unknown }).go
    if (typeof amount === 'number' && Number.isFinite(amount)) quotas.set(id, { monthlyUsd: amount })
  }
  return quotas
}

/** One gateway listing read: ids, protocols, and Go-tier monthly allowances. */
export interface ModelListing {
  readonly ids: readonly string[]
  readonly protocols: ReadonlyMap<string, WireProtocol>
  readonly quotas: ReadonlyMap<string, GoQuota>
}

/** Read a model-listing body into ids, protocols, and Go-tier allowances. */
export function readModelListing(body: unknown): ModelListing {
  // readModelIds throws on a body with no data array; keep that failure mode.
  const ids = readModelIds(body)
  return { ids, protocols: readGatewayProtocols(body), quotas: readGatewayQuotas(body) }
}

/**
 * Fetch the ids the gateway currently advertises.
 *
 * The request goes through the given fetch, so a gateway pinned to one
 * address is read from that address — and, when that address is gone, from
 * the address the system would have chosen.
 * @param baseURL - normalized gateway base without a trailing slash.
 * @param signal - caller cancellation, if any.
 * @param request - the fetch to use; the system's own when none is given.
 * @returns the advertised ids in endpoint order, deduplicated.
 * @throws {LlmError} `DISCOVERY_FAILED` when the endpoint is unreachable, not
 *   OK, or does not answer a model listing.
 */
export async function fetchModelIds(
  baseURL: string,
  signal?: AbortSignal,
  request: typeof fetch = globalThis.fetch,
): Promise<readonly string[]> {
  return (await fetchModelListing(baseURL, signal, request)).ids
}

/**
 * Fetch the gateway listing: the advertised ids and the protocols the gateway
 * itself declares for them. The request and failure semantics are identical to
 * {@link fetchModelIds}; this is the richer read used by the catalog.
 * @param baseURL - normalized gateway base without a trailing slash.
 * @param signal - caller cancellation, if any.
 * @param request - the fetch to use; the system's own when none is given.
 * @returns the listing in endpoint order, with per-model protocol declarations.
 * @throws {LlmError} `DISCOVERY_FAILED` on any endpoint or body failure.
 */
export async function fetchModelListing(
  baseURL: string,
  signal?: AbortSignal,
  request: typeof fetch = globalThis.fetch,
): Promise<ModelListing> {
  const url = `${baseURL.replace(/\/+$/, '')}/models`
  const timeout = AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS)
  const response = await request(url, {
    method: 'GET',
    redirect: 'error',
    // An explicit request header rather than `RequestInit.cache`: Node's fetch
    // does not implement HTTP caching, and the header is what any intermediary
    // in front of the gateway reads.
    headers: { ...attributionHeaders(), accept: 'application/json', 'cache-control': 'no-cache' },
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  }).catch((error: unknown) => {
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new LlmError(`${url} answered HTTP ${response.status}`, 'DISCOVERY_FAILED')
  }
  const body = await readBoundedJson(response, url, MODEL_LISTING_MAX_BYTES)
  try {
    return readModelListing(body)
  } catch (error: unknown) {
    throw new LlmError(`${url} returned an invalid model listing`, 'DISCOVERY_FAILED', { cause: error })
  }
}
