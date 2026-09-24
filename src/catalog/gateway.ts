/**
 * The gateway model listing: which ids the subscription can call right now.
 *
 * The endpoint answers an OpenAI-shaped `{ object: 'list', data: [{ id, … }] }`
 * with no capability information at all, so it decides *membership* and nothing
 * else. A malformed reply is a failure (never "the gateway serves nothing").
 *
 * @module @dan-ai-studio/dshopencodego/catalog/gateway
 */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import { MODEL_LISTING_MAX_BYTES, METADATA_FETCH_TIMEOUT_MS } from './constants.ts'
import { readBoundedJson } from './json-response.ts'

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
 * Fetch the ids the gateway currently advertises.
 * @param baseURL - normalized gateway base without a trailing slash.
 * @param signal - caller cancellation, if any.
 * @returns the advertised ids in endpoint order, deduplicated.
 * @throws {LlmError} `DISCOVERY_FAILED` when the endpoint is unreachable, not
 *   OK, or does not answer a model listing.
 */
export async function fetchModelIds(baseURL: string, signal?: AbortSignal): Promise<readonly string[]> {
  const url = `${baseURL.replace(/\/+$/, '')}/models`
  const timeout = AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS)
  const response = await fetch(url, {
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
    return readModelIds(body)
  } catch (error: unknown) {
    throw new LlmError(`${url} returned an invalid model listing`, 'DISCOVERY_FAILED', { cause: error })
  }
}
