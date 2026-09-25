/**
 * Online model metadata: how to call each advertised model.
 *
 * models.dev is the only source that knows about a model the day it ships, so
 * it supplies names, capacities, modalities, pricing, lifecycle, and the
 * protocol hint. The installed pi-ai catalog still wins where it knows the
 * exact id, because its entries carry the wire quirks (`thinkingFormat`,
 * reasoning-content replay, affinity format) that a generic metadata document
 * cannot express.
 *
 * Every field degrades independently: a model missing a capacity falls back to
 * the installed entry, then to the route default, and is flagged `assumedLimits`
 * so the settings surface can say so instead of presenting a guess as a fact.
 *
 * @module @dan-ai-studio/dshopencodego/catalog/metadata
 */

import type { Api, Model, ModelCost, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { asWireProtocol, decideProtocol, protocolOfNpm } from './protocol.ts'
import type { ProtocolSource, WireProtocol } from './protocol.ts'
import { MODEL_METADATA_PROVIDER } from './constants.ts'

/** Everything this plugin knows about one advertised model. */
export interface ModelFacts {
  readonly id: string
  readonly name: string
  readonly api: WireProtocol
  /** Which level of the ladder produced {@link api}. */
  readonly protocolSource: ProtocolSource
  readonly contextWindow: number
  /** Maximum input tokens models.dev states; absent for most models. */
  readonly maxInputTokens: number | undefined
  readonly maxTokens: number
  /** True when a capacity came from the route default rather than a source. */
  readonly assumedLimits: boolean
  readonly input: readonly ('text' | 'image')[]
  readonly reasoning: boolean
  readonly thinkingLevelMap: ThinkingLevelMap | undefined
  readonly compat: Model<Api>['compat']
  readonly cost: ModelCost
  readonly deprecated: boolean
  readonly releaseDate: string | undefined
}

/** Parsed online metadata for every id models.dev describes. */
export interface OnlineMetadata {
  readonly models: ReadonlyMap<string, ModelFacts>
  /** Per-id parse failures: the id stays visible with a diagnostic. */
  readonly errors: ReadonlyMap<string, string>
}

/** Route-level fallbacks for a model no source sizes. */
export interface ModelDefaults {
  readonly contextWindow: number
  readonly maxTokens: number
  readonly input: readonly ('text' | 'image')[]
}

const LEVELS: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A calendar date models.dev states without a timezone. */
function validReleaseDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : undefined
}

function rates(value: unknown): ModelCost {
  const cost = record(value)
  const rate = (key: string): number => {
    const entry = cost[key]
    return typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 ? entry : 0
  }
  return { input: rate('input'), output: rate('output'), cacheRead: rate('cache_read'), cacheWrite: rate('cache_write') }
}

/**
 * Reasoning levels a model actually offers.
 *
 * Only what a source states becomes a level. An absent `reasoning_options`
 * list is not "no levels": it means the document does not describe them, so an
 * installed entry's map is kept when there is one. A `toggle` or
 * `budget_tokens` option says the model can think, not how the wire spells a
 * level, so it contributes none — inventing one would put a value on the wire
 * that the gateway may reject. Levels the model does not offer stay `null`,
 * which is what stops the seam from offering a control the provider would
 * ignore.
 */
function thinkingLevels(metadata: Record<string, unknown>, known: Model<Api> | undefined): ThinkingLevelMap | undefined {
  const options = metadata['reasoning_options']
  if (!Array.isArray(options)) return known?.thinkingLevelMap
  const map: ThinkingLevelMap = Object.fromEntries(LEVELS.map(level => [level, null]))
  for (const item of options) {
    const option = record(item)
    if (option['type'] !== 'effort' || !Array.isArray(option['values'])) continue
    for (const value of option['values']) {
      const level = value === 'none' ? 'off' : value
      if (typeof level === 'string' && (LEVELS as readonly string[]).includes(level)) {
        map[level as ModelThinkingLevel] = String(value)
      }
    }
  }
  return map
}

/**
 * The closest installed entry in the same family, for inheriting wire quirks.
 *
 * models.dev's own `family` field is preferred when the document lists a
 * sibling the installed catalog knows. When it does not — the common case for a
 * model that just shipped — the longest shared id prefix stands in, which is
 * how `deepseek-v4.1-flash` inherits `deepseek-v4-flash`'s thinking format.
 * A shared prefix shorter than three characters is treated as no evidence.
 */
function familySibling(
  id: string,
  api: WireProtocol,
  documentFamily: string | undefined,
  entries: Record<string, unknown>,
  builtin: ReadonlyMap<string, Model<Api>>,
): Model<Api> | undefined {
  if (documentFamily !== undefined) {
    for (const [other, value] of Object.entries(entries)) {
      if (other === id || record(value)['family'] !== documentFamily) continue
      const candidate = builtin.get(other)
      if (candidate !== undefined && candidate.api === api) return candidate
    }
  }
  let best: { model: Model<Api>; score: number } | undefined
  const lower = id.toLowerCase()
  for (const [other, candidate] of builtin) {
    if (other === id || candidate.api !== api) continue
    const score = commonPrefixLength(lower, other.toLowerCase())
    if (score < 3) continue
    if (best === undefined || score > best.score) best = { model: candidate, score }
  }
  return best?.model
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1
  return index
}

/**
 * Wire quirks for one protocol.
 *
 * The installed entry's `compat` is authoritative when the protocol matches,
 * including for a *family sibling*: a brand-new id in a family the catalog
 * already serves inherits that family's quirks instead of starting from the
 * generic defaults.
 */
function compatFor(
  api: WireProtocol,
  metadata: Record<string, unknown>,
  exact: Model<Api> | undefined,
  sibling: Model<Api> | undefined,
): Model<Api>['compat'] {
  const inherited = exact !== undefined && exact.api === api
    ? exact.compat
    : sibling !== undefined && sibling.api === api ? sibling.compat : undefined
  if (api === 'openai-completions') {
    return {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      ...(record(metadata['interleaved'])['field'] === 'reasoning_content'
        ? { requiresReasoningContentOnAssistantMessages: true }
        : {}),
      ...inherited,
    } as Model<Api>['compat']
  }
  if (api === 'openai-responses') {
    return { sessionAffinityFormat: 'openai-nosession', ...inherited } as Model<Api>['compat']
  }
  return inherited ?? ({} as Model<Api>['compat'])
}

/** The base URL one protocol's SDK expects for this gateway. */
export function modelBaseURL(api: WireProtocol, baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '')
  // The Anthropic SDK appends `/v1/messages`; the OpenAI SDKs append paths
  // below `/v1`, which the configured base already carries.
  return api === 'anthropic-messages' ? base.replace(/\/v1$/, '') : base
}

/** Inputs the ladder needs beyond the document itself. */
export interface MetadataSources {
  /** Installed catalog entries by id, the first level of the ladder. */
  readonly builtin: ReadonlyMap<string, Model<Api>>
  /** Route defaults for a model no source sizes. */
  readonly defaults: ModelDefaults
  /** Configured per-id protocol overrides, the last level of the ladder. */
  readonly overrides: Readonly<Record<string, string>>
}

/**
 * Parse the `opencode-go` record of a models.dev document.
 * @param body - the whole models.dev document.
 * @param sources - installed entries, defaults, and configured overrides.
 * @returns per-id facts and per-id parse failures; a bad entry never discards
 *   the rest of the document.
 * @throws {Error} when the document has no usable `opencode-go` models object.
 */
export function readOnlineMetadata(body: unknown, sources: MetadataSources): OnlineMetadata {
  const provider = record(record(body)[MODEL_METADATA_PROVIDER])
  const rawModels = provider['models']
  if (rawModels === null || typeof rawModels !== 'object' || Array.isArray(rawModels)) {
    throw new Error(`models.dev has no ${MODEL_METADATA_PROVIDER} models object`)
  }
  const providerNpm = provider['npm']
  const entries = record(rawModels)
  const models = new Map<string, ModelFacts>()
  const errors = new Map<string, string>()
  for (const [id, value] of Object.entries(entries)) {
    const metadata = record(value)
    try {
      const exact = sources.builtin.get(id)
      const override = asWireProtocol(sources.overrides[id])
      if (sources.overrides[id] !== undefined && override === undefined) {
        throw new Error(`configured protocol "${sources.overrides[id]}" is not one of anthropic-messages, openai-completions, openai-responses`)
      }
      const decision = decideProtocol(id, {
        ...exact?.api === undefined ? {} : { builtin: exact.api as WireProtocol },
        ...protocolOfNpm(metadata['provider'] === undefined ? providerNpm : record(metadata['provider'])['npm'] ?? providerNpm) === undefined
          ? {}
          : { online: protocolOfNpm(record(metadata['provider'])['npm'] ?? providerNpm) as WireProtocol },
        ...override === undefined ? {} : { override },
      })
      if (decision === undefined) throw new Error('no protocol could be decided')
      const api = decision.api
      const limit = record(metadata['limit'])
      const onlineContext = positiveInteger(limit['context'])
      const onlineInputLimit = positiveInteger(limit['input'])
      const onlineOutput = positiveInteger(limit['output'])
      const builtinContext = exact?.api === api ? positiveInteger(exact.contextWindow) : undefined
      const builtinOutput = exact?.api === api ? positiveInteger(exact.maxTokens) : undefined
      const contextWindow = onlineContext ?? builtinContext ?? sources.defaults.contextWindow
      const maxTokens = onlineOutput ?? builtinOutput ?? sources.defaults.maxTokens
      const onlineInput = record(metadata['modalities'])['input']
      const input = Array.isArray(onlineInput) && onlineInput.includes('text')
        ? (onlineInput.includes('image') ? ['text', 'image'] as const : ['text'] as const)
        : exact?.api === api ? exact.input : sources.defaults.input
      const reasoning = typeof metadata['reasoning'] === 'boolean'
        ? metadata['reasoning']
        : exact?.api === api ? exact.reasoning : false
      const family = nonEmptyString(metadata['family'])
      const sibling = familySibling(id, api, family, entries, sources.builtin)
      const cost = rates(metadata['cost'])
      const tiers = record(metadata['cost'])['tiers']
      if (Array.isArray(tiers)) {
        const parsed = tiers.flatMap((item) => {
          const tier = record(record(item)['tier'])
          const size = positiveInteger(tier['size'])
          return tier['type'] === 'context' && size !== undefined
            ? [{ ...rates(item), inputTokensAbove: size }]
            : []
        }).sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)
        if (parsed.length > 0) cost.tiers = parsed
      }
      models.set(id, {
        id,
        name: nonEmptyString(metadata['name']) ?? id,
        api,
        protocolSource: decision.source,
        contextWindow,
        maxInputTokens: onlineInputLimit,
        maxTokens,
        assumedLimits: onlineContext === undefined && builtinContext === undefined
          || onlineOutput === undefined && builtinOutput === undefined,
        input,
        reasoning,
        thinkingLevelMap: reasoning ? thinkingLevels(metadata, exact?.api === api ? exact : sibling) : undefined,
        compat: compatFor(api, metadata, exact, sibling),
        cost,
        deprecated: metadata['status'] === 'deprecated',
        releaseDate: validReleaseDate(metadata['release_date']),
      })
    } catch (error: unknown) {
      errors.set(id, error instanceof Error ? error.message : String(error))
    }
  }
  return { models, errors }
}

/** Project one parsed model into the shape pi-ai's providers consume. */
export function toPiModel(facts: ModelFacts, baseURL: string): Model<Api> {
  return {
    id: facts.id,
    name: facts.name,
    provider: 'opencode-go',
    api: facts.api as Api,
    baseUrl: modelBaseURL(facts.api, baseURL),
    reasoning: facts.reasoning,
    ...facts.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: facts.thinkingLevelMap },
    input: [...facts.input],
    contextWindow: facts.contextWindow,
    maxTokens: facts.maxTokens,
    cost: facts.cost,
    compat: facts.compat,
  } as Model<Api>
}
