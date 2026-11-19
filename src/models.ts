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
import { goQuotaFor, monthlyUsdRank } from './go-limits.ts'

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
  /** True when a capacity came from the route default rather than a source. */
  readonly assumedLimits?: boolean
  /** Advertised by the gateway but not configurable, with the reason. */
  readonly configurationMissing?: string
  /**
   * Whether the default configuration keeps this model enabled when nobody set
   * an explicit switch — every free tier, plus the few highest-allowance paid
   * models.
   */
  readonly recommended?: boolean
}

/** How many paid models the default configuration keeps enabled. Free tiers are always enabled on top of these. */
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
 * Whether a model is a free tier, judged from its name and its published token
 * rates: the name has to call it free (`beam-free`, `Beam Free`, `免费`) and no
 * positive input/output rate may be published. Both signals are required — a
 * name alone would enable a paid model that happens to say "free", and a zero
 * rate alone would enable any model whose metadata has not arrived yet.
 *
 * This covers models the gateway and the frozen seed do not yet mark
 * `unlimited`, so a newly published free model is enabled without a code change.
 * The first-party `unlimited` allowance is still honoured by `recommendedIds`.
 * @param model - the model under test.
 * @returns true when name and price together identify a free tier.
 */
export function isFreeModel(model: Pick<ModelSummary, 'id' | 'name' | 'cost'>): boolean {
  const freeName = /(?:^|[^a-z])(?:free|免费)(?:[^a-z]|$)/i
  if (!freeName.test(model.id) && !freeName.test(model.name)) return false
  const cost = model.cost
  // An absent cost means "no positive rate published", the same as a zero cost
  // in the catalog's `rates()` parser — never a fallback-positive price.
  return cost === undefined || (cost.input <= 0 && cost.output <= 0)
}

/**
 * The default-enabled ids when nobody configured switches: **every** free tier
 * is enabled, then the paid models with the largest published monthly allowance
 * up to {@link DEFAULT_ENABLED_COUNT}. Free tiers do not consume a paid slot,
 * so adding a new free model never pushes an existing default off the list.
 * Deprecated, unconfigurable, and training-contributor models never qualify.
 *
 * A free tier is recognised either by the gateway/document `unlimited`
 * allowance or by name + price (see {@link isFreeModel}); the latter means a
 * newly published free model is enabled without a seed edit. The allowance is
 * looked up here, by id, rather than read from a `goQuota` field: the Host's
 * picker and the settings page build their model lists from different
 * projections, and a caller that forgot to carry the field would silently fall
 * back to an alphabetical default — which is exactly the two-surfaces-disagree
 * defect this signature exists to prevent.
 * @param models - the advertised models, in any order.
 * @returns the ids the default configuration keeps enabled.
 */
export function recommendedIds(
  models: readonly Pick<ModelSummary, 'id' | 'name' | 'deprecated' | 'configurationMissing' | 'cost'>[],
): ReadonlySet<string> {
  const eligible = models.filter(model =>
    model.configurationMissing === undefined
    && model.deprecated !== true
    && !isTrainingTier(model))
  const isFree = (model: (typeof eligible)[number]): boolean =>
    goQuotaFor(model.id)?.monthlyUsd === 'unlimited' || isFreeModel(model)
  const enabled = [
    ...eligible.filter(isFree),
    ...eligible
      .filter(model => !isFree(model))
      .toSorted((left, right) =>
        monthlyUsdRank(goQuotaFor(right.id)) - monthlyUsdRank(goQuotaFor(left.id))
        || left.id.localeCompare(right.id))
      .slice(0, DEFAULT_ENABLED_COUNT),
  ]
  return new Set(enabled.map(model => model.id))
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

/**
 * Configured visibility switches naming ids no source advertises.
 *
 * A switch exists to change one model's presence, so one for an id the
 * gateway does not serve can only be inert — nothing else in the plugin can
 * report it, because the model is absent from every list a surface renders.
 * The reverse case (advertised but unbuildable) is reported where the catalog
 * assembles; this is the diagnostic for the other direction.
 * @param visibility - the configured per-model switches.
 * @param advertised - every id the gateway currently advertises, whether or
 *   not this build can configure it.
 * @returns the configured ids with no advertised counterpart, sorted.
 */
export function unadvertisedVisibilityIds(
  visibility: Readonly<Record<string, boolean>>,
  advertised: Iterable<string>,
): string[] {
  const known = new Set(advertised)
  return Object.keys(visibility).filter(id => !known.has(id)).sort()
}

/** A calendar date as models.dev states it, without a timezone. */
export function validReleaseDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}

/** Whether a model shipped within the last week. */
function isNewModel(model: ModelSummary, now = Date.now()): boolean {
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
