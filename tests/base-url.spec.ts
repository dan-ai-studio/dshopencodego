/**
 * Plain http is a loopback-only affordance.
 *
 * The credential travels in an `authorization` header, so an http endpoint off
 * this machine would put the API key on the wire in clear text. Local mocks and
 * the verification proxies bind to loopback and keep working; every other host
 * must be https. `tests/config.spec.ts` keeps the URL-shape rules; this file
 * owns the transport boundary.
 */
import { describe, expect, it } from 'vitest'
import { assertBaseURL } from '../src/config.ts'

describe('assertBaseURL plain-http boundary', () => {
  it.each([
    'http://localhost:8787/v1',
    'http://127.0.0.1:8787/v1',
    'http://[::1]:8787/v1',
  ])('accepts loopback over http: %s', (url) => {
    expect(assertBaseURL(url)).toBe(url)
  })

  it.each([
    'http://opencode.ai/inference/go/v1',
    'http://example.com/v1',
    'http://10.0.0.5:8787/v1',
    // A prefix match on "localhost" must not open the door.
    'http://localhost.example.com/v1',
  ])('refuses non-loopback http: %s', (url) => {
    expect(() => assertBaseURL(url)).toThrow(/must use https outside localhost/)
  })

  it('keeps https unconditional', () => {
    expect(assertBaseURL('https://opencode.ai/inference/go/v1')).toBe('https://opencode.ai/inference/go/v1')
    expect(assertBaseURL('https://localhost:8787/v1')).toBe('https://localhost:8787/v1')
  })

  it('keeps refusing the shapes it refused before', () => {
    expect(() => assertBaseURL('not a url')).toThrow(/not a valid URL/)
    expect(() => assertBaseURL('ftp://example.com/v1')).toThrow(/must be http or https/)
    expect(() => assertBaseURL('https://opencode.ai/v1?x=1')).toThrow(/must not carry a query or fragment/)
    expect(() => assertBaseURL('https://opencode.ai/v1#x')).toThrow(/must not carry a query or fragment/)
    // The transport rule must not shadow the query rule on the loopback path.
    expect(() => assertBaseURL('http://127.0.0.1:8787/v1?x=1')).toThrow(/must not carry a query or fragment/)
  })

  it('normalizes trailing slashes on an accepted loopback base', () => {
    expect(assertBaseURL('http://127.0.0.1:8787/v1///')).toBe('http://127.0.0.1:8787/v1')
  })
})
