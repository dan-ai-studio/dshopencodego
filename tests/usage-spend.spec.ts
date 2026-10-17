/**
 * Estimated spend: the catalog's rates multiplied by the provider's own counts.
 *
 * Two rules are what this file exists to hold. An unpriced model is never
 * priced at zero — zero is what "free" looks like, and the catalog states
 * silence, not a price. And reasoning tokens, which the provider already counts
 * inside its output, are reported without being billed a second time.
 *
 * The rates travel with each call (`MeteredUsage.rates`), so a catalog refresh
 * can never re-price tokens that were already spent; the mixed cases below pin
 * that per-call capture down.
 */
import { describe, expect, it } from 'vitest'
import { usableRates, UsageMeter } from '../src/usage/meter.ts'
import type { MeterRates } from '../src/usage/meter.ts'
import { parseGoMeter } from '../src/usage/contract.ts'

/** $1 per million in, $2 per million out, cache reads at a quarter of that. */
const RATES: MeterRates = { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 1 }

describe('estimated spend', () => {
  it('multiplies the counts by the rates the call was made under', () => {
    const meter = new UsageMeter()
    meter.record('glm-5.3', {
      inputTokens: 1_000_000,
      outputTokens: 250_000,
      cacheReadTokens: 1_000_000,
      totalTokens: 2_250_000,
      rates: RATES,
    })
    const reading = meter.snapshot()
    // 1M in at $1/M, 250k out at $2/M, 1M cache read at $0.25/M.
    expect(reading.totals.estimatedUSD).toBe(1.75)
    expect(reading.models[0]).toMatchObject({ model: 'glm-5.3', estimatedUSD: 1.75 })
    expect(reading.totals.unpricedTokens).toBeUndefined()
  })

  it('leaves a model without published rates unpriced rather than free', () => {
    const meter = new UsageMeter()
    meter.record('no-price', { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 })
    const reading = meter.snapshot()
    // Absent, not zero: a zero here would claim the call cost nothing.
    expect(reading.totals.estimatedUSD).toBeUndefined()
    // And with no estimate to qualify, there is nothing to mark as uncovered.
    expect(reading.totals.unpricedTokens).toBeUndefined()
    // The panel reads this to name the model instead of showing a figure.
    expect(reading.models[0]?.estimatedUSD).toBeUndefined()
    expect(reading.models[0] !== undefined && 'estimatedUSD' in reading.models[0]).toBe(false)
  })

  it('keeps priced and unpriced tokens apart in one reading', () => {
    const meter = new UsageMeter()
    meter.record('priced', { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, rates: RATES })
    meter.record('unpriced', { inputTokens: 500, outputTokens: 500, totalTokens: 1_000 })
    const reading = meter.snapshot()
    expect(reading.totals.estimatedUSD).toBe(1)
    expect(reading.totals.unpricedTokens).toBe(1_000)
    expect(reading.totals.totalTokens).toBe(1_001_000)
    const unpriced = reading.models.filter(entry => entry.estimatedUSD === undefined).map(entry => entry.model)
    expect(unpriced).toEqual(['unpriced'])
  })

  it('records a priced call that spent nothing as a real zero', () => {
    const meter = new UsageMeter()
    meter.record('quiet', { inputTokens: 0, outputTokens: 0, totalTokens: 0, rates: RATES })
    const reading = meter.snapshot()
    // A known rate with no tokens is $0 — a different fact from "unpriced".
    expect(reading.totals.estimatedUSD).toBe(0)
    expect(reading.totals.unpricedTokens).toBeUndefined()
    expect(reading.models[0]?.estimatedUSD).toBe(0)
  })

  it('captures the rates per call, so a later call at new rates does not re-price the first', () => {
    const meter = new UsageMeter()
    meter.record('m', { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, rates: RATES })
    meter.record('m', { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, rates: { input: 2, output: 2 } })
    expect(meter.snapshot().totals.estimatedUSD).toBe(3)
  })

  it('counts reasoning without billing it a second time', () => {
    const meter = new UsageMeter()
    meter.record('thinker', {
      inputTokens: 10,
      outputTokens: 100,
      reasoningTokens: 80,
      totalTokens: 110,
      rates: RATES,
    })
    const reading = meter.snapshot()
    // 80 of the 100 output tokens were thinking: still 100 billed, not 180.
    expect(reading.totals.outputTokens).toBe(100)
    expect(reading.totals.totalTokens).toBe(110)
    expect(reading.totals.reasoningTokens).toBe(80)
    expect(reading.totals.estimatedUSD).toBeCloseTo(0.00021, 10)
  })

  it('omits the reasoning count entirely when no call reported one', () => {
    const meter = new UsageMeter()
    meter.record('plain', { inputTokens: 1, outputTokens: 1, totalTokens: 2 })
    // Silent, not zero: providers that publish no breakdown leave the field out
    // (and the reading has to stay equal to one that never carried it at all).
    expect(meter.snapshot().totals).toEqual({
      calls: 1, inputTokens: 1, outputTokens: 1,
      cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2,
    })
    expect('reasoningTokens' in meter.snapshot().totals).toBe(false)
  })
})

describe('catalog rates', () => {
  it('refuses a rate block that publishes no positive rate', () => {
    expect(usableRates(undefined)).toBeUndefined()
    // What "no models.dev entry" and "no published price" both look like here.
    expect(usableRates({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined()
  })

  it('keeps a published rate and drops the cache fields it did not publish', () => {
    expect(usableRates({ input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 }))
      .toEqual({ input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 })
    expect(usableRates({ input: 0.27, output: 1.1, cacheRead: 0, cacheWrite: 0 }))
      .toEqual({ input: 0.27, output: 1.1 })
  })

  it('estimates cache traffic at the input rate when the catalog states no cache rate', () => {
    const meter = new UsageMeter()
    // The catalog publishes input and output rates only, so `usableRates` drops
    // the cache fields instead of zeroing them — an unpublished rate is not a
    // free one.
    const rates = usableRates({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })
    expect(rates).toEqual({ input: 1, output: 2 })
    meter.record('cache-only', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      totalTokens: 1_000_000,
      ...rates === undefined ? {} : { rates },
    })
    // The alternative — pricing an unpublished cache rate at zero — would
    // report a million cached tokens as free.
    expect(meter.snapshot().totals.estimatedUSD).toBe(1)
  })
})

describe('meter wire contract', () => {
  it('carries the spend and reasoning fields across the wire', () => {
    const meter = new UsageMeter()
    meter.record('m', { inputTokens: 1_000_000, outputTokens: 10, reasoningTokens: 7, totalTokens: 1_000_010, rates: RATES })
    meter.record('other', { inputTokens: 3, outputTokens: 4, totalTokens: 7 })
    const parsed = parseGoMeter(meter.snapshot())
    expect(parsed.totals.estimatedUSD).toBe(1.00002)
    expect(parsed.totals.reasoningTokens).toBe(7)
    expect(parsed.totals.unpricedTokens).toBe(7)
    expect(parsed.models.find(entry => entry.model === 'other')?.estimatedUSD).toBeUndefined()
  })

  it('omits the fields the host omitted and rejects a negative estimate', () => {
    const parsed = parseGoMeter({
      sinceMs: 1, atMs: 2, models: [],
      totals: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
    })
    const row = parsed.totals as unknown as Record<string, unknown>
    expect('estimatedUSD' in row).toBe(false)
    expect('reasoningTokens' in row).toBe(false)
    expect(() => parseGoMeter({
      sinceMs: 1, atMs: 2, models: [],
      totals: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, estimatedUSD: -1 },
    })).toThrow(/invalid meter field "estimatedUSD"/)
  })
})
