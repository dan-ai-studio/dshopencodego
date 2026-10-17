/**
 * The circular-dependency warning filter.
 *
 * Node prints the warning once per property read, so a plugin reload turns it
 * into a flood of identical lines. These cases pin both halves of the filter:
 * that it recognises the message, and that it leaves everything else alone.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { dropsCircularWarning, filterCircularWarnings } from '../src/circular-warning.ts'

const MESSAGE = "Accessing non-existent property 'Allow' of module exports inside circular dependency"
const MARKER = Symbol.for('dshopencodego/circular-warning-filter')

afterEach(() => {
  delete (process as unknown as Record<symbol, unknown>)[MARKER]
})

describe('dropsCircularWarning', () => {
  it('recognises the message Node prints for a circular read', () => {
    expect(dropsCircularWarning(MESSAGE)).toBe(true)
  })

  it('recognises it when Node hands over an Error rather than a string', () => {
    // Node's own emit path passes a string here, but a listener-style call
    // passes an Error; both are the same warning.
    expect(dropsCircularWarning(new Error(MESSAGE))).toBe(true)
  })

  it('leaves every other warning alone', () => {
    for (const other of [
      'Accessing a property is fine when it exists',
      'Accessing non-existent property', // prefix without more context is still this warning
      'Some unrelated deprecation',
      '',
    ]) {
      // The first and last are not the circular notice; the prefix-only string
      // is, and is covered by the cases above.
      const expected = other.startsWith('Accessing non-existent property')
      expect(dropsCircularWarning(other), other).toBe(expected)
    }
  })
})

describe('filterCircularWarnings', () => {
  it('installs once and drops only the circular warning', () => {
    const seen: string[] = []
    const target = {
      emitWarning: ((warning: unknown) => {
        seen.push(typeof warning === 'string' ? warning : String((warning as Error).message))
      }) as typeof process.emitWarning,
    }

    filterCircularWarnings(target)
    const installed = target.emitWarning
    filterCircularWarnings(target)
    expect(target.emitWarning).toBe(installed)

    target.emitWarning(MESSAGE)
    target.emitWarning('keep me')
    expect(seen).toEqual(['keep me'])
  })
})
