/**
 * The live catalog: which models exist, and how to call each one.
 *
 * Membership comes from the gateway listing, capability from models.dev, and
 * exact protocol/wire quirks from the installed pi-ai catalog, merged through
 * the ladder in `./protocol.ts`. The snapshot is cached for the configured
 * refresh interval, and an unknown model id forces one revalidation even inside
 * that interval — that is what makes a model the gateway added this morning
 * callable this afternoon without a plugin release.
 *
 * Failures degrade rather than empty: a listing outage keeps the last known
 * models and marks the snapshot not-live, a metadata outage keeps the last
 * document, and a single unparseable model is reported by id while every other
 * model keeps serving.
 *
 * @module @dan-ai-studio/dshopencodego/catalog
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, Model, Provider } from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import {
  DISPLAY_NAME,
  MODEL_METADATA_MAX_BYTES,
  MODEL_METADATA_URL,
  PROVIDER_ID,
  METADATA_FETCH_TIMEOUT_MS,
} from './constants.ts'
import { fetchModelIds } from './gateway.ts'
import { readBoundedJson } from './json-response.ts'
import { readOnlineMetadata, toPiModel } from './metadata.ts'
import type { ModelDefaults, ModelFacts } from './metadata.ts'

export { PROVIDER_ID, DISPLAY_NAME, DEFAULT_BASE_URL } from './constants.ts'
export { readModelIds, fetchModelIds } from './gateway.ts'
export { readOnlineMetadata, toPiModel, modelBaseURL } from './metadata.ts'
export type { ModelFacts, OnlineMetadata, ModelDefaults } from './metadata.ts'
export { decideProtocol, inferProtocol, protocolOfNpm } from './protocol.ts'
export type { ProtocolDecision, ProtocolSource, WireProtocol } from './protocol.ts'

/** One resolved view of the gateway's models. */
export interface CatalogSnapshot {
  /** Models that can be called, by id, with the evidence behind each decision. */
  readonly facts: ReadonlyMap<string, ModelFacts>
  /** Advertised ids this build cannot configure, with the reason. */
  readonly unavailable: ReadonlyMap<string, string>
  /** pi-ai provider holding exactly the callable models. */
  readonly provider: Provider
  /** Whether the gateway listing answered during this build. */
  readonly live: boolean
  /** Retained for explicit discovery when the listing failed. */
  readonly listingFailure?: unknown
  readonly fetchedAtMs: number
}

/** Observers the plugin logs through. */
export interface CatalogObservers {
  /** One source fell back to retained data. */
  readonly onFallback?: (detail: { url: string; error: unknown; kept: number }) => void
  /** Ids that could not be configured, reported once per build. */
  readonly onUnconfigured?: (detail: { readonly id: string; readonly reason: string }[]) => void
}

/**
 * The installed catalog, re-pointed at the configured gateway.
 *
 * These entries are the first rung of the ladder and the outage fallback: their
 * `compat` is what keeps DeepSeek-family reasoning replay correct.
 */
function builtinModels(baseURL: string): Map<string, Model<Api>> {
  return new Map((getBuiltinModels(PROVIDER_ID) as Model<Api>[]).map(model => [model.id, {
    ...model,
    provider: PROVIDER_ID,
    baseUrl: modelBaseURLFor(model.api as string, baseURL),
  }]))
}

function modelBaseURLFor(api: string, baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '')
  return api === 'anthropic-messages' ? base.replace(/\/v1$/, '') : base
}

/** The adapter resolves and passes the credential for every request. */
function harnessApiKeyAuth(): Provider['auth'] {
  return {
    apiKey: {
      name: 'OpenCode Go API key',
      resolve: () => Promise.resolve({ auth: {}, source: 'OpenCode Go API key' }),
    },
  }
}

function buildProvider(baseURL: string, models: readonly Model<Api>[]): Provider {
  return createProvider({
    id: PROVIDER_ID,
    name: DISPLAY_NAME,
    baseUrl: baseURL,
    auth: harnessApiKeyAuth(),
    models: [...models],
    api: {
      'anthropic-messages': anthropicMessagesApi(),
      'openai-completions': openAICompletionsApi(),
      'openai-responses': openAIResponsesApi(),
    },
  })
}

/** Inputs one catalog build needs from configuration. */
export interface CatalogOptions {
  /** Normalized gateway base URL. */
  readonly baseURL: string
  /** Cache lifetime for requests and pickers. */
  readonly refreshMs: number
  /** Route defaults for a model no source sizes. */
  readonly defaults: ModelDefaults
  /** Configured per-id protocol overrides. */
  readonly overrides: Readonly<Record<string, string>>
  readonly observers?: CatalogObservers
}

/**
 * One gateway's catalog. Requests reuse a cached snapshot; explicit discovery
 * and unknown ids revalidate it.
 */
export class OpencodeGoCatalog {
  private readonly options: CatalogOptions
  private served: CatalogSnapshot | undefined
  private pending: Promise<CatalogSnapshot> | undefined
  private metadataDocument: unknown
  private metadataETag: string | undefined
  private lastMetadata: ReturnType<typeof readOnlineMetadata> | undefined

  constructor(options: CatalogOptions) {
    this.options = options
  }

  /** The cached snapshot, refreshed when it is older than the configured TTL. */
  snapshot(force = false): Promise<CatalogSnapshot> {
    if (!force && this.served !== undefined && Date.now() - this.served.fetchedAtMs < this.options.refreshMs) {
      return Promise.resolve(this.served)
    }
    this.pending ??= this.build()
      .then((snapshot) => {
        this.served = snapshot
        return snapshot
      })
      .finally(() => { this.pending = undefined })
    return this.pending
  }

  /**
   * The snapshot that can serve one exact model.
   *
   * A model this build has never seen forces one revalidation even inside the
   * TTL, because "unknown" and "newly added" look identical from here.
   * @param id - the requested model id.
   * @returns the snapshot holding the model.
   * @throws {LlmError} `MODEL_METADATA_UNAVAILABLE` when the gateway advertises
   *   the id but this build cannot configure it, naming the reason.
   */
  async forModel(id: string): Promise<CatalogSnapshot> {
    const cached = this.served
    let snapshot = await this.snapshot()
    if (!snapshot.facts.has(id) && snapshot === cached) snapshot = await this.snapshot(true)
    const reason = snapshot.unavailable.get(id)
    if (reason !== undefined) {
      throw new LlmError(
        `opencode-go model "${id}" is advertised but cannot be configured: ${reason};`
        + ' refresh the model list to retry',
        'MODEL_METADATA_UNAVAILABLE',
      )
    }
    return snapshot
  }

  /** Revalidate both sources, reusing the metadata document when it is unchanged. */
  private async build(): Promise<CatalogSnapshot> {
    const builtin = builtinModels(this.options.baseURL)
    const [listing, metadata] = await Promise.allSettled([
      fetchModelIds(this.options.baseURL),
      this.refreshMetadata(builtin),
    ])
    if (metadata.status === 'rejected') {
      this.options.observers?.onFallback?.({
        url: MODEL_METADATA_URL,
        error: metadata.reason,
        kept: this.lastMetadata?.models.size ?? 0,
      })
    }
    if (listing.status === 'rejected') {
      // Once observed, an outage must not resurrect retired models: the last
      // successful listing stays authoritative until a new one arrives.
      const previous = this.served
      this.options.observers?.onFallback?.({
        url: `${this.options.baseURL.replace(/\/+$/, '')}/models`,
        error: listing.reason,
        kept: previous?.facts.size ?? 0,
      })
      const facts = previous?.facts ?? new Map<string, ModelFacts>()
      return {
        facts,
        unavailable: previous?.unavailable ?? new Map<string, string>(),
        provider: buildProvider(this.options.baseURL, [...facts.values()].map(fact => toPiModel(fact, this.options.baseURL))),
        live: false,
        listingFailure: listing.reason,
        fetchedAtMs: Date.now(),
      }
    }
    // A metadata outage keeps the last successful parse: the previous document
    // is strictly better evidence than the installed catalog alone, because it
    // carries the capacities, modalities, and lifecycle the catalog may not.
    return this.assemble(
      listing.value,
      metadata.status === 'fulfilled' ? metadata.value : this.lastMetadata,
      builtin,
    )
  }

  /** Merge the listing with the metadata document and the installed entries. */
  private assemble(
    ids: readonly string[],
    online: ReturnType<typeof readOnlineMetadata> | undefined,
    builtin: ReadonlyMap<string, Model<Api>>,
  ): CatalogSnapshot {
    const facts = new Map<string, ModelFacts>()
    const unavailable = new Map<string, string>()
    for (const id of ids) {
      const parsed = online?.models.get(id)
      if (parsed !== undefined) {
        facts.set(id, parsed)
        continue
      }
      const reason = online?.errors.get(id)
      if (reason !== undefined) {
        // A malformed record is a data fault: report it rather than inventing
        // capacities, because the model is described and the description is wrong.
        unavailable.set(id, reason)
        continue
      }
      // No source describes this id. The gateway's own provider default
      // (`@ai-sdk/openai-compatible`) makes Chat Completions the best available
      // guess, and the route defaults size it; the settings surface marks it as
      // inferred so a wrong guess is visible and overridable.
      facts.set(id, this.inferredFacts(id, builtin))
    }
    if (unavailable.size > 0) {
      this.options.observers?.onUnconfigured?.(
        [...unavailable].map(([id, reason]) => ({ id, reason })),
      )
    }
    return {
      facts,
      unavailable,
      provider: buildProvider(this.options.baseURL, [...facts.values()].map(fact => toPiModel(fact, this.options.baseURL))),
      live: true,
      fetchedAtMs: Date.now(),
    }
  }

  /** Facts for an id no source describes, from the ladder and the route defaults. */
  private inferredFacts(id: string, builtin: ReadonlyMap<string, Model<Api>>): ModelFacts {
    const exact = builtin.get(id)
    const api = exact?.api as ModelFacts['api'] | undefined ?? inferFamily(id)
    const contextWindow = exact !== undefined ? exact.contextWindow : this.options.defaults.contextWindow
    const maxTokens = exact !== undefined ? exact.maxTokens : this.options.defaults.maxTokens
    return {
      id,
      name: exact?.name ?? id,
      api,
      protocolSource: exact === undefined ? 'inferred' : 'builtin',
      contextWindow,
      maxInputTokens: undefined,
      maxTokens,
      assumedLimits: exact === undefined,
      input: exact?.input ?? this.options.defaults.input,
      inputModalities: undefined,
      reasoning: exact?.reasoning ?? false,
      thinkingLevelMap: exact?.thinkingLevelMap,
      // No source describes these, so the page says nothing instead of
      // guessing: the installed catalog knows wire shapes, not capabilities.
      structuredOutput: undefined,
      temperature: undefined,
      openWeights: undefined,
      compat: exact?.compat ?? ({} as Model<Api>['compat']),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      deprecated: false,
      releaseDate: undefined,
    }
  }

  /** Conditional metadata GET: an unchanged document keeps its parsed form. */
  private async refreshMetadata(builtin: ReadonlyMap<string, Model<Api>>): Promise<ReturnType<typeof readOnlineMetadata>> {
    const response = await fetch(MODEL_METADATA_URL, {
      redirect: 'error',
      headers: {
        ...attributionHeaders(),
        accept: 'application/json',
        'cache-control': 'no-cache',
        ...this.metadataETag === undefined ? {} : { 'if-none-match': this.metadataETag },
      },
      signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS),
    })
    if (response.status === 304 && this.metadataDocument !== undefined) {
      await response.body?.cancel().catch(() => {})
      const parsed = readOnlineMetadata(this.metadataDocument, {
        builtin,
        defaults: this.options.defaults,
        overrides: this.options.overrides,
      })
      this.lastMetadata = parsed
      return parsed
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`models.dev answered ${response.status}`)
    }
    const document = await readBoundedJson(response, MODEL_METADATA_URL, MODEL_METADATA_MAX_BYTES)
    this.metadataDocument = document
    this.metadataETag = response.headers.get('etag') ?? undefined
    const parsed = readOnlineMetadata(document, {
      builtin,
      defaults: this.options.defaults,
      overrides: this.options.overrides,
    })
    this.lastMetadata = parsed
    return parsed
  }
}

/** The family rule, kept beside the ladder so both stay in one vocabulary. */
function inferFamily(id: string): ModelFacts['api'] {
  const lower = id.toLowerCase()
  return ['grok', 'gpt', 'muse'].some(family => lower.startsWith(family))
    ? 'openai-responses'
    : 'openai-completions'
}

/**
 * Interrogate the gateway for explicit discovery, bypassing the TTL.
 * @param catalog - the catalog to revalidate.
 * @returns the advertised models, including the unconfigured ones so the
 *   settings surface can explain what is missing.
 * @throws {LlmError} `DISCOVERY_FAILED` when the listing itself failed.
 */
export async function discoverCatalogModels(catalog: OpencodeGoCatalog): Promise<readonly LlmDiscoveredModel[]> {
  const snapshot = await catalog.snapshot(true)
  if (!snapshot.live) {
    const detail = snapshot.listingFailure instanceof LlmError
      ? snapshot.listingFailure.message
      : 'the live model listing is unreachable'
    throw new LlmError(`dshopencodego: ${detail}; refresh the model list to retry`, 'DISCOVERY_FAILED', {
      cause: snapshot.listingFailure,
    })
  }
  return [
    ...[...snapshot.facts.values()].map(fact => ({
      id: fact.id,
      name: fact.name,
      contextWindow: fact.contextWindow,
      maxTokens: fact.maxTokens,
    })),
    ...[...snapshot.unavailable].map(([id, reason]) => ({ id, name: `${id} (unconfigured: ${reason})` })),
  ]
}
