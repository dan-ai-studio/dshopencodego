/**
 * API-key judgement: the Host's policy, this plugin's rejection wording.
 *
 * `assertUsableApiKey` no longer restates the character policy — it reads
 * `dsh-credentials.normalizeApiKey` and turns that verdict into the
 * `INVALID_CREDENTIAL` failure a provider raises. These tests pin the wording
 * and the code, so a key that would otherwise reach an HTTP header and fail
 * there as an opaque 401 is refused locally with an explanation instead.
 */
import { describe, expect, it } from 'vitest'
import { assertUsableApiKey } from '../src/api-key.ts'

describe('assertUsableApiKey', () => {
  it('returns the trimmed key when it is usable', () => {
    expect(assertUsableApiKey(' sk-abc123 ', 'dshopencodego', 'OPENCODE_GO_API_KEY')).toBe('sk-abc123')
  })

  it('accepts the whole printable-ASCII range', () => {
    const printable = '!"#$%&\'()*+,-./:<=>?@[\\]^_`{|}~'
    expect(assertUsableApiKey(printable, 'dshopencodego', 'OPENCODE_GO_API_KEY')).toBe(printable)
  })

  it('fails a blank key with the Host wording and the INVALID_CREDENTIAL code', () => {
    for (const blank of ['', '  ', '   \n\t ']) {
      let caught: unknown
      try {
        assertUsableApiKey(blank, 'dshopencodego', 'OPENCODE_GO_API_KEY')
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({ code: 'INVALID_CREDENTIAL' })
      expect((caught as Error).message).toBe(
        'dshopencodego: the API key resolved from OPENCODE_GO_API_KEY is blank; set OPENCODE_GO_API_KEY to the raw'
        + ' key (the web Models page writes it) or export it in the launching environment',
      )
    }
  })

  it('fails an untransportable key with the Host wording and the INVALID_CREDENTIAL code', () => {
    // Interior space, a control character and non-ASCII are all outside the
    // printable-ASCII range a header value carries.
    for (const illegal of ['sk-abc 123', 'sk-abc\x00', 'sk-abc密钥']) {
      let caught: unknown
      try {
        assertUsableApiKey(illegal, 'dshopencodego', 'OPENCODE_GO_API_KEY')
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({ code: 'INVALID_CREDENTIAL' })
      expect((caught as Error).message).toBe(
        'dshopencodego: the API key resolved from OPENCODE_GO_API_KEY contains characters no HTTP header can carry;'
        + ' set OPENCODE_GO_API_KEY to the raw key alone (the web Models page writes it)',
      )
    }
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
