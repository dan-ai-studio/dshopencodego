/**
 * The frozen Go quota seed: every entry is well-formed, the rank orders
 * "most usable first" (free tiers ahead of paid), and unknown ids stay unknown.
 */
import { describe, expect, it } from 'vitest'
import { SEED_QUOTAS, goQuotaFor, monthlyUsdRank } from '../src/go-limits.ts'

describe('goQuotaFor', () => {
  it('answers the documented models', () => {
    expect(goQuotaFor('mimo-v2.6-flash')).toEqual({ monthlyUsd: 60 })
    expect(goQuotaFor('kimi-k3')).toEqual({ monthlyUsd: 15 })
    // A free tier has no monetary limit, even in the frozen seed.
    expect(goQuotaFor('beam-free')).toEqual({ monthlyUsd: 'unlimited' })
    // space-bunny-free 不在 Go 端点支持的模型之列，断言其配额为 undefined 且不存在于表中
    expect(goQuotaFor('space-bunny-free')).toBeUndefined()
    expect(Object.hasOwn(SEED_QUOTAS, 'space-bunny-free')).toBe(false)
  })

  it('answers undefined for an id the docs do not quantify', () => {
    expect(goQuotaFor('definitely-not-a-real-model')).toBeUndefined()
  })

  it('keeps every seed entry well-formed', () => {
    for (const [id, quota] of Object.entries(SEED_QUOTAS)) {
      expect(id.length, `id ${id}`).toBeGreaterThan(0)
      const usd = quota.monthlyUsd
      expect(usd === 'unlimited' || (typeof usd === 'number' && Number.isFinite(usd) && usd > 0), `usd ${id}`).toBe(true)
    }
    // A frozen seed still has to carry enough of the catalog to be useful at
    // startup; a model it misses only lacks an allowance until a fetch lands.
    expect(Object.keys(SEED_QUOTAS).length).toBeGreaterThanOrEqual(30)
  })
})

describe('monthlyUsdRank', () => {
  it('orders unlimited above any finite allowance, larger above smaller, unknown last', () => {
    const ranks = [
      monthlyUsdRank(undefined),
      monthlyUsdRank({ monthlyUsd: 15 }),
      monthlyUsdRank({ monthlyUsd: 60 }),
      monthlyUsdRank({ monthlyUsd: 'unlimited' }),
    ]
    const sorted = [...ranks].sort((left, right) => left - right)
    expect(ranks).toEqual(sorted)
    expect(ranks[0]).toBe(-1)
  })
})
