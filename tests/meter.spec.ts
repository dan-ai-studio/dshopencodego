/**
 * The since-boot meter: provider-reported usage in, honest totals out.
 *
 * The billed total is the sum of the disjoint counts, never the provider's
 * own optional `totalTokens` mixed in — mixing the two would double-count a
 * cache read.
 */
import { describe, expect, it } from 'vitest'
import { UsageMeter } from '../src/usage/meter.ts'

describe('UsageMeter', () => {
  it('starts empty', () => {
    const meter = new UsageMeter()
    const reading = meter.snapshot()
    expect(reading.sinceMs).toBeLessThanOrEqual(reading.atMs)
    expect(reading.totals).toEqual({
      calls: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
    })
    expect(reading.models).toEqual([])
  })

  it('accumulates per model and in total, busiest first', () => {
    const meter = new UsageMeter()
    meter.record('small', { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    meter.record('big', { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadTokens: 20 })
    meter.record('small', { inputTokens: 1, outputTokens: 1, totalTokens: 2 })
    const reading = meter.snapshot()
    expect(reading.totals).toEqual({
      calls: 3, inputTokens: 111, outputTokens: 56,
      cacheReadTokens: 20, cacheWriteTokens: 0, totalTokens: 187,
    })
    expect(reading.models.map(entry => entry.model)).toEqual(['big', 'small'])
    expect(reading.models[0]).toMatchObject({ calls: 1, inputTokens: 100, totalTokens: 170 })
    expect(reading.models[1]).toMatchObject({ calls: 2, inputTokens: 11, totalTokens: 17 })
  })

  it('counts cache writes without double-counting the provider total', () => {
    const meter = new UsageMeter()
    meter.record('m', { inputTokens: 10, outputTokens: 5, totalTokens: 999, cacheWriteTokens: 7 })
    expect(meter.snapshot().totals.totalTokens).toBe(22)
  })
})
