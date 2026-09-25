/**
 * The settings page's view over the catalog: the list is narrowed and ordered
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
import type { InputModality } from '../catalog/metadata.ts'
import { monthlyRequestsRank } from '../go-limits.ts'

/** How the model table is ordered. */
export type ModelSort = 'default' | 'released' | 'name' | 'context' | 'enabled' | 'quota' | 'price'

/** Everything the human narrowed the table with. */
export interface ModelFilter {
  /** Case-insensitive match against the model id and name. */
  readonly query: string
  /** Whether deprecated models are listed at all. */
  readonly showDeprecated: boolean
  /** Whether only currently offered models are listed. */
  readonly onlyEnabled: boolean
  readonly sort: ModelSort
}

/** The table as it opens: the most usable models first, deprecated hidden. */
export const INITIAL_FILTER: ModelFilter = {
  query: '',
  showDeprecated: false,
  onlyEnabled: false,
  sort: 'quota',
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

/**
 * The capabilities one model declares, in a fixed order.
 *
 * Only a stated "yes" becomes a label. A document that omits the capability and
 * one that states "no" both contribute nothing, because the page marks what a
 * model can do — it does not adjudicate what it cannot.
 * @param model - the summary under test.
 * @param t - the active translation for the capability words.
 * @returns the declared labels; empty when the source states none.
 */
export function capabilityLabels(
  model: Pick<ModelSummary, 'structuredOutput' | 'temperature' | 'openWeights'>,
  t: (key: string) => string,
): string[] {
  const labels: string[] = []
  if (model.structuredOutput === true) labels.push(t('capStructured'))
  if (model.temperature === true) labels.push(t('capTemperature'))
  if (model.openWeights === true) labels.push(t('capOpenWeights'))
  return labels
}

/** Translation key for each modality, kept exhaustive over the union. */
const MODALITY_KEYS: Record<InputModality, string> = {
  text: 'modalityText',
  image: 'modalityImage',
  audio: 'modalityAudio',
  video: 'modalityVideo',
  pdf: 'modalityPdf',
}

/**
 * The input modalities one model declares, labelled in display order.
 *
 * Distinct from {@link capabilityLabels}: these are the model's own metadata,
 * not this route's ability to send them, so the list shows what models.dev
 * states even where the Harness can only forward text and images.
 * @param model - the summary under test.
 * @param t - the active translation for the modality words.
 * @returns the labelled modalities; empty when the document declares none.
 */
export function inputModalityLabels(
  model: Pick<ModelSummary, 'inputModalities'>,
  t: (key: string) => string,
): string[] {
  return (model.inputModalities ?? []).map(modality => t(MODALITY_KEYS[modality]))
}
