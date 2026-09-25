/**
 * The settings page's view over the catalog: the table is narrowed and ordered
 * for a human, independently of the wire order the Host publishes.
 *
 * The default order is the Host's own (newly shipped first, then the rest,
 * then deprecated); every other order is a client-side re-sort that never
 * changes what the Host serves.
 *
 * @module @dan-ai-studio/dshopencodego/client/model-view
 */

import { isModelEnabled } from '../models.ts'
import type { ModelSummary } from '../models.ts'
import { monthlyRequestsRank } from '../go-limits.ts'

/** How the model table is ordered. */
export type ModelSort = 'default' | 'released' | 'name' | 'context' | 'enabled' | 'quota' | 'price'

/** How the models are laid out. */
export type ModelView = 'list' | 'table'

/** Everything the human narrowed the table with. */
export interface ModelFilter {
  /** Case-insensitive match against the model id and name. */
  readonly query: string
  /** Whether deprecated models are listed at all. */
  readonly showDeprecated: boolean
  /** Whether only currently offered models are listed. */
  readonly onlyEnabled: boolean
  readonly sort: ModelSort
  /** Rows carry every field; the table view aligns them into columns. */
  readonly view: ModelView
}

/** The table as it opens: the most usable models first, deprecated hidden. */
export const INITIAL_FILTER: ModelFilter = {
  query: '',
  showDeprecated: false,
  onlyEnabled: false,
  sort: 'quota',
  view: 'list',
}

/** 1_048_576 → "1.0M", 150_400 → "150K", 845 → "845". */
export function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

/** Dates sort newest first; an absent date goes last either way. */
function compareDateDesc(left: string | undefined, right: string | undefined): number {
  const a = left ?? ''
  const b = right ?? ''
  if (a === b) return 0
  if (a === '') return 1
  if (b === '') return -1
  return b.localeCompare(a)
}

/** Re-sort a filtered list; `default` keeps the Host's order. */
function sortRows(
  rows: readonly ModelSummary[],
  sort: ModelSort,
  visibility: Readonly<Record<string, boolean>>,
  locale: string | undefined,
): ModelSummary[] {
  if (sort === 'default') return [...rows]
  const byName = (left: ModelSummary, right: ModelSummary): number => left.name.localeCompare(right.name, locale)
  const copy = [...rows]
  switch (sort) {
    case 'released':
      return copy.sort((left, right) => compareDateDesc(left.releaseDate, right.releaseDate) || byName(left, right))
    case 'name':
      return copy.sort(byName)
    case 'context':
      return copy.sort((left, right) =>
        (right.contextWindow ?? -1) - (left.contextWindow ?? -1) || byName(left, right))
    case 'enabled':
      return copy.sort((left, right) =>
        Number(isModelEnabled(right, visibility)) - Number(isModelEnabled(left, visibility)) || byName(left, right))
    case 'quota':
      return copy.sort((left, right) =>
        monthlyRequestsRank(right.goQuota) - monthlyRequestsRank(left.goQuota) || byName(left, right))
    case 'price':
      // Cheapest input rate first; models with no published rate sort last.
      return copy.sort((left, right) =>
        (left.cost?.input ?? Number.MAX_SAFE_INTEGER) - (right.cost?.input ?? Number.MAX_SAFE_INTEGER)
        || (left.cost?.output ?? 0) - (right.cost?.output ?? 0)
        || byName(left, right))
  }
}

/**
 * The rows one filter yields, in the chosen order.
 * @param models - the Host's listing, in its own order.
 * @param filter - the human's narrowing.
 * @param visibility - per-model switches, for the enabled-only filter and the enabled-first order.
 * @param locale - active locale used for name collation.
 * @returns the visible rows; the caller derives "hidden" from the difference.
 */
export function visibleModels(
  models: readonly ModelSummary[],
  filter: ModelFilter,
  visibility: Readonly<Record<string, boolean>>,
  locale?: string,
): ModelSummary[] {
  const needle = filter.query.trim().toLowerCase()
  const rows = models.filter((model) => {
    if (!filter.showDeprecated && model.deprecated === true) return false
    if (filter.onlyEnabled && !isModelEnabled(model, visibility)) return false
    if (needle.length === 0) return true
    return model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle)
  })
  return sortRows(rows, filter.sort, visibility, locale)
}
