/**
 * Configuration for one `dshopencodego` mount.
 *
 * DSH 0.1.7 hands the plugin *live references* for every declared field, so a
 * profile edit reaches the next operation without a restart. This plugin
 * targets that generation only: there is no settings-document path, no
 * `installSection` fallback, and no plain-value codec.
 *
 * Self-contained constraints (URL shape, numeric bounds) fail at load for the
 * composition layer and refuse the write for a profile edit.
 *
 * @module @dan-ai-studio/dshopencodego/config
 */

import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_BASE_URL } from './catalog/constants.ts'

/** Credential reference resolving the OpenCode Go API key. */
export const DEFAULT_API_KEY_ENV = 'OPENCODE_GO_API_KEY'

/** Requests and pickers share this cache lifetime; explicit discovery revalidates immediately. */
export const DEFAULT_REFRESH_MINUTES = 60

/** Default maximum idle interval while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Request-level bound on the base64-encoded image payload. */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 6 * 1024 * 1024

/** Total-pixel budget for one request image. */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 1_440_000

/** Raw encoded-byte target for one request image before base64 expansion. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 400_000

/**
 * One model's configured capacities. Every field is optional so a deployment
 * overrides only the value it needs; `null` explicitly selects the catalog
 * value even when a lower layer supplies an override.
 */
export interface OpencodeGoModelLimit {
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
  /** Request-level bound on base64-encoded image payload, in bytes. */
  maxRequestImageBytes: number
  /** Total-pixel budget for one request image. */
  requestImagePixelBudget: number
  /** Raw encoded-byte target for one request image before base64 expansion. */
  requestImageMaxBytes: number
  /** Per-model capacity overrides; an absent field inherits the catalog value. */
  modelLimits: OpencodeGoModelLimits
  /**
   * Per-model wire-protocol overrides, winning over every inference level.
   * The escape hatch for a model whose family rule guessed wrong.
   */
  modelProtocols: Record<string, string>
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
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  requestImagePixelBudget: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET),
  requestImageMaxBytes: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES),
  modelLimits: z.dict(z.union([z.const(null), z.object({
    contextWindow: z.union([z.const(null), z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)]),
    maxTokens: z.union([z.const(null), z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)]),
  })])).default({}),
  modelProtocols: z.dict(z.string()).default({}),
  retryPolicy: RetryPolicySchema,
}

/** Plain resolved values used by the adapter. */
export const PlainConfig: z<OpencodeGoConfig> = z.object(fields)

/** 0.1.7's Loader retains these references when profile fields change. */
export type LiveConfig = { [K in keyof OpencodeGoConfig]-?: { get(): OpencodeGoConfig[K] } }

/** Runtime schema for {@link OpencodeGoConfig}; every field stays live. */
export const Config = z.object(Object.fromEntries(
  Object.entries(fields).map(([key, schema]) => [key, schema.volatile()]),
)) as z<Partial<OpencodeGoConfig>, LiveConfig>

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
 * Accept only an http(s) base without a query or fragment. Runs at load for the
 * composition layer and on every profile edit, so a bad URL fails where it is
 * written, never at first request.
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
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error(`dshopencodego: baseURL "${raw}" must not carry a query or fragment`)
  }
  return url.toString().replace(/\/+$/, '')
}
