/**
 * Configuration: defaults, URL validation, and the live-reference read.
 *
 * A bad base URL must fail where it is written (load time, profile edit), so
 * `assertBaseURL` is strict; everything else falls back to documented
 * defaults. `readConfig` must keep the Loader's live references rather than
 * reparsing them, or profile edits stop reaching the next request.
 */
import { describe, expect, it } from 'vitest'
import { assertBaseURL, DEFAULT_API_KEY_ENV, DEFAULT_REFRESH_MINUTES, PlainConfig, readConfig } from '../src/config.ts'
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
    expect(config.baseURL).toBe('https://opencode.ai/zen/go/v1')
    expect(config.refreshMinutes).toBe(DEFAULT_REFRESH_MINUTES)
    expect(config.modelLimits).toEqual({})
    expect(config.modelProtocols).toEqual({})
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

  it('rejects an out-of-range refresh interval', () => {
    expect(() => PlainConfig({ refreshMinutes: 0 })).toThrow()
    expect(() => PlainConfig({ refreshMinutes: 7 * 24 * 60 + 1 })).toThrow()
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
