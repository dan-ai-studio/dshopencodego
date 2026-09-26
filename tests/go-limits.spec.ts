/**
 * The frozen Go quota seed: every entry is well-formed, the rank orders
 * "most usable first", and unknown ids stay unknown rather than zero.
 */
import { describe, expect, it } from 'vitest'
import { SEED_QUOTAS, goQuotaFor, monthlyRequestsRank } from '../src/go-limits.ts'

describe('goQuotaFor', () => {
  it('answers the documented models', () => {
    expect(goQuotaFor('mimo-v2.6-flash')).toEqual({ monthlyUsd: 60, monthlyRequests: 150_400 })
    expect(goQuotaFor('kimi-k3')).toEqual({ monthlyUsd: 15, monthlyRequests: 490 })
    expect(goQuotaFor('space-bunny-free')).toEqual({ monthlyUsd: 'unlimited', monthlyRequests: 'unlimited' })
  })

  it('answers undefined for an id the docs do not quantify', () => {
    expect(goQuotaFor('definitely-not-a-real-model')).toBeUndefined()
  })

  it('keeps every seed entry well-formed', () => {
    for (const [id, quota] of Object.entries(SEED_QUOTAS)) {
      expect(id.length, `id ${id}`).toBeGreaterThan(0)
      const usd = quota.monthlyUsd
      expect(usd === 'unlimited' || (typeof usd === 'number' && Number.isFinite(usd) && usd > 0), `usd ${id}`).toBe(true)
      const requests = quota.monthlyRequests
      expect(
        requests === undefined || requests === 'unlimited'
        || (typeof requests === 'number' && Number.isFinite(requests) && requests > 0),
        `requests ${id}`,
      ).toBe(true)
    }
    // A frozen seed still has to carry enough of the catalog to be useful at
    // startup; a model it misses only lacks an allowance until a fetch lands.
    expect(Object.keys(SEED_QUOTAS).length).toBeGreaterThanOrEqual(30)
  })
})

describe('monthlyRequestsRank', () => {
  it('orders unlimited above any finite estimate, larger above smaller, unknown last', () => {
    const ranks = [
      monthlyRequestsRank(undefined),
      monthlyRequestsRank({ monthlyUsd: 60 }),
      monthlyRequestsRank({ monthlyUsd: 15, monthlyRequests: 490 }),
      monthlyRequestsRank({ monthlyUsd: 60, monthlyRequests: 150_400 }),
      monthlyRequestsRank({ monthlyUsd: 'unlimited', monthlyRequests: 'unlimited' }),
    ]
    const sorted = [...ranks].sort((left, right) => left - right)
    expect(ranks).toEqual(sorted)
    expect(ranks[0]).toBe(-1)
  })
})
