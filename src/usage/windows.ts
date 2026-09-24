/**
 * The account's usage windows, read from the gateway.
 *
 * `/usage` reports three percentages — a rolling five-hour window, a week, and
 * a month — each with a reset time and a rate-limited flag. It reports *no*
 * per-model breakdown and no token counts, so this module never pretends to:
 * per-model and per-session numbers are derived locally from real provider
 * usage instead (see `./meter.ts` and the session fold in the client).
 *
 * @module @dan-ai-studio/dshopencodego/usage/windows
 */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import { readBoundedJson } from '../catalog/json-response.ts'

/** One quota window as the gateway reports it. */
export interface UsageWindow {
  readonly status: 'ok' | 'rate-limited'
  readonly percent: number
  readonly resetsAt: string
}

/** The account's three windows plus an opaque identity for the reading. */
export interface GoUsageWindows {
  /** Opaque Host identity for the endpoint and credential that produced this reading. */
  readonly source?: string
  readonly rolling: UsageWindow
  readonly weekly: UsageWindow
  readonly monthly: UsageWindow
}

/** Response cap: this document is a few hundred bytes. */
const USAGE_MAX_BYTES = 1024 * 1024

/** Timeout for one usage read. */
const USAGE_TIMEOUT_MS = 10_000

/**
 * Parse a usage response body.
 * @param value - the `usage` member of the response.
 * @returns the three windows.
 * @throws {Error} when a window is missing or malformed; an unavailable reading
 *   must never be displayed as a zero percentage.
 */
export function parseGoUsage(value: unknown): Omit<GoUsageWindows, 'source'> {
  if (value === null || typeof value !== 'object') throw new Error('invalid usage response')
  const source = value as Record<string, unknown>
  const result = {} as Record<'rolling' | 'weekly' | 'monthly', UsageWindow>
  for (const key of ['rolling', 'weekly', 'monthly'] as const) {
    const row = source[key] as Partial<UsageWindow> | undefined
    if (row === null || row === undefined
      || (row.status !== 'ok' && row.status !== 'rate-limited')
      || typeof row.percent !== 'number' || !Number.isFinite(row.percent) || row.percent < 0
      || typeof row.resetsAt !== 'string' || !Number.isFinite(Date.parse(row.resetsAt))) {
      throw new Error(`invalid usage response: window "${key}" is missing or malformed`)
    }
    result[key] = { status: row.status, percent: row.percent, resetsAt: row.resetsAt }
  }
  return result
}

/** Inputs one usage read needs. */
export interface UsageReadOptions {
  /** Normalized gateway base URL. */
  readonly baseURL: string
  /** Resolved credential; absence is reported as an unconfigured route. */
  readonly apiKey: string | undefined
  /** Opaque identity of the endpoint and credential pair, when known. */
  readonly source?: string
  readonly signal?: AbortSignal
}

/**
 * Read the account's usage windows.
 * @param options - endpoint, credential, and identity.
 * @returns the three windows, tagged with the identity that produced them.
 * @throws {LlmError} `USAGE_UNAVAILABLE` when the credential is missing, the
 *   endpoint fails, or the body is not a usage document.
 */
export async function readUsageWindows(options: UsageReadOptions): Promise<GoUsageWindows> {
  if (options.apiKey === undefined || options.apiKey.length === 0) {
    throw new LlmError('dshopencodego: no credential is configured for the opencode-go route', 'USAGE_UNAVAILABLE')
  }
  const url = `${options.baseURL.replace(/\/+$/, '')}/usage`
  const timeout = AbortSignal.timeout(USAGE_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'error',
      headers: {
        ...attributionHeaders(),
        accept: 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]),
    })
  } catch (error: unknown) {
    throw new LlmError(`could not reach ${url}`, 'USAGE_UNAVAILABLE', { cause: error })
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new LlmError(`${url} answered HTTP ${response.status}`, 'USAGE_UNAVAILABLE')
  }
  const body = await readBoundedJson(response, url, USAGE_MAX_BYTES)
  try {
    return {
      ...parseGoUsage((body as { usage?: unknown } | null)?.usage),
      ...options.source === undefined ? {} : { source: options.source },
    }
  } catch (error: unknown) {
    throw new LlmError(`${url} returned an invalid usage document`, 'USAGE_UNAVAILABLE', { cause: error })
  }
}
