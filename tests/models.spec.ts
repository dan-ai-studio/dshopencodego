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
import { DEFAULT_ENABLED_COUNT, isFreeModel, isModelEnabled, isTrainingTier, recommendedIds } from '../src/models.ts'

const model = (id: string, patch: Record<string, unknown> = {}): { id: string; name: string } & Record<string, unknown> =>
  ({ id, name: id, ...patch })

describe('recommendedIds', () => {
  it('picks the top models by published monthly allowance, looked up by id', () => {
    const ids = recommendedIds([
      model('kimi-k3'),             // $15
      model('mimo-v2.6-flash'),     // $60
      model('mimo-v2.5'),           // $60
      model('deepseek-v4.1-flash'), // $60
      model('deepseek-v4-flash'),   // $30
      model('grok-4.7'),            // $15
      model('not-in-the-table'),    // no allowance
    ])
    expect(DEFAULT_ENABLED_COUNT).toBe(5)
    expect([...ids].toSorted()).toEqual([
      'deepseek-v4-flash', 'deepseek-v4.1-flash', 'grok-4.7', 'mimo-v2.5', 'mimo-v2.6-flash',
    ])
  })

  it('prefers free tiers over every paid allowance', () => {
    const ids = recommendedIds([
      model('mimo-v2.6-flash'),  // $60
      model('beam-free'),        // unlimited
      model('hy4-flash-free'),   // unlimited
      model('longcat-2.5-free'), // unlimited
      model('kimi-k3'),          // $15
    ])
    expect([...ids].toSorted()).toEqual([
      'beam-free', 'hy4-flash-free', 'kimi-k3', 'longcat-2.5-free', 'mimo-v2.6-flash',
    ])
  })

  it('enables every free tier, even well past the five paid slots', () => {
    const freeIds = [
      'beam-free', 'hy4-flash-free', 'longcat-2.5-free', // the first-party unlimited entries
      'new-one-free', 'new-two-free', 'new-three-free',
      'new-four-free', 'new-five-free',                  // recognised by name + price alone
    ]
    const paidIds = [
      'mimo-v2.6-flash', 'mimo-v2.5', 'deepseek-v4.1-flash', 'deepseek-v4-flash', 'grok-4.7',
    ]
    const ids = recommendedIds([
      ...freeIds.map(id => model(id)),
      ...paidIds.map(id => model(id)),
      model('mimo-v2.6-pro'), // a sixth paid model: no slot is left for it
    ])
    expect([...ids].toSorted()).toEqual([...freeIds, ...paidIds].toSorted())
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
      model('muse-spark-1.3-contributor'), // a paid $60 tier, but training rights disqualify it
      model('muse-spark-1.2-contributor'),
      model('kimi-k3'),
    ])
    expect([...ids]).toEqual(['kimi-k3'])
    expect(isTrainingTier({ id: 'muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor' })).toBe(true)
    expect(isTrainingTier({ id: 'plain', name: 'Plain' })).toBe(false)
  })

  it('does not depend on the caller carrying a quota field', () => {
    // Two projections of the same id: one with a quota field, one without.
    const withField = recommendedIds([model('mimo-v2.6-pro', { goQuota: { monthlyUsd: 60 } })])
    const without = recommendedIds([model('mimo-v2.6-pro')])
    expect([...withField]).toEqual([...without])
  })
})

describe('isFreeModel', () => {
  it('requires both a free name and no positive rate', () => {
    expect(isFreeModel(model('beam-free'))).toBe(true)
    expect(isFreeModel(model('Beam Free', { cost: { input: 0, output: 0 } }))).toBe(true)
    expect(isFreeModel(model('免费模型'))).toBe(true)
    // A name that merely contains "free" is not a free tier when a real rate
    // is published — "freemium" is not a word-boundary match either.
    expect(isFreeModel(model('freemium-pro', { cost: { input: 2, output: 8 } }))).toBe(false)
    expect(isFreeModel(model('paid-free-tier', { cost: { input: 2, output: 8 } }))).toBe(false)
    // A zero rate alone is not enough: the name has to call it free, or a model
    // with missing metadata would silently become a default-enabled free tier.
    expect(isFreeModel(model('mystery-model', { cost: { input: 0, output: 0 } }))).toBe(false)
    expect(isFreeModel(model('mimo-v2.6-flash', { cost: { input: 0.14, output: 0.28 } }))).toBe(false)
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
