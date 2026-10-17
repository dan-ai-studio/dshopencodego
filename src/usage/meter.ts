/**
 * The since-boot usage meter.
 *
 * The gateway's `/usage` endpoint reports account percentages, not tokens, so
 * the only honest source of per-model token counts is the usage the provider
 * itself returns on each completed call. This meter accumulates exactly that,
 * per model and in total, for the lifetime of the process — and says so: the
 * number is labelled "since this Harness started", never "today".
 *
 * It also multiplies those counts by the rates the catalog published for the
 * model, because a token count is not what a user is looking for. The product
 * of the two is an *estimate*: the rates come from models.dev, the counts come
 * from the provider, and on the subscription endpoints the account is not
 * billed per token at all. The meter therefore never invents a rate — a model
 * the catalog left unpriced is reported as unpriced, and its tokens are
 * reported separately rather than folded into the estimate as zero.
 *
 * A conversation's own totals are durable and are folded from the session log
 * by the client, which is why nothing here persists.
 *
 * @module @dan-ai-studio/dshopencodego/usage/meter
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/**
 * Per-million-token rates for one model: models.dev's own unit, kept as-is so
 * no rounding is introduced between the published document and the meter.
 */
export interface MeterRates {
  readonly input: number
  readonly output: number
  /**
   * Absent when the catalog states no positive cache rate. Cache traffic is
   * then estimated at the input rate rather than at zero — see
   * {@link spendOf}.
   */
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

/**
 * The rate block exactly as a catalog entry carries it: four numbers, where a
 * zero means "the sources state no positive rate" rather than "free"
 * (see `catalogReading`, which omits `cost` under the same rule).
 */
export interface CatalogRates {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/**
 * Accept a catalog rate block only when it states a positive rate.
 *
 * A block of zeros is what both "models.dev has no entry for this id" and
 * "models.dev states no price" look like by the time the adapter sees them, and
 * pricing tokens at those zeros would render an unknown model as free. The
 * cache fields are dropped when they are not positive for the same reason:
 * absent means "not published", which {@link spendOf} resolves to the input
 * rate instead of to zero.
 * @param cost - the model's rate block, or undefined when it has none.
 * @returns the usable rates, or undefined when the block publishes no price.
 */
export function usableRates(cost: CatalogRates | undefined): MeterRates | undefined {
  if (cost === undefined) return undefined
  if (!(cost.input > 0) && !(cost.output > 0)) return undefined
  return {
    input: cost.input,
    output: cost.output,
    ...cost.cacheRead > 0 ? { cacheRead: cost.cacheRead } : {},
    ...cost.cacheWrite > 0 ? { cacheWrite: cost.cacheWrite } : {},
  }
}

/**
 * One completed call: the provider's own counts, plus the rates that were in
 * force for the model when the call was made.
 *
 * The rates ride on this value instead of a second argument because the mount
 * hands the adapter's observation straight to {@link UsageMeter.record}
 * (`onUsage: ({ model, usage }) => meter.record(model, usage)`), so a second
 * channel would need a second parameter the mount does not pass. Rates are
 * captured per call rather than looked up later, so a catalog refresh can never
 * re-price tokens that were already spent.
 */
export interface MeteredUsage extends TokenUsage {
  /** Rates published for this model at call time; absent when it had none. */
  readonly rates?: MeterRates
}

/** Token counts and call count for one model, or for every model. */
export interface MeterTotals {
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** Sum of the four token fields, which is what a provider bills. */
  readonly totalTokens: number
  /**
   * Reasoning/thinking tokens the provider reported. This is a *subset* of
   * `outputTokens` — pi-ai documents `Usage.reasoning` as included in
   * `output`, and both of its wire parsers fold it in (OpenAI's
   * `completion_tokens` and Anthropic's `output_tokens` already contain it) —
   * so it is counted here and deliberately kept out of `totalTokens`, which
   * would otherwise bill the same tokens twice. Absent until a call reports a
   * positive count; providers that publish no breakdown leave it out.
   */
  readonly reasoningTokens?: number
  /**
   * Estimated USD at the rates in force for each priced call, covering only
   * the tokens those rates priced — `unpricedTokens` names the rest. Absent
   * while no call has had a rate; never a zero standing in for "unknown",
   * because a zero would read as "free".
   */
  readonly estimatedUSD?: number
  /**
   * Tokens the estimate above does not cover, named so a partial figure is
   * never mistaken for the whole spend. Present only alongside an estimate:
   * with no estimate at all there is nothing to qualify, and the reading
   * already says "unpriced" by omitting `estimatedUSD`.
   */
  readonly unpricedTokens?: number
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

/**
 * What one call's tokens cost at the rates in force for it.
 *
 * A cache count whose own rate was not published is estimated at the input
 * rate: the only other candidate is zero, and a zero here would report cache
 * traffic as free — the one claim this meter must never make. The estimate is
 * therefore an upper bound for a model whose cache is cheaper than its input,
 * which is the direction an estimate should err in.
 * @param usage - the call's counts.
 * @param rates - the rates published for the model at call time.
 * @returns USD, in the rates' per-million-token unit.
 */
function spendOf(usage: TokenUsage, rates: MeterRates): number {
  const fallback = rates.input > 0 ? rates.input : rates.output
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  return (
    usage.inputTokens * rates.input
    + usage.outputTokens * rates.output
    + cacheRead * (rates.cacheRead ?? fallback)
    + cacheWrite * (rates.cacheWrite ?? fallback)
  ) / 1_000_000
}

function add(totals: MeterTotals, usage: MeteredUsage): MeterTotals {
  const inputTokens = totals.inputTokens + usage.inputTokens
  const outputTokens = totals.outputTokens + usage.outputTokens
  const cacheReadTokens = totals.cacheReadTokens + (usage.cacheReadTokens ?? 0)
  const cacheWriteTokens = totals.cacheWriteTokens + (usage.cacheWriteTokens ?? 0)
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  // Never folded into `totalTokens`: the provider already counted these inside
  // its output count (see MeterTotals.reasoningTokens).
  const reasoningTokens = (totals.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0)
  const rates = usage.rates
  const billedTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  const unpricedTokens = (totals.unpricedTokens ?? 0) + (rates === undefined ? billedTokens : 0)
  const estimatedUSD = rates === undefined ? totals.estimatedUSD : (totals.estimatedUSD ?? 0) + spendOf(usage, rates)
  return {
    calls: totals.calls + 1,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    // The four counts are disjoint (uncached input, cached input, output), so
    // their sum is the billed total. The provider's own `totalTokens` is not
    // used: it is optional, and mixing the two would double-count a cache read.
    totalTokens,
    ...reasoningTokens > 0 ? { reasoningTokens } : {},
    ...estimatedUSD === undefined ? {} : { estimatedUSD },
    // Only meaningful next to an estimate: a reading with no priced call at all
    // says so by omitting `estimatedUSD`, and naming every token as "unpriced"
    // there would just restate the total.
    ...estimatedUSD === undefined || unpricedTokens === 0 ? {} : { unpricedTokens },
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
   * @param usage - the provider's own usage for that call, with the rates that
   *   were published for the model at the time it ran.
   */
  record(model: string, usage: MeteredUsage): void {
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
