/**
 * The settings-facing reading of the catalog.
 *
 * The settings page needs more than the picker's model list: it needs to say
 * which models the gateway advertises, which of them this build cannot
 * configure, how each protocol was decided, and whether the reading is stale
 * because a refresh failed. That projection lives here as a pure function so it
 * can be asserted without a Cordis context.
 *
 * @module @dan-ai-studio/dshopencodego/catalog/reading
 */

import { isModelEnabled, recommendedIds, sortModels } from '../models.ts'
import type { ModelSummary } from '../models.ts'
import { goQuotaFor } from '../go-limits.ts'
import type { CatalogSnapshot } from './index.ts'
import type { CatalogDegradation } from './index.ts'

/** One settings-page reading of the catalog. */
export interface CatalogReading {
  /** Every advertised model, new first, deprecated last. */
  readonly models: readonly ModelSummary[]
  /** True when the gateway listing failed and this is the last known set. */
  readonly stale: boolean
  /** Why the reading is stale, when it is. */
  readonly error?: string
  /**
   * Sources this reading could not read.
   *
   * Empty when every source answered. Otherwise the page is showing a
   * degraded catalog: a protocol that no source describes is a guess, and the
   * thinking levels the online metadata carries are missing. Saying so is the
   * difference between a user who can act and a user who cannot.
   */
  readonly degradations: readonly CatalogDegradation[]
  /**
   * When the model metadata behind this reading was written, when it came
   * from disk rather than from a live read.
   *
   * The listing is live; the capacities, prices, and thinking levels behind
   * it may not be. The page shows this, because a stale number reads exactly
   * like a current one.
   */
  readonly factsCachedAt?: number
  /**
   * True when the catalog behind this reading was read from disk and is
   * being brought up to date in the background.
   *
   * The reading is usable — the models, the protocols, the levels are all
   * there — but it was true when it was written, and a refresh is under
   * way. The page says so, because a page that looks current and is not is
   * worse than one that admits it.
   */
  readonly cached?: boolean
  /** When the content behind this reading was obtained. */
  readonly fetchedAtMs: number
  /**
   * Where the per-model allowances came from: the provider's live document, or
   * the frozen seed (whose transcription date the page shows alongside).
   */
  readonly quotaSource: 'document' | 'seed'
  /** Counts the settings page shows without walking the list again. */
  readonly counts: {
    readonly total: number
    readonly enabled: number
    readonly deprecated: number
    readonly unconfigured: number
    readonly inferred: number
  }
}

/**
 * Project one snapshot for the settings page.
 * @param snapshot - the catalog snapshot, live or retained.
 * @param visibility - per-model switches; absent entries keep the default.
 * @param listingFailure - the failure message when the listing failed.
 * @param now - the clock the "newly shipped" ordering reads; injected so a
 *   reading is a pure function of its inputs rather than of the wall clock.
 * @returns the reading, with unconfigurable ids kept visible so the page can
 *   explain them instead of hiding them.
 */
export function catalogReading(
  snapshot: CatalogSnapshot,
  visibility: Readonly<Record<string, boolean>>,
  listingFailure?: string,
  now?: number,
): CatalogReading {
  const documentQuotas = snapshot.documentQuotas
  const rows: ModelSummary[] = [
    ...[...snapshot.facts.values()].map(fact => {
      const quota = documentQuotas === undefined ? goQuotaFor(fact.id) : documentQuotas.get(fact.id)
      const priced = fact.cost.input > 0 || fact.cost.output > 0
      return {
        id: fact.id,
        name: fact.name,
        contextWindow: fact.contextWindow,
        maxTokens: fact.maxTokens,
        ...fact.maxInputTokens === undefined ? {} : { maxInputTokens: fact.maxInputTokens },
        deprecated: fact.deprecated,
        ...fact.releaseDate === undefined ? {} : { releaseDate: fact.releaseDate },
        ...quota === undefined ? {} : { goQuota: quota },
        ...!priced ? {} : {
          cost: {
            input: fact.cost.input,
            output: fact.cost.output,
            cacheRead: fact.cost.cacheRead,
            cacheWrite: fact.cost.cacheWrite,
          },
        },
        protocolSource: fact.protocolSource,
        assumedLimits: fact.assumedLimits,
        ...fact.inputModalities === undefined ? {} : { inputModalities: fact.inputModalities },
      }
    }),
    ...[...snapshot.unavailable].map(([id, reason]) => ({ id, name: id, configurationMissing: reason })),
  ]
  // Nobody configured switches? Then the default configuration keeps the top
  // few by published monthly estimate, and every row carries that default.
  const recommended = recommendedIds(rows)
  const models = rows.map(row => ({ ...row, recommended: recommended.has(row.id) }))
  const enabled = models.filter(model => isModelEnabled(model, visibility)).length
  return {
    models: sortModels(models, now),
    stale: !snapshot.live,
    ...!snapshot.live && listingFailure !== undefined ? { error: listingFailure } : {},
    degradations: snapshot.degradations ?? [],
    ...snapshot.factsCachedAt === undefined ? {} : { factsCachedAt: snapshot.factsCachedAt },
    ...snapshot.cached === undefined ? {} : { cached: snapshot.cached },
    fetchedAtMs: snapshot.fetchedAtMs,
    quotaSource: documentQuotas === undefined ? 'seed' : 'document',
    counts: {
      total: models.length,
      enabled,
      deprecated: models.filter(model => model.deprecated === true).length,
      unconfigured: models.filter(model => model.configurationMissing !== undefined).length,
      inferred: models.filter(model => model.protocolSource === 'inferred').length,
    },
  }
}
