/**
 * The settings-facing model summary and its visibility rules.
 *
 * The adapter's `listModels` and the settings page both need the same facts and
 * the same answer to "is this model offered right now", so the rule lives here
 * once: a model nobody can configure is never offered, an explicit switch
 * always wins, and a deprecated model defaults to off.
 *
 * @module @dan-ai-studio/dshopencodego/models
 */

import type { ProtocolSource } from './catalog/protocol.ts'
import type { InputModality } from './catalog/metadata.ts'
import type { GoQuota } from './go-limits.ts'
import { goQuotaFor, monthlyRequestsRank } from './go-limits.ts'

/** One model as the settings page and the picker describe it. */
export interface ModelSummary {
  readonly id: string
  readonly name: string
  readonly contextWindow?: number
  /** Maximum input tokens, when the sources state one. */
  readonly maxInputTokens?: number
  readonly maxTokens?: number
  /** models.dev marks the model as retained for compatibility only. */
  readonly deprecated?: boolean
  /** Release date when models.dev states one. */
  readonly releaseDate?: string
  /** Go's published allowance, transcribed from the provider's docs. */
  readonly goQuota?: GoQuota
  /**
   * Per-million-token rates from models.dev. Absent when the sources state no
   * positive rate, so a fallback-zero cost never renders as "free".
   */
  readonly cost?: {
    readonly input: number
    readonly output: number
    readonly cacheRead?: number
    readonly cacheWrite?: number
  }
  /** Which ladder level decided this model's protocol. */
  readonly protocolSource?: ProtocolSource
  /**
   * Every input modality models.dev declares, in display order. Absent when the
   * document declares none this build can name.
   */
  readonly inputModalities?: readonly InputModality[]
  /**
   * Capabilities models.dev declares, in its own words. Each is absent when the
   * document is silent about it — absence is "unstated", never "unsupported",
   * so the page leaves the cell empty instead of showing a negative.
   */
  readonly structuredOutput?: boolean
  readonly temperature?: boolean
  readonly openWeights?: boolean
  /** True when a capacity came from the route default rather than a source. */
  readonly assumedLimits?: boolean
  /** Advertised by the gateway but not configurable, with the reason. */
  readonly configurationMissing?: string
  /**
   * Whether the default configuration keeps this model enabled when nobody set
   * an explicit switch — the top few by published monthly request estimate.
   */
  readonly recommended?: boolean
}

/** How many models the default configuration keeps enabled. */
export const DEFAULT_ENABLED_COUNT = 5

/**
 * Whether the model trades training rights for its price — Meta's
 * "Contributor" tiers, whose prompts and completions may train future models.
 * Such a model is never part of the default-enabled few.
 * @param model - the model under test.
 * @returns true when the model belongs to a training-contributor tier.
 */
export function isTrainingTier(model: Pick<ModelSummary, 'id' | 'name'>): boolean {
  return /contributor/i.test(model.id) || /contributor/i.test(model.name)
}

/**
 * The default-enabled ids when nobody configured switches: the models with the
 * largest published monthly request estimate first, which is Go's own "most
 * usable" order. Deprecated, unconfigurable, and training-contributor models
 * never qualify, and a model with no published estimate does not displace one
 * that has it.
 *
 * The estimate is looked up here, by id, rather than read from a `goQuota`
 * field: the Host's picker and the settings page build their model lists from
 * different projections, and a caller that forgot to carry the field would
 * silently fall back to an alphabetical default — which is exactly the
 * two-surfaces-disagree defect this signature exists to prevent.
 * @param models - the advertised models, in any order.
 * @returns the ids the default configuration keeps enabled.
 */
export function recommendedIds(
  models: readonly Pick<ModelSummary, 'id' | 'name' | 'deprecated' | 'configurationMissing'>[],
): ReadonlySet<string> {
  const ranked = models
    .filter(model =>
      model.configurationMissing === undefined
      && model.deprecated !== true
      && !isTrainingTier(model))
    .toSorted((left, right) =>
      monthlyRequestsRank(goQuotaFor(right.id)) - monthlyRequestsRank(goQuotaFor(left.id))
      || left.id.localeCompare(right.id))
  return new Set(ranked.slice(0, DEFAULT_ENABLED_COUNT).map(model => model.id))
}

/**
 * Whether the picker offers one model.
 * @param model - the summary under test.
 * @param visibility - per-model switches; an absent entry keeps the default.
 * @returns true when the model should be selectable.
 */
export function isModelEnabled(
  model: Pick<ModelSummary, 'id' | 'deprecated' | 'configurationMissing' | 'recommended'>,
  visibility?: Readonly<Record<string, boolean>>,
): boolean {
  if (model.configurationMissing !== undefined) return false
  const explicit = visibility !== undefined && Object.hasOwn(visibility, model.id)
    ? visibility[model.id]
    : undefined
  if (typeof explicit === 'boolean') return explicit
  // A marked catalog decides the default; an unmarked one keeps every
  // non-deprecated model, so callers that pass partial facts never lose models.
  return typeof model.recommended === 'boolean' ? model.recommended : model.deprecated !== true
}

/** A calendar date as models.dev states it, without a timezone. */
export function validReleaseDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}

/** Whether a model shipped within the last week. */
export function isNewModel(model: ModelSummary, now = Date.now()): boolean {
  if (model.deprecated === true || !validReleaseDate(model.releaseDate)) return false
  const days = Math.floor(now / 86_400_000) - Date.parse(model.releaseDate) / 86_400_000
  return days >= 0 && days < 7
}

/**
 * Order models for display: newly shipped first, then the rest, then deprecated.
 * Newest releases come first within the first group.
 */
export function sortModels(models: readonly ModelSummary[], now = Date.now()): ModelSummary[] {
  const rank = (model: ModelSummary): number => model.deprecated === true ? 2 : isNewModel(model, now) ? 0 : 1
  return [...models].sort((left, right) => rank(left) - rank(right)
    || (isNewModel(left, now) && isNewModel(right, now) ? right.releaseDate!.localeCompare(left.releaseDate!) : 0))
}
