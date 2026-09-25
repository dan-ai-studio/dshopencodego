/**
 * The shared visibility rule: explicit switches always win, a marked catalog
 * defaults to the recommended few, and an unmarked one keeps every
 * non-deprecated model so partial facts never lose models.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_ENABLED_COUNT, isModelEnabled, recommendedIds } from '../src/models.ts'

const model = (id: string, patch: Record<string, unknown> = {}): { id: string } & Record<string, unknown> => ({ id, ...patch })

describe('recommendedIds', () => {
  it('picks the top models by published monthly estimate', () => {
    const ids = recommendedIds([
      model('small', { goQuota: { monthlyUsd: 15, monthlyRequests: 490 } }),
      model('big', { goQuota: { monthlyUsd: 60, monthlyRequests: 150_400 } }),
      model('mid', { goQuota: { monthlyUsd: 60, monthlyRequests: 31_580 } }),
      model('free', { goQuota: { monthlyUsd: 'unlimited', monthlyRequests: 'unlimited' } }),
      model('none'),
    ])
    expect([...ids].toSorted()).toEqual(['big', 'free', 'mid'])
    expect(ids.size).toBe(DEFAULT_ENABLED_COUNT)
  })

  it('never recommends deprecated or unconfigurable models', () => {
    const ids = recommendedIds([
      model('gone', { deprecated: true, goQuota: { monthlyUsd: 60, monthlyRequests: 999_999 } }),
      model('broken', { configurationMissing: 'unknown protocol', goQuota: { monthlyUsd: 60, monthlyRequests: 999_999 } }),
      model('ok', { goQuota: { monthlyUsd: 60, monthlyRequests: 1 } }),
    ])
    expect([...ids]).toEqual(['ok'])
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
