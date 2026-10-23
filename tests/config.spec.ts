/**
 * Configuration: defaults, URL validation, and the live-reference read.
 *
 * A bad base URL must fail where it is written (load time, profile edit), so
 * `assertBaseURL` is strict; everything else falls back to documented
 * defaults. `readConfig` must keep the Loader's live references rather than
 * reparsing them, or profile edits stop reaching the next request.
 */
import { describe, expect, it } from 'vitest'
import {
  assertBaseURL,
  DEFAULT_API_KEY_ENV,
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_KEEP_ALIVE_TIMEOUT_SECONDS,
  DEFAULT_REFRESH_MINUTES,
  DEFAULT_REQUEST_LOG_MAX_ENTRIES,
  MAX_KEEP_ALIVE_TIMEOUT_MS,
  MAX_KEEP_ALIVE_TIMEOUT_SECONDS,
  MAX_REQUEST_LOG_MAX_ENTRIES,
  MIN_REQUEST_LOG_MAX_ENTRIES,
  PlainConfig,
  readConfig,
  TIMER_CEILING_MS,
} from '../src/config.ts'
import type { LiveConfig } from '../src/config.ts'

function liveOf(values: Record<string, unknown>): LiveConfig {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { get: () => value }])) as LiveConfig
}

describe('assertBaseURL', () => {
  it('accepts http and https and strips trailing slashes', () => {
    expect(assertBaseURL('https://opencode.ai/zen/go/v1')).toBe('https://opencode.ai/zen/go/v1')
    expect(assertBaseURL('http://127.0.0.1:8787/zen/go/v1///')).toBe('http://127.0.0.1:8787/zen/go/v1')
  })

  it('rejects non-URLs, non-http schemes, and URLs carrying a query or fragment', () => {
    expect(() => assertBaseURL('not a url')).toThrow(/not a valid URL/)
    expect(() => assertBaseURL('ftp://example.com/v1')).toThrow(/must be http or https/)
    expect(() => assertBaseURL('https://opencode.ai/zen/go/v1?x=1')).toThrow(/must not carry a query or fragment/)
    expect(() => assertBaseURL('https://opencode.ai/zen/go/v1#frag')).toThrow(/must not carry a query or fragment/)
  })
})

describe('PlainConfig', () => {
  it('fills every default for an empty profile entry', () => {
    const config = PlainConfig({})
    expect(config.enabled).toBe(true)
    expect(config.modelVisibility).toEqual({})
    expect(config.apiKeyEnv).toBe(DEFAULT_API_KEY_ENV)
    expect(config.baseURL).toBe('https://opencode.ai/inference/go/v1')
    expect(config.refreshMinutes).toBe(DEFAULT_REFRESH_MINUTES)
    expect(config.keepAliveTimeoutMs).toBe(DEFAULT_KEEP_ALIVE_TIMEOUT_MS)
    expect(config.modelLimits).toEqual({})
    expect(config.modelProtocols).toEqual({})
  })

  it('keeps a configured idle time and refuses one out of range', () => {
    // The idle time is a setting, so it is a number a profile may write.
    expect(PlainConfig({ keepAliveTimeoutMs: 30_000 }).keepAliveTimeoutMs).toBe(30_000)
    // A pool that drops a connection after no time at all is not a pool, and
    // one that keeps it for days is a socket held onto a machine that has
    // stopped talking.
    expect(() => PlainConfig({ keepAliveTimeoutMs: 0 })).toThrow()
    expect(() => PlainConfig({ keepAliveTimeoutMs: -1 })).toThrow()
    expect(() => PlainConfig({ keepAliveTimeoutMs: MAX_KEEP_ALIVE_TIMEOUT_MS + 1 })).toThrow()
  })

  it('keeps the idle time below the point where a Node timer overflows', () => {
    // A timer above 2^31-1 does not become a longer timer: it overflows and
    // becomes ONE MILLISECOND, so the connection would be dropped at once —
    // and silently, because the warning goes to stderr and nowhere else. The
    // bound has to make that unreachable, not merely unlikely.
    expect(MAX_KEEP_ALIVE_TIMEOUT_MS).toBeLessThan(TIMER_CEILING_MS)
    expect(() => PlainConfig({ keepAliveTimeoutMs: TIMER_CEILING_MS + 1 })).toThrow()
    expect(() => PlainConfig({ keepAliveTimeoutMs: Number.MAX_SAFE_INTEGER })).toThrow()
  })

  it('derives the millisecond value from the second value, so the two cannot disagree', () => {
    // The page speaks in seconds and the setting is stored in milliseconds.
    // If those two numbers were written separately they could drift, and a
    // drift in the maximum would make the page refuse every value.
    expect(DEFAULT_KEEP_ALIVE_TIMEOUT_MS).toBe(DEFAULT_KEEP_ALIVE_TIMEOUT_SECONDS * 1000)
    expect(MAX_KEEP_ALIVE_TIMEOUT_MS).toBe(MAX_KEEP_ALIVE_TIMEOUT_SECONDS * 1000)
    // And the maximum must be a whole number of seconds, or the page's own
    // bound would not be a whole number either.
    expect(Number.isSafeInteger(MAX_KEEP_ALIVE_TIMEOUT_SECONDS)).toBe(true)
    expect(Number.isSafeInteger(MAX_KEEP_ALIVE_TIMEOUT_MS / 1000)).toBe(true)
  })

  it('keeps an explicit model switch, capacity override, and protocol override', () => {
    const config = PlainConfig({
      modelVisibility: { 'glm-5': false },
      modelLimits: { 'kimi-k3': { contextWindow: 262_144 } },
      modelProtocols: { 'some-new-model': 'openai-responses' },
    })
    expect(config.modelVisibility).toEqual({ 'glm-5': false })
    expect(config.modelLimits).toEqual({ 'kimi-k3': { contextWindow: 262_144 } })
    expect(config.modelProtocols).toEqual({ 'some-new-model': 'openai-responses' })
  })

  it('records the request log with a bounded retention by default, debug off', () => {
    const config = PlainConfig({})
    expect(config.requestLogEnabled).toBe(true)
    expect(config.requestLogDebug).toBe(false)
    expect(config.requestLogMaxEntries).toBe(DEFAULT_REQUEST_LOG_MAX_ENTRIES)
    // Gzip is on unless told otherwise: the off switch is the whole
    // fallback plan if a gateway ever rejects a compressed body.
    expect(config.requestGzip).toBe(true)
    expect(PlainConfig({ requestGzip: false }).requestGzip).toBe(false)
    // The bound is a real interval, not an open end: the ring must always
    // be able to drop its oldest entry.
    expect(MIN_REQUEST_LOG_MAX_ENTRIES).toBeGreaterThan(0)
    expect(MAX_REQUEST_LOG_MAX_ENTRIES).toBeGreaterThan(MIN_REQUEST_LOG_MAX_ENTRIES)
    expect(PlainConfig({ requestLogMaxEntries: MIN_REQUEST_LOG_MAX_ENTRIES }).requestLogMaxEntries)
      .toBe(MIN_REQUEST_LOG_MAX_ENTRIES)
    expect(PlainConfig({ requestLogMaxEntries: MAX_REQUEST_LOG_MAX_ENTRIES }).requestLogMaxEntries)
      .toBe(MAX_REQUEST_LOG_MAX_ENTRIES)
    expect(PlainConfig({ requestLogEnabled: false, requestLogDebug: true }).requestLogEnabled).toBe(false)
  })

  it('refuses a request-log retention outside its bound', () => {
    expect(() => PlainConfig({ requestLogMaxEntries: MIN_REQUEST_LOG_MAX_ENTRIES - 1 })).toThrow()
    expect(() => PlainConfig({ requestLogMaxEntries: MAX_REQUEST_LOG_MAX_ENTRIES + 1 })).toThrow()
    expect(() => PlainConfig({ requestLogMaxEntries: 0 })).toThrow()
    expect(() => PlainConfig({ requestLogMaxEntries: 1.5 })).toThrow()
  })

  it('rejects an out-of-range refresh interval', () => {
    expect(() => PlainConfig({ refreshMinutes: 0 })).toThrow()
    expect(() => PlainConfig({ refreshMinutes: 7 * 24 * 60 + 1 })).toThrow()
  })

  it('keeps a configured retry policy, leaves it absent by default, and refuses a malformed one', () => {
    expect(PlainConfig({}).retryPolicy).toBeUndefined()
    expect(PlainConfig({ retryPolicy: { mode: 'normal', maxRetries: 2 } }).retryPolicy)
      .toMatchObject({ mode: 'normal', maxRetries: 2 })
    expect(PlainConfig({ retryPolicy: { mode: 'always' } }).retryPolicy).toMatchObject({ mode: 'always' })
    expect(() => PlainConfig({ retryPolicy: { mode: 'normal', maxRetries: -1 } })).toThrow()
    expect(() => PlainConfig({ retryPolicy: { mode: 'sometimes' } as never })).toThrow()
  })
})

describe('readConfig', () => {
  it('reads through the live references without reparsing', () => {
    const config = readConfig(liveOf({
      enabled: true,
      modelVisibility: { 'glm-5': true },
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
      baseURL: 'https://opencode.ai/zen/go/v1',
      refreshMinutes: 30,
      streamIdleTimeoutMs: 1_000,
      maxRequestImageBytes: 100,
      requestImagePixelBudget: 200,
      requestImageMaxBytes: 50,
      modelLimits: {},
      modelProtocols: {},
    }))
    expect(config.refreshMinutes).toBe(30)
    expect(config.modelVisibility).toEqual({ 'glm-5': true })
  })
})
