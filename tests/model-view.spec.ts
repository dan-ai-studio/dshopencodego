/**
 * The settings page's view over the catalog, asserted as pure functions:
 * which rows one filter shows, in which order.
 */
import { describe, expect, it } from 'vitest'
import { capabilityLabels, compactCount, INITIAL_FILTER, inputModalityLabels, visibleModels } from '../src/client/model-view.ts'
import type { ModelFilter } from '../src/client/model-view.ts'
import type { ModelSummary } from '../src/models.ts'

const MODELS: readonly ModelSummary[] = [
  {
    id: 'alpha',
    name: 'Alpha',
    releaseDate: '2026-09-20',
    contextWindow: 100_000,
    maxTokens: 10_000,
    cost: { input: 0.1, output: 0.4 },
    goQuota: { monthlyUsd: 60, monthlyRequests: 150_000 },
  },
  {
    id: 'bravo',
    name: 'Bravo',
    releaseDate: '2026-01-05',
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    cost: { input: 3, output: 15 },
    goQuota: { monthlyUsd: 15, monthlyRequests: 490 },
  },
  { id: 'charlie', name: 'Charlie', contextWindow: 200_000, maxTokens: 20_000 },
  {
    id: 'delta',
    name: 'Delta',
    deprecated: true,
    releaseDate: '2025-12-01',
    contextWindow: 50_000,
    maxTokens: 5_000,
    cost: { input: 1, output: 2 },
  },
]

const filter = (patch: Partial<ModelFilter> = {}): ModelFilter => ({ ...INITIAL_FILTER, ...patch })
const ids = (rows: readonly ModelSummary[]): string[] => rows.map(row => row.id)

describe('model view', () => {
  it('opens on the monthly-requests order', () => {
    expect(INITIAL_FILTER.sort).toBe('quota')
  })

  it('hides deprecated models unless asked', () => {
    expect(ids(visibleModels(MODELS, filter(), {}))).toEqual(['alpha', 'bravo', 'charlie'])
    expect(ids(visibleModels(MODELS, filter({ showDeprecated: true }), {})))
      .toEqual(['alpha', 'bravo', 'charlie', 'delta'])
  })

  it('filters by name or id, case-insensitively', () => {
    expect(ids(visibleModels(MODELS, filter({ query: 'brav' }), {}))).toEqual(['bravo'])
    expect(ids(visibleModels(MODELS, filter({ query: 'CHARLIE' }), {}))).toEqual(['charlie'])
    expect(ids(visibleModels(MODELS, filter({ query: 'zzz' }), {}))).toEqual([])
  })

  it('keeps only switched-on models when asked', () => {
    const rows = visibleModels(MODELS, filter({ onlyEnabled: true }), { bravo: false })
    expect(ids(rows)).toEqual(['alpha', 'charlie'])
  })

  it('orders by release date, newest first, undated last', () => {
    expect(ids(visibleModels(MODELS, filter({ sort: 'released' }), {})))
      .toEqual(['alpha', 'bravo', 'charlie'])
  })

  it('orders by context window, largest first', () => {
    expect(ids(visibleModels(MODELS, filter({ sort: 'context' }), {})))
      .toEqual(['bravo', 'charlie', 'alpha'])
  })

  it('orders by monthly requests, most first, unquantified last', () => {
    expect(ids(visibleModels(MODELS, filter({ sort: 'quota' }), {})))
      .toEqual(['alpha', 'bravo', 'charlie'])
  })

  it('orders by input price, cheapest first, unpriced last', () => {
    expect(ids(visibleModels(MODELS, filter({ sort: 'price' }), {})))
      .toEqual(['alpha', 'bravo', 'charlie'])
  })

  it('labels only the capabilities a model declares', () => {
    const t = (key: string): string => key
    expect(capabilityLabels({ structuredOutput: true, temperature: true, openWeights: true }, t))
      .toEqual(['capStructured', 'capTemperature', 'capOpenWeights'])
    expect(capabilityLabels({ structuredOutput: true, openWeights: true }, t))
      .toEqual(['capStructured', 'capOpenWeights'])
    // A stated "no" and a silent document both stay unlabelled: the page marks
    // what a model can do and never implies the rest is broken.
    expect(capabilityLabels({ structuredOutput: false, temperature: false, openWeights: false }, t)).toEqual([])
    expect(capabilityLabels({}, t)).toEqual([])
  })

  it('labels the declared input modalities in display order', () => {
    const t = (key: string): string => key
    expect(inputModalityLabels({ inputModalities: ['text', 'image', 'audio', 'video', 'pdf'] }, t))
      .toEqual(['modalityText', 'modalityImage', 'modalityAudio', 'modalityVideo', 'modalityPdf'])
    expect(inputModalityLabels({ inputModalities: ['text'] }, t)).toEqual(['modalityText'])
    // No declaration reads as nothing to say, never as "text only".
    expect(inputModalityLabels({}, t)).toEqual([])
  })

  it('formats large counts compactly', () => {
    expect(compactCount(845)).toBe('845')
    expect(compactCount(31_580)).toBe('32K')
    expect(compactCount(150_400)).toBe('150K')
    expect(compactCount(1_048_576)).toBe('1.0M')
    expect(compactCount(12_000_000)).toBe('12M')
  })
})
