/**
 * Locale dictionaries: the page looks every key up by name, so a key missing
 * in one language renders as a lookup miss rather than a fallback.
 */
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('locales', () => {
  it('keeps both dictionaries on exactly the same keys', () => {
    expect(Object.keys(zh).toSorted()).toEqual(Object.keys(en).toSorted())
  })

  it('leaves no empty copy in either language', () => {
    for (const [key, value] of [...Object.entries(en), ...Object.entries(zh)]) {
      expect(typeof value, key).toBe('string')
      expect(value.length, key).toBeGreaterThan(0)
    }
  })
})
