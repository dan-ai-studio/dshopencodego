/**
 * The shared visibility rule: explicit switches always win, a marked catalog
 * defaults to the recommended few, and an unmarked one keeps every
 * non-deprecated model so partial facts never lose models.
 *
 * The recommendation is looked up from the transcribed quota table by id, so
 * these cases use real gateway ids — a caller's own projection must not be
 * able to change the default (the Host picker and the settings page build
 * different projections, and must still agree).
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_ENABLED_COUNT, isModelEnabled, isTrainingTier, recommendedIds } from '../src/models.ts'

const model = (id: string, patch: Record<string, unknown> = {}): { id: string; name: string } & Record<string, unknown> =>
  ({ id, name: id, ...patch })

describe('recommendedIds', () => {
  it('picks the top models by published monthly estimate, looked up by id', () => {
    const ids = recommendedIds([
      model('kimi-k3'),             // 490
      model('mimo-v2.6-flash'),     // 150,400
      model('mimo-v2.5'),           // 150,400
      model('space-bunny-free'),    // unlimited
      model('deepseek-v4.1-flash'), // 130,000
      model('deepseek-v4-flash'),   // 65,000
      model('grok-4.7'),            // 845
      model('not-in-the-table'),    // no estimate
    ])
    expect(DEFAULT_ENABLED_COUNT).toBe(5)
    expect([...ids].toSorted()).toEqual([
      'deepseek-v4-flash', 'deepseek-v4.1-flash', 'mimo-v2.5', 'mimo-v2.6-flash', 'space-bunny-free',
    ])
  })

  it('never recommends deprecated or unconfigurable models', () => {
    const ids = recommendedIds([
      model('mimo-v2.6-flash', { deprecated: true }),
      model('mimo-v2.5', { configurationMissing: 'unknown protocol' }),
      model('kimi-k3'),
    ])
    expect([...ids]).toEqual(['kimi-k3'])
  })

  it('skips models that trade training rights for a discount', () => {
    const ids = recommendedIds([
      model('muse-spark-1.3-contributor'), // 226,600 — the largest finite estimate
      model('muse-spark-1.2-contributor'),
      model('kimi-k3'),
    ])
    expect([...ids]).toEqual(['kimi-k3'])
    expect(isTrainingTier({ id: 'muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor' })).toBe(true)
    expect(isTrainingTier({ id: 'plain', name: 'Plain' })).toBe(false)
  })

  it('does not depend on the caller carrying a quota field', () => {
    // Two projections of the same id: one with a quota field, one without.
    const withField = recommendedIds([model('mimo-v2.6-pro', { goQuota: { monthlyUsd: 60, monthlyRequests: 999_999 } })])
    const without = recommendedIds([model('mimo-v2.6-pro')])
    expect([...withField]).toEqual([...without])
  })
})

describe('isModelEnabled', () => {
  it('lets an explicit switch win over everything', () => {
    expect(isModelEnabled(model('x', { recommended: false }), { x: true })).toBe(true)
    expect(isModelEnabled(model('x', { recommended: true }), { x: false })).toBe(false)
  })

  it('uses the recommendation when the catalog marked one', () => {
    expect(isModelEnabled(model('x', { recommended: true }))).toBe(true)
    expect(isModelEnabled(model('x', { recommended: false }))).toBe(false)
  })

  it('keeps non-deprecated models when the catalog carries no marks', () => {
    expect(isModelEnabled(model('x'))).toBe(true)
    expect(isModelEnabled(model('x', { deprecated: true }))).toBe(false)
  })

  it('never enables an unconfigurable model', () => {
    expect(isModelEnabled(model('x', { configurationMissing: 'nope', recommended: true }))).toBe(false)
  })
})
