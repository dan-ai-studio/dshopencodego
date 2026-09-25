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

/** One settings-page reading of the catalog. */
export interface CatalogReading {
  /** Every advertised model, new first, deprecated last. */
  readonly models: readonly ModelSummary[]
  /** True when the gateway listing failed and this is the last known set. */
  readonly stale: boolean
  /** Why the reading is stale, when it is. */
  readonly error?: string
  /** When the underlying snapshot was built. */
  readonly fetchedAtMs: number
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
 * @returns the reading, with unconfigurable ids kept visible so the page can
 *   explain them instead of hiding them.
 */
export function catalogReading(
  snapshot: CatalogSnapshot,
  visibility: Readonly<Record<string, boolean>>,
  listingFailure?: string,
): CatalogReading {
  const rows: ModelSummary[] = [
    ...[...snapshot.facts.values()].map(fact => {
      const quota = goQuotaFor(fact.id)
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
    models: sortModels(models),
    stale: !snapshot.live,
    ...!snapshot.live && listingFailure !== undefined ? { error: listingFailure } : {},
    fetchedAtMs: snapshot.fetchedAtMs,
    counts: {
      total: models.length,
      enabled,
      deprecated: models.filter(model => model.deprecated === true).length,
      unconfigured: models.filter(model => model.configurationMissing !== undefined).length,
      inferred: models.filter(model => model.protocolSource === 'inferred').length,
    },
  }
}
