/**
 * The session header contract: verbatim session ids, fresh randomness
 * otherwise, and a gateway-owned header nothing may override.
 */
import { describe, expect, it } from 'vitest'
import { opencodeSessionValue, providerHeaders, SESSION_HEADER } from '../src/session-header.ts'

describe('opencodeSessionValue', () => {
  it('sends the conversation id verbatim', () => {
    expect(opencodeSessionValue('session-7f3a')).toBe('session-7f3a')
  })

  it('mints a fresh UUID for a missing or empty id, never a shared constant', () => {
    const first = opencodeSessionValue(undefined)
    const second = opencodeSessionValue(undefined)
    const empty = opencodeSessionValue('')
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(new Set([first, second, empty]).size).toBe(3)
  })
})

describe('providerHeaders', () => {
  it('names the mandatory header and keeps the Harness attribution', () => {
    expect(SESSION_HEADER).toBe('x-opencode-session')
    const headers = providerHeaders('session-abc')
    expect(headers[SESSION_HEADER]).toBe('session-abc')
    expect(typeof headers['user-agent']).toBe('string')
    expect(headers['user-agent']!.length).toBeGreaterThan(0)
  })

  it('carries a minted value when the request names no session', () => {
    const headers = providerHeaders(undefined)
    expect(headers[SESSION_HEADER]).toMatch(/^[0-9a-f-]{36}$/)
  })
})
