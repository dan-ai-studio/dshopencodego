/**
 * The since-boot usage meter.
 *
 * The gateway's `/usage` endpoint reports account percentages, not tokens, so
 * the only honest source of per-model token counts is the usage the provider
 * itself returns on each completed call. This meter accumulates exactly that,
 * per model and in total, for the lifetime of the process — and says so: the
 * number is labelled "since this Harness started", never "today".
 *
 * A conversation's own totals are durable and are folded from the session log
 * by the client, which is why nothing here persists.
 *
 * @module @dan-ai-studio/dshopencodego/usage/meter
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** Token counts and call count for one model, or for every model. */
export interface MeterTotals {
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** Sum of the four token fields, which is what a provider bills. */
  readonly totalTokens: number
}

/** One model's share of the since-boot meter. */
export interface MeterModelEntry extends MeterTotals {
  readonly model: string
}

/** The whole since-boot reading. */
export interface GoMeter {
  /** When this process started counting, in epoch milliseconds. */
  readonly sinceMs: number
  /** When this reading was taken, in epoch milliseconds. */
  readonly atMs: number
  readonly totals: MeterTotals
  /** Per-model entries, busiest first. */
  readonly models: readonly MeterModelEntry[]
}

const EMPTY: MeterTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
}

function add(totals: MeterTotals, usage: TokenUsage): MeterTotals {
  const inputTokens = totals.inputTokens + usage.inputTokens
  const outputTokens = totals.outputTokens + usage.outputTokens
  const cacheReadTokens = totals.cacheReadTokens + (usage.cacheReadTokens ?? 0)
  const cacheWriteTokens = totals.cacheWriteTokens + (usage.cacheWriteTokens ?? 0)
  return {
    calls: totals.calls + 1,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    // The four counts are disjoint (uncached input, cached input, output), so
    // their sum is the billed total. The provider's own `totalTokens` is not
    // used: it is optional, and mixing the two would double-count a cache read.
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  }
}

/** Accumulates provider-reported usage for the lifetime of one Host process. */
export class UsageMeter {
  private readonly sinceMs = Date.now()
  private totals: MeterTotals = EMPTY
  private readonly byModel = new Map<string, MeterTotals>()

  /**
   * Record one completed call.
   * @param model - the model id the call was made with.
   * @param usage - the provider's own usage for that call.
   */
  record(model: string, usage: TokenUsage): void {
    this.totals = add(this.totals, usage)
    this.byModel.set(model, add(this.byModel.get(model) ?? EMPTY, usage))
  }

  /** The current reading, busiest model first. */
  snapshot(now = Date.now()): GoMeter {
    return {
      sinceMs: this.sinceMs,
      atMs: now,
      totals: this.totals,
      models: [...this.byModel.entries()]
        .map(([model, totals]) => ({ model, ...totals }))
        .sort((left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model)),
    }
  }
}
