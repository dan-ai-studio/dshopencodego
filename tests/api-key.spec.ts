/**
 * API-key judgement: the policy the plugin carries itself.
 *
 * The Host moved this check between releases — `dsh-llm.assertUsableApiKey` on
 * 0.2.2-rc.5, `dsh-credentials.normalizeApiKey` on a later master — so the
 * plugin owns the policy and must keep the wording every release used. A key
 * that reached an HTTP header would fail there as an opaque 401; these tests
 * pin the local, explained refusal instead.
 */
import { describe, expect, it } from 'vitest'
import { assertUsableApiKey, normalizeApiKey } from '../src/api-key.ts'

describe('normalizeApiKey', () => {
  it('accepts a raw key unchanged', () => {
    expect(normalizeApiKey('sk-opencode-go-abc123')).toEqual({ ok: true, value: 'sk-opencode-go-abc123' })
  })

  it('trims surrounding whitespace without reporting it', () => {
    expect(normalizeApiKey('  sk-abc123\t\n')).toEqual({ ok: true, value: 'sk-abc123' })
  })

  it('reports blank values', () => {
    expect(normalizeApiKey('')).toEqual({ ok: false, reason: 'empty' })
    expect(normalizeApiKey('   \n\t ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('rejects characters no HTTP header can carry', () => {
    // Interior space, control characters, and non-ASCII are all outside \x21-\x7E.
    expect(normalizeApiKey('sk-abc 123')).toEqual({ ok: false, reason: 'illegalCharacters' })
    expect(normalizeApiKey('sk-abc\x00')).toEqual({ ok: false, reason: 'illegalCharacters' })
    expect(normalizeApiKey('sk-abc密钥')).toEqual({ ok: false, reason: 'illegalCharacters' })
  })

  it('accepts the whole printable-ASCII range', () => {
    expect(normalizeApiKey('!"#$%&\'()*+,-./:<=>?@[\\]^_`{|}~')).toEqual({
      ok: true,
      value: '!"#$%&\'()*+,-./:<=>?@[\\]^_`{|}~',
    })
  })
})

describe('assertUsableApiKey', () => {
  it('returns the trimmed key when it is usable', () => {
    expect(assertUsableApiKey(' sk-abc123 ', 'dshopencodego', 'OPENCODE_GO_API_KEY')).toBe('sk-abc123')
  })

  it('fails a blank key with the Host wording and the INVALID_CREDENTIAL code', () => {
    let caught: unknown
    try {
      assertUsableApiKey('  ', 'dshopencodego', 'OPENCODE_GO_API_KEY')
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect((caught as Error).message).toBe(
      'dshopencodego: the API key resolved from OPENCODE_GO_API_KEY is blank; set OPENCODE_GO_API_KEY to the raw'
      + ' key (the web Models page writes it) or export it in the launching environment',
    )
  })

  it('fails an untransportable key with the Host wording and the INVALID_CREDENTIAL code', () => {
    let caught: unknown
    try {
      assertUsableApiKey('sk-abc 123', 'dshopencodego', 'OPENCODE_GO_API_KEY')
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect((caught as Error).message).toBe(
      'dshopencodego: the API key resolved from OPENCODE_GO_API_KEY contains characters no HTTP header can carry;'
      + ' set OPENCODE_GO_API_KEY to the raw key alone (the web Models page writes it)',
    )
  })

  it('never puts the key itself in the diagnostic', () => {
    let caught: unknown
    try {
      assertUsableApiKey('sk-secret-value 123', 'dshopencodego', 'OPENCODE_GO_API_KEY')
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).not.toContain('sk-secret-value')
  })
})
