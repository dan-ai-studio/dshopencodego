/**
 * Configuration for one `dshopencodego` mount.
 *
 * DSH hands the plugin *live references* for every declared field, so a
 * profile edit reaches the next operation without a restart. This plugin
 * targets that generation only: there is no settings-document path, no
 * `installSection` fallback, and no plain-value codec.
 *
 * Self-contained constraints (URL shape, numeric bounds) fail at load for the
 * composition layer and refuse the write for a profile edit.
 *
 * @module @dan-ai-studio/dshopencodego/config
 */

import { LlmError, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_BASE_URL } from './catalog/constants.ts'
import {
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_KEEP_ALIVE_TIMEOUT_SECONDS,
  MAX_KEEP_ALIVE_TIMEOUT_MS,
  MAX_KEEP_ALIVE_TIMEOUT_SECONDS,
  TIMER_CEILING_MS,
} from './network/keep-alive.ts'
import {
  DEFAULT_REQUEST_LOG_MAX_ENTRIES,
  MAX_REQUEST_LOG_MAX_ENTRIES,
  MIN_REQUEST_LOG_MAX_ENTRIES,
} from './request-log/limits.ts'
import type { ImageBudgetPreset } from './image-budget.ts'

export {
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_KEEP_ALIVE_TIMEOUT_SECONDS,
  MAX_KEEP_ALIVE_TIMEOUT_MS,
  MAX_KEEP_ALIVE_TIMEOUT_SECONDS,
  TIMER_CEILING_MS,
}

export {
  DEFAULT_REQUEST_LOG_MAX_ENTRIES,
  MAX_REQUEST_LOG_MAX_ENTRIES,
  MIN_REQUEST_LOG_MAX_ENTRIES,
}

/** Credential reference resolving the OpenCode Go API key. */
export const DEFAULT_API_KEY_ENV = 'OPENCODE_GO_API_KEY'

/** Requests and pickers share this cache lifetime; explicit discovery revalidates immediately. */
export const DEFAULT_REFRESH_MINUTES = 60

/** Default maximum idle interval while one stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * One model's configured capacities. Every field is optional so a deployment
 * overrides only the value it needs; `null` explicitly selects the catalog
 * value even when a lower layer supplies an override.
 */
interface OpencodeGoModelLimit {
  /** Context window in tokens, overriding what the catalog advertised. */
  contextWindow?: number | null
  /** Output cap per request, overriding what the catalog advertised. */
  maxTokens?: number | null
}

/** Per-model capacities; a `null` entry selects both original catalog values. */
export type OpencodeGoModelLimits = Record<string, OpencodeGoModelLimit | null>

/** Runtime configuration for one plugin mount. */
export interface OpencodeGoConfig {
  /**
   * Whether this adapter serves its route at all. False withdraws the
   * `opencode-go` route and its models from every picker without unloading the
   * plugin, so the configuration that owns this switch stays reachable to turn
   * it back on. Independent of the credential: a key present while this is
   * false registers nothing.
   */
  enabled: boolean
  /** Per-model picker switches; absent entries default to enabled unless deprecated. */
  modelVisibility: Record<string, boolean>
  /** Credential reference: the key resolves from this reference. */
  apiKeyEnv: string
  /** The gateway endpoint; also the base of the live model listing. */
  baseURL: string
  /** Request/picker cache lifetime in minutes; explicit discovery bypasses it. */
  refreshMinutes: number
  /** Largest idle gap between stream events before the request fails. */
  streamIdleTimeoutMs: number
  /**
   * Idle time a gateway connection is kept between requests, in milliseconds.
   *
   * The timer is reset by every response, so a connection that is used
   * often is never dropped; this bounds only the silence between two
   * requests.
   */
  keepAliveTimeoutMs: number
  /**
   * Which image-budget preset shapes request images. `dsh` is the default:
   * an unwritten field reads exactly the host route's own budgets, the same
   * numbers a profile that never configured images would get from DSH itself.
   */
  imageBudgetPreset: ImageBudgetPreset
  /** Per-model capacity overrides; an absent field inherits the catalog value. */
  modelLimits: OpencodeGoModelLimits
  /**
   * Per-model wire-protocol overrides, winning over every inference level.
   * The escape hatch for a model whose family rule guessed wrong.
   */
  modelProtocols: Record<string, string>
  /**
   * Whether the request log records anything at all. Off by default: one
   * call and one boolean per request, plus a bounded ring, only when on.
   * Off returns the request path to exactly as without the log — the
   * recorder is never constructed, and the log's pages stay unregistered.
   */
  requestLogEnabled: boolean
  /**
   * Whether the request log also records pool lifecycle and request headers.
   * Debug only: the common log carries no pool events and no header detail,
   * which is enough to follow one conversation.
   */
  requestLogDebug: boolean
  /**
   * How many request-log entries the Host keeps, oldest dropped first. Bounded
   * so the log can never grow with the session.
   */
  requestLogMaxEntries: number
  /**
   * Addresses a name should be sent to instead of the one the system
   * resolves, by host name. A name that is not listed keeps the system's
   * own resolution, and so keeps its own fallback.
   */
  pinnedAddresses: Record<string, string>
  /**
   * Retry policy for this route, owned here and executed by the optional
   * `dsh-llm-retry` plugin. Absent leaves the host's own default in force.
   */
  retryPolicy?: RetryPolicyConfig
}

const fields = {
  enabled: z.boolean().default(true),
  modelVisibility: z.dict(z.boolean().required()).default({}),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  refreshMinutes: z.number().step(1).min(1).max(7 * 24 * 60).default(DEFAULT_REFRESH_MINUTES),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  // The ceiling is the plugin's own, and it is well under the point where a
  // Node timer overflows: a value above 2^31-1 does not become a longer
  // timer, it becomes ONE MILLISECOND, which would drop the connection at
  // once and say so only in a warning on stderr. The bound here is what
  // keeps that unreachable.
  keepAliveTimeoutMs: z.number().step(1).min(1).max(MAX_KEEP_ALIVE_TIMEOUT_MS).default(DEFAULT_KEEP_ALIVE_TIMEOUT_MS),
  imageBudgetPreset: z.union([z.const('dsh'), z.const('dshopencodego'), z.const('pi-ai')]).default('dsh'),
  modelLimits: z.dict(z.union([z.const(null), z.object({
    contextWindow: z.union([z.const(null), z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)]),
    maxTokens: z.union([z.const(null), z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)]),
  })])).default({}),
  modelProtocols: z.dict(z.string()).default({}),
  // Off by default: the log is a troubleshooting tool, and an unasked
  // sidebar entry plus a conversation tab is the wrong first impression.
  // On, recording costs one call and one boolean per request plus a bounded
  // ring, and buys a per-request trail whenever something looks wrong. Off
  // returns the request path to exactly as without the log, because the
  // recorder is never constructed then.
  requestLogEnabled: z.boolean().default(false),
  requestLogDebug: z.boolean().default(false),
  requestLogMaxEntries: z.number().step(1).min(MIN_REQUEST_LOG_MAX_ENTRIES).max(MAX_REQUEST_LOG_MAX_ENTRIES).default(DEFAULT_REQUEST_LOG_MAX_ENTRIES),
  pinnedAddresses: z.dict(z.string()).default({}),
  retryPolicy: RetryPolicySchema,
}

/**
 * Plain resolved values used by the adapter.
 *
 * The input side is a partial on purpose: a profile writes only the fields it
 * overrides, and the schema's own defaults fill the rest.
 */
export const PlainConfig: z<Partial<OpencodeGoConfig>, OpencodeGoConfig> = z.object(fields)

/** The loader retains these references when profile fields change. */
export type LiveConfig = { [K in keyof OpencodeGoConfig]-?: { get(): OpencodeGoConfig[K] } }

/** Runtime schema for {@link OpencodeGoConfig}; every field stays live. */
export const Config = z.object(Object.fromEntries(
  Object.entries(fields).map(([key, schema]) => [key, schema.volatile()]),
)) as z<Partial<OpencodeGoConfig>, LiveConfig>

/**
 * Validate one request-time idle timeout the schema let through.
 *
 * The schema bounds the persisted profile, but a live reference hands back
 * whatever it holds (and a programmatic mount hands back whatever it returns):
 * `NaN` passes `z.number()`, and a non-positive or overflowing value would
 * otherwise reach `idleWatchdog` mid-request — after the credential was read —
 * as a bare `Error` from its own assertion. Failing here fails before any
 * credential read or network wait, with the route's own message instead of
 * the timer's. Mirrors the resolve-time guard `llm-pi-ai` applies to the same
 * field (`llm-pi-ai/src/config.ts`, "must be a positive finite number").
 * @param value - the configured idle timeout in milliseconds.
 */
export function assertStreamIdleTimeoutMs(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new LlmError(
      `dshopencodego: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
      'INVALID_CONFIG',
    )
  }
}

/**
 * Keep the Loader's references: reparsing them would detach live updates.
 *
 * An optional field a profile never wrote has no live reference to read, so it
 * stays absent instead of failing the operation that asked for the config.
 */
export function readConfig(config: LiveConfig): OpencodeGoConfig {
  return Object.fromEntries((Object.keys(fields) as Array<keyof OpencodeGoConfig>)
    .flatMap(key => {
      const field = config[key] as { get?: () => OpencodeGoConfig[typeof key] } | undefined
      return field?.get === undefined ? [] : [[key, field.get()]]
    })) as unknown as OpencodeGoConfig
}

/**
 * Loopback names a local mock or proxy binds to. Plain http is tolerated there
 * and nowhere else: the credential rides in an `authorization` header, so an
 * http endpoint off this machine would put the API key on the wire in clear text.
 */
const PLAIN_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Accept only an http(s) base without a query or fragment, and only https
 * unless the host is loopback. Runs at load for the composition layer and on
 * every profile edit, so a bad URL fails where it is written, never at first
 * request.
 * @param raw - the configured base URL.
 * @returns the normalized base URL without trailing slashes.
 */
export function assertBaseURL(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`dshopencodego: baseURL "${raw}" is not a valid URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`dshopencodego: baseURL "${raw}" must be http or https`)
  }
  if (url.protocol === 'http:' && !PLAIN_HTTP_HOSTS.has(url.hostname)) {
    throw new Error(
      `dshopencodego: baseURL "${raw}" must use https outside localhost —`
      + ' a plain-http endpoint would send the API key in clear text',
    )
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error(`dshopencodego: baseURL "${raw}" must not carry a query or fragment`)
  }
  return url.toString().replace(/\/+$/, '')
}
