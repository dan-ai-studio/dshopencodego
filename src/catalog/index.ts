/**
 * The live catalog: which models exist, and how to call each one.
 *
 * Membership comes from the gateway listing, capability from models.dev, and
 * exact protocol/wire quirks from the installed pi-ai catalog, merged through
 * the ladder in `./protocol.ts`. Per-model allowances, and a protocol for the
 * models nothing else covers, come from the provider's own documentation (see
 * `./go-doc.ts`). The snapshot is cached for the configured refresh interval,
 * and an unknown model id forces one revalidation even inside that interval —
 * that is what makes a model the gateway added this morning callable this
 * afternoon without a plugin release.
 *
 * Failures degrade rather than empty: a listing outage keeps the last known
 * models and marks the snapshot not-live, a metadata outage keeps the last
 * document, a documentation outage keeps the last parsed allowances (or leaves
 * the page on its frozen seed), and a single unparseable model is reported by
 * id while every other model keeps serving.
 *
 * @module @dan-ai-studio/dshopencodego/catalog
 */

// Subpath imports on purpose. The package root re-exports `./api/lazy.js` (every
// provider's wire implementation) and `providers/all.js` loads every provider's
// model data — 991 KB under `providers/data` alone. This plugin mounts three
// APIs for one provider, so each symbol is taken from the narrowest public entry
// that exports it. Types still come from the root: they vanish at build time.
import { createProvider } from '@earendil-works/pi-ai/models'
import type { Api, Model, Provider } from '@earendil-works/pi-ai'
import { OPENCODE_GO_MODELS } from '@earendil-works/pi-ai/providers/opencode-go.models'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import {
  DISPLAY_NAME,
  MODEL_METADATA_MAX_BYTES,
  MODEL_METADATA_TIMEOUT_MS,
  MODEL_METADATA_URL,
  PROVIDER_ID,
  METADATA_RETRY_DELAY_MS,
  BACKGROUND_RETRY_BACKOFF_MS,
  UNKNOWN_MODEL_PROBE_COOLDOWN_MS,
} from './constants.ts'
import { fetchModelIds } from './gateway.ts'
import { fetchGoDocument, GO_DOC_URLS } from './go-doc.ts'
import type { GoDoc } from './go-doc.ts'
import { readBoundedJson } from './json-response.ts'
import { readOnlineMetadata, toPiModel } from './metadata.ts'
import type { ModelDefaults, ModelFacts } from './metadata.ts'
import { readFactsCache, writeFactsCache } from './metadata-cache.ts'
import { readSnapshotCache, writeSnapshotCache } from './snapshot-cache.ts'
import { asWireProtocol } from './protocol.ts'
import type { GoQuota } from '../go-limits.ts'

export { PROVIDER_ID, DISPLAY_NAME, DEFAULT_BASE_URL, CONSOLE_BASE_URL } from './constants.ts'
export { readModelIds, fetchModelIds } from './gateway.ts'
export { readOnlineMetadata, toPiModel, modelBaseURL } from './metadata.ts'
export type { ModelFacts, OnlineMetadata, ModelDefaults } from './metadata.ts'
export { decideProtocol, inferProtocol, protocolOfNpm } from './protocol.ts'
export type { ProtocolDecision, ProtocolSource, WireProtocol } from './protocol.ts'

/**
 * One source the catalog could not read.
 *
 * A degradation is not a failure: the snapshot still answers, from the
 * installed catalog and the frozen seed. But it is not the same answer, and
 * the difference is invisible unless it is said out loud — a model whose
 * protocol was inferred reads exactly like one whose protocol the provider
 * documented, and a thinking level that the online metadata would have
 * supplied is simply absent.
 */
export interface CatalogDegradation {
  /** Which source could not be read. */
  readonly source: 'metadata' | 'document'
  /** Why it failed, in the source's own words. */
  readonly reason: string
}

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
  /**
   * Allowances parsed from the provider's own documentation, once a fetch has
   * succeeded in this process. Absent until then, and across restarts; the page
   * falls back to the frozen seed in `go-limits.ts`.
   */
  readonly documentQuotas?: ReadonlyMap<string, GoQuota>
  /** Retained for explicit discovery when the listing failed. */
  readonly listingFailure?: unknown
  /**
   * Sources this build could not read.
   *
   * Empty when every source answered. Otherwise the reading is degraded: the
   * protocol of a model no installed entry describes falls back to a guess,
   * and the thinking levels the online metadata carries are missing. The page
   * shows this, because a degraded reading that looks whole is the one state
   * a user cannot act on.
   */
  readonly degradations?: readonly CatalogDegradation[]
  /**
   * True when this snapshot was read from disk and is being brought up to
   * date in the background.
   *
   * It is the difference between "here is the last known catalog" and "here
   * is the catalog, and it is current". A page that shows the first must
   * also say that a refresh is under way.
   */
  readonly cached?: boolean
  /**
   * When the facts in this snapshot were written, when they came from disk
   * rather than from a live read.
   *
   * The listing is always live; the metadata behind it may be older. The page
   * says so, because a capacity that was true last week reads exactly like
   * one that is true now.
   */
  readonly factsCachedAt?: number
  readonly fetchedAtMs: number
}

/** Observers the plugin logs through. */
interface CatalogObservers {
  /** One source fell back to retained data. */
  readonly onFallback?: (detail: { url: string; error: unknown; kept: number }) => void
  /** Ids that could not be configured, reported once per build. */
  readonly onUnconfigured?: (detail: { readonly id: string; readonly reason: string }[]) => void
}

/**
 * A failure reason in one line, for a page that has to say it.
 *
 * The degradation reaches a person, so it carries the source's own words
 * rather than a generic apology: which URL answered what, or which fetch
 * timed out, is the difference between "retry" and "this path is wrong".
 * @param reason - whatever the source rejected with.
 * @returns the message, or the value's own spelling.
 */
function reasonText(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  return typeof reason === 'string' ? reason : String(reason)
}

/**
 * The installed catalog, re-pointed at the configured gateway.
 *
 * These entries are the first rung of the ladder and the outage fallback: their
 * `compat` is what keeps DeepSeek-family reasoning replay correct.
 */
function builtinModels(baseURL: string): Map<string, Model<Api>> {
  // `OPENCODE_GO_MODELS` is the same table `getBuiltinModels('opencode-go')`
  // reads — verified entry for entry — reached without loading the aggregate
  // `models.generated.js` that carries every provider.
  return new Map((Object.values(OPENCODE_GO_MODELS) as Model<Api>[]).map(model => [model.id, {
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

/**
 * The installed catalog's protocol, when this plugin cannot serve it.
 *
 * `Model<Api>['api']` is pi-ai's wider union; this plugin mounts exactly the
 * three in `WIRE_PROTOCOLS`. The check exists because the catalog is wider
 * than the plugin and grows on its own release cadence.
 * @param api - the raw `api` string the installed catalog states.
 * @returns the unusable protocol, or undefined when there is nothing to refuse.
 */
function unsupportedBuiltinApi(api: string | undefined): string | undefined {
  return api === undefined || asWireProtocol(api) !== undefined ? undefined : api
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
  /**
   * Read the provider documentation. Defaults to the real fetch; tests inject a
   * fixed document so the suite stays offline. The signal is the caller's
   * cancellation, forwarded to every documentation request.
   */
  readonly readDocument?: (signal?: AbortSignal) => Promise<GoDoc>
  /**
   * Where the discovered document paths are remembered.
   *
   * Absent means the plugin cannot write a cache, and the paths are then only
   * known to the running process. That costs one discovery per start, and
   * nothing else.
   */
  readonly cacheDir?: string
  /**
   * The fetch the gateway listing is read through.
   *
   * A factory rather than a function: the pin follows the configuration, and
   * the configuration is live. A catalogue built before a pin was set must
   * read the next listing from the pinned address without being rebuilt.
   */
  readonly fetch?: () => typeof fetch
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
  /**
   * The facts a previous successful read produced, read from disk.
   *
   * This is what a cold process falls back on when the online metadata cannot
   * be read. Without it a degraded catalog declares every model unable to
   * think, and the host refuses the effort the session is already using.
   */
  private cachedMetadata: ReturnType<typeof readOnlineMetadata> | undefined
  /** When the cached facts were written, for the page to show. */
  private readonly cachedAt: number | undefined
  /** The last parsed documentation; retained across failed fetches. */
  private document: GoDoc | undefined
  /** Ids that already forced a revalidation, with the time they did. */
  private readonly probedAt = new Map<string, number>()
  /** The background refresh, kept so a caller can wait for it to be over. */
  private backgroundRefresh: Promise<unknown> | undefined
  /** When the last background refresh was started, for the back-off. */
  private lastRefreshAttemptAt = 0

  constructor(options: CatalogOptions) {
    this.options = options
    const cached = readFactsCache(options.cacheDir)
    if (cached !== undefined) {
      this.cachedMetadata = { models: cached.facts, errors: new Map() }
      this.cachedAt = cached.updatedAt
      // The ETag is what lets the next read be a question rather than a
      // download: the document is megabytes, and a `304` costs a round trip
      // and no body. A new process that asks is answered in milliseconds; a
      // new process that cannot ask pays for the whole document again, which
      // is the wait a new session begins with.
      this.metadataETag = cached.etag
    }
  }

  /**
   * The cached snapshot, refreshed when it is older than the configured TTL.
   *
   * A snapshot that is past its TTL is still served — and refreshed behind
   * it. A caller that asks for a model must not wait for the network to
   * learn what it already knew, so the answer is the one in hand and the
   * refresh goes on without anyone watching it. A caller that forces a
   * refresh — the settings page's button — waits for it, because asking to
   * refresh and not waiting for the result is asking for nothing.
   *
   * A process that has never built a catalog reads the one it wrote down
   * last time and refreshes that in the background. The first message of a
   * session therefore names its model at once, instead of after a wait that
   * belongs to the network rather than to the session.
   * @param force - revalidate every source, ignoring the cache, and wait.
   * @param signal - caller cancellation, forwarded to the documentation read,
   *   the slowest source and the only one a caller can cancel; a build already
   *   in flight keeps the signal of the caller that started it, because one
   *   shared snapshot cannot carry two different cancellations.
   */
  snapshot(force = false, signal?: AbortSignal): Promise<CatalogSnapshot> {
    if (!force && this.served !== undefined && Date.now() - this.served.fetchedAtMs < this.options.refreshMs) {
      return Promise.resolve(this.served)
    }
    if (!force) {
      // What this process knows is served, and what it does not know is
      // learned in the background.
      if (this.served === undefined) {
        const remembered = this.readRememberedSnapshot()
        if (remembered !== undefined) {
          this.served = remembered
          this.refreshInBackground()
          return Promise.resolve(remembered)
        }
      } else {
        // The snapshot in hand has outlived its TTL, but it is still the best
        // answer available right now, and the caller should not wait to be
        // told what was already known.
        this.refreshInBackground()
        return Promise.resolve(this.served)
      }
    }
    this.pending ??= this.build(signal)
      .then((snapshot) => {
        this.served = snapshot
        return snapshot
      })
      .finally(() => { this.pending = undefined })
    return this.pending
  }

  /**
   * Refresh the catalog behind the snapshot in hand.
   *
   * The build is not awaited and its failure is not reported here: the
   * snapshot in hand stays, and whoever asked for the refresh will see the
   * next one.
   */
  private refreshInBackground(): void {
    if (this.pending !== undefined) return
    // A refresh that just failed is not tried again at once.
    //
    // The snapshot in hand keeps its age, so every call sees it as past its
    // TTL and starts a refresh — and a refresh that fails leaves the age
    // where it was. Without this, a service that is down turns every model
    // request into a full download attempt.
    if (Date.now() - this.lastRefreshAttemptAt < BACKGROUND_RETRY_BACKOFF_MS) return
    this.lastRefreshAttemptAt = Date.now()
    const refresh = this.build(undefined, false)
      .then((snapshot) => {
        this.served = snapshot
        return snapshot
      })
      .finally(() => { this.pending = undefined })
    this.pending = refresh
    // Kept apart from `pending`, which the next build clears: this is the
    // promise a caller can wait on to know the background work is over.
    this.backgroundRefresh = refresh
    void refresh.catch(() => undefined)
  }

  /**
   * Wait for the background refresh, if one is running.
   *
   * The refresh belongs to no caller, so nothing else can wait for it. A
   * host that is shutting down — or a test that must not have a request
   * outlive it — needs to know when the quiet is over.
   * @returns a promise that settles when the background refresh has.
   */
  settled(): Promise<void> {
    const refresh = this.backgroundRefresh
    return refresh === undefined
      ? Promise.resolve()
      : refresh.then(() => undefined, () => undefined)
  }

  /**
   * The catalog a previous build produced, read from disk.
   *
   * It is presented as what it is: a listing from the past, being brought up
   * to date in the background. The facts it carries are the ones the last
   * build produced, so the protocols and the thinking levels are the ones
   * that were true then.
   * @returns the remembered catalog, or undefined when there is none.
   */
  private readRememberedSnapshot(): CatalogSnapshot | undefined {
    const remembered = readSnapshotCache(this.options.cacheDir)
    if (remembered === undefined) return undefined
    const facts = new Map(remembered.facts)
    return {
      facts,
      unavailable: new Map(),
      provider: buildProvider(this.options.baseURL, [...facts.values()].map(fact => toPiModel(fact, this.options.baseURL))),
      // The listing is from the past, and the page says so.
      live: false,
      // And a refresh of it is already under way.
      cached: true,
      fetchedAtMs: remembered.updatedAt,
      ...remembered.quotas.size === 0 ? {} : { documentQuotas: remembered.quotas },
    }
  }

  /**
   * The snapshot that can serve one exact model.
   *
   * A model this build has never seen forces one revalidation even inside the
   * TTL, because "unknown" and "newly added" look identical from here.
   * @param id - the requested model id.
   * @param signal - caller cancellation, forwarded to a forced revalidation.
   * @returns the snapshot holding the model.
   * @throws {LlmError} `MODEL_METADATA_UNAVAILABLE` when the gateway advertises
   *   the id but this build cannot configure it, naming the reason.
   */
  async forModel(id: string, signal?: AbortSignal): Promise<CatalogSnapshot> {
    let snapshot = await this.snapshot()
    // A snapshot that cannot serve this id forces one revalidation, because
    // "this build has not seen the id" and "the id was just published" are
    // indistinguishable from here.
    //
    // The condition must not compare the snapshot with what was cached before
    // the await: on a cold catalog there is nothing cached, so that comparison
    // was false and the revalidation was skipped — an id missing from the
    // very first build then failed as UNKNOWN_MODEL instead of being retried.
    // Presence in `unavailable` is a positive statement (the gateway
    // advertises the id but this build cannot configure it), so it needs no
    // revalidation and is reported below.
    if (!snapshot.facts.has(id) && !snapshot.unavailable.has(id) && this.mayProbe(id)) {
      this.probedAt.set(id, Date.now())
      snapshot = await this.snapshot(true, signal)
    }
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

  /**
   * Whether this id may revalidate the catalog again.
   *
   * The revalidation is what makes a newly published model usable without a
   * restart, so it cannot simply be dropped. It is also the most expensive
   * thing this route does — the metadata document is megabytes — and the host
   * resolves a model on every list and on every new session. An id that never
   * resolves would therefore pay that cost forever, which is how a plugin
   * makes a host slow down over time rather than start slow.
   * @param id - the model id that was not found.
   * @returns true when the id may force a revalidation now.
   */
  private mayProbe(id: string): boolean {
    const last = this.probedAt.get(id)
    return last === undefined || Date.now() - last >= UNKNOWN_MODEL_PROBE_COOLDOWN_MS
  }

  /**
   * Revalidate every source, reusing the metadata document when it is unchanged.
   * @param signal - caller cancellation, forwarded to the documentation read.
   * @param retry - whether a failed metadata read is tried again. A caller
   *   that is waiting for the answer wants it tried again; a refresh nobody
   *   is waiting for does not, because the answer it wants is the one it
   *   already has.
   */
  private async build(signal?: AbortSignal, retry = true): Promise<CatalogSnapshot> {
    const builtin = builtinModels(this.options.baseURL)
    const readDocument = this.options.readDocument
      ?? ((signal?: AbortSignal) => fetchGoDocument(signal, { cacheDir: this.options.cacheDir }))
    const [listing, metadata, documentation] = await Promise.allSettled([
      fetchModelIds(this.options.baseURL, undefined, this.options.fetch?.()),
      this.refreshMetadata(builtin, retry),
      readDocument(signal),
    ])
    const degradations: CatalogDegradation[] = []
    if (metadata.status === 'rejected') {
      degradations.push({ source: 'metadata', reason: reasonText(metadata.reason) })
      this.options.observers?.onFallback?.({
        url: MODEL_METADATA_URL,
        error: metadata.reason,
        kept: this.lastMetadata?.models.size ?? 0,
      })
    }
    if (documentation.status === 'fulfilled') {
      this.document = documentation.value
    } else {
      // Not a page-stale event: the allowances keep their previous source, and
      // the page says so wherever the frozen seed is in use.
      degradations.push({ source: 'document', reason: reasonText(documentation.reason) })
      this.options.observers?.onFallback?.({
        url: GO_DOC_URLS[0] ?? 'the Go documentation',
        error: documentation.reason,
        kept: this.document?.quotas.size ?? 0,
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
        ...degradations.length === 0 ? {} : { degradations },
        fetchedAtMs: Date.now(),
        ...this.documentQuotas(),
      }
    }
    // A metadata outage keeps the last successful parse: the previous document
    // is strictly better evidence than the installed catalog alone, because it
    // carries the capacities, modalities, and lifecycle the catalog may not.
    //
    // When this process has never had a successful read, the facts written
    // down by the last one are the next best evidence. They are stale, and the
    // page says so, but they are what keeps a thinking model from being
    // declared unable to think — which the host then refuses the session's
    // effort over, failing a run that had nothing wrong with it.
    const fromCache = metadata.status !== 'fulfilled' && this.lastMetadata === undefined
    const online = metadata.status === 'fulfilled'
      ? metadata.value
      : (this.lastMetadata ?? this.cachedMetadata)
    const snapshot = this.assemble(
      listing.value,
      online,
      builtin,
      degradations,
      fromCache ? this.cachedAt : undefined,
    )
    // Remember the catalog as it stands, so the next process can serve it
    // without asking the network anything.
    writeSnapshotCache(
      this.options.cacheDir,
      snapshot.facts,
      this.document?.quotas ?? new Map(),
      this.document?.protocols ?? new Map(),
    )
    return snapshot
  }

  /** Merge the listing with the metadata document and the installed entries. */
  private assemble(
    ids: readonly string[],
    online: ReturnType<typeof readOnlineMetadata> | undefined,
    builtin: ReadonlyMap<string, Model<Api>>,
    degradations: readonly CatalogDegradation[] = [],
    factsCachedAt?: number,
  ): CatalogSnapshot {
    const facts = new Map<string, ModelFacts>()
    const unavailable = new Map<string, string>()
    for (const id of ids) {
      const parsed = online?.models.get(id)
      if (parsed !== undefined) {
        // The provider's own endpoint table outranks models.dev's SDK hint, so
        // a model the document names is not left carrying the online answer.
        // `withDocumentedProtocol` never touches a builtin entry, so the wire
        // quirks the adapter relies on stay intact.
        facts.set(id, this.withDocumentedProtocol(parsed))
        continue
      }
      const reason = online?.errors.get(id)
      if (reason !== undefined) {
        // A malformed record is a data fault: report it rather than inventing
        // capacities, because the model is described and the description is wrong.
        unavailable.set(id, reason)
        continue
      }
      // The installed catalog may name a protocol this plugin cannot mount.
      // pi-ai 1.3.0 labels `gemini-4-argon-contributor` as
      // `google-generative-ai`, which `buildProvider` has no entry for, and
      // the string used to reach the model list through an unchecked cast.
      // Listing it as usable would defer the failure to the first stream —
      // the one outcome this plugin refuses to ship — so it is refused here,
      // exactly like a malformed record.
      const unsupported = unsupportedBuiltinApi(builtin.get(id)?.api)
      if (unsupported !== undefined) {
        unavailable.set(id, `its wire protocol "${unsupported}" is not implemented by this plugin`)
        continue
      }
      // No source describes this id. The gateway's own provider default
      // (`@ai-sdk/openai-compatible`) makes Chat Completions the best available
      // guess, and the route defaults size it; the settings surface marks it as
      // inferred so a wrong guess is visible and overridable.
      facts.set(id, this.withDocumentedProtocol(this.inferredFacts(id, builtin)))
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
      ...degradations.length === 0 ? {} : { degradations },
      ...factsCachedAt === undefined ? {} : { factsCachedAt },
      fetchedAtMs: Date.now(),
      ...this.documentQuotas(),
    }
  }

  /**
   * The document allowances as a snapshot field, absent until one fetch lands.
   *
   * A document that carries no allowance table leaves the field absent rather
   * than empty, so the frozen seed in `go-limits.ts` answers instead. An empty
   * map would look like "the provider states no allowance for any model", and
   * that is a different claim from "this build has no live allowances".
   */
  private documentQuotas(): { documentQuotas?: ReadonlyMap<string, GoQuota> } {
    if (this.document === undefined || this.document.quotas.size === 0) return {}
    return { documentQuotas: this.document.quotas }
  }

  /**
   * Prefer the documented protocol over anything below the installed catalog.
   *
   * The endpoint table is the provider's own statement, so it outranks both the
   * family guess and models.dev's SDK hint — this turns an `inferred` badge into
   * a known answer for ids the installed catalog misses. It never overrides a
   * builtin entry or a configured override: those carry the wire quirks the
   * adapter relies on.
   */
  private withDocumentedProtocol(facts: ModelFacts): ModelFacts {
    if (facts.protocolSource !== 'inferred' && facts.protocolSource !== 'online') return facts
    const documented = this.document?.protocols.get(facts.id)
    return documented === undefined ? facts : { ...facts, api: documented, protocolSource: 'document' }
  }

  /** Facts for an id no source describes, from the ladder and the route defaults. */
  private inferredFacts(id: string, builtin: ReadonlyMap<string, Model<Api>>): ModelFacts {
    const exact = builtin.get(id)
    // Guarded for the same reason `assemble` refuses these ids up front: the
    // installed catalog states protocols this plugin cannot mount.
    const builtinApi = asWireProtocol(exact?.api)
    const api = builtinApi ?? inferFamily(id)
    const contextWindow = exact !== undefined ? exact.contextWindow : this.options.defaults.contextWindow
    const maxTokens = exact !== undefined ? exact.maxTokens : this.options.defaults.maxTokens
    return {
      id,
      name: exact?.name ?? id,
      api,
      protocolSource: builtinApi === undefined ? 'inferred' : 'builtin',
      contextWindow,
      maxInputTokens: undefined,
      maxTokens,
      assumedLimits: exact === undefined,
      input: exact?.input ?? this.options.defaults.input,
      inputModalities: undefined,
      reasoning: exact?.reasoning ?? false,
      thinkingLevelMap: exact?.thinkingLevelMap,
      compat: exact?.compat ?? ({} as Model<Api>['compat']),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      deprecated: false,
      releaseDate: undefined,
    }
  }

  /**
   * Read the model metadata document, once.
   *
   * The document is megabytes, so its budget is longer than the other two
   * reads' — and the host that runs this is not always a plain Node process:
   * the desktop build fetches over the browser's network stack, where the
   * same document that a shell reads in half a second can take long enough
   * to outrun a budget set for kilobyte-sized documents.
   * @param builtin - the installed catalog, for the parse.
   * @param conditional - whether to ask whether the document changed. A
   *   conditional request the registry answers with `304` costs a round
   *   trip and no body, which is the difference between a new session that
   *   starts immediately and one that waits for megabytes.
   * @returns the parsed metadata.
   */
  private async readMetadataDocument(
    builtin: ReadonlyMap<string, Model<Api>>,
    conditional = true,
  ): Promise<ReturnType<typeof readOnlineMetadata>> {
    const response = await fetch(MODEL_METADATA_URL, {
      redirect: 'error',
      headers: {
        ...attributionHeaders(),
        accept: 'application/json',
        'cache-control': 'no-cache',
        ...conditional && this.metadataETag !== undefined ? { 'if-none-match': this.metadataETag } : {},
      },
      signal: AbortSignal.timeout(MODEL_METADATA_TIMEOUT_MS),
    })
    if (response.status === 304) {
      await response.body?.cancel().catch(() => {})
      // The document is unchanged. This process may already hold it...
      if (this.metadataDocument !== undefined) {
        const parsed = readOnlineMetadata(this.metadataDocument, {
          builtin,
          defaults: this.options.defaults,
          overrides: this.options.overrides,
        })
        this.lastMetadata = parsed
        return parsed
      }
      // ...or it may be a new process that only has what was written down.
      // The written facts are what the document said, so they answer the
      // question the same way the document would.
      if (this.cachedMetadata !== undefined) {
        this.lastMetadata = this.cachedMetadata
        return this.cachedMetadata
      }
      // Neither: the ETag outlived the facts it belongs to. Ask again
      // without the condition, so the registry sends the document.
      return this.readMetadataDocument(builtin, false)
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
    // Remember what this read said, so a later process that cannot read the
    // document still knows which models think and at which levels — and can
    // ask the registry whether it changed, instead of downloading it again.
    writeFactsCache(this.options.cacheDir, parsed.models, this.metadataETag)
    return parsed
  }

  /**
   * Read the model metadata document, retrying once.
   *
   * The failure this answers is not a broken network: the same document is
   * reachable from a browser on the same machine while the host cannot read
   * it. It is the host being busy — a plugin reload rewrites modules, unpacks
   * packages, and rebuilds the runtime while the catalog asks for the
   * document, and the request that loses that race is a timeout, not a
   * refusal. A second attempt, a moment later, is the same request on a host
   * that has finished what it was doing.
   * @param builtin - the installed catalog, for the parse.
   * @returns the parsed metadata.
   */
  private async refreshMetadata(
    builtin: ReadonlyMap<string, Model<Api>>,
    retry: boolean,
  ): Promise<ReturnType<typeof readOnlineMetadata>> {
    try {
      return await this.readMetadataDocument(builtin)
    } catch (first: unknown) {
      if (!retry) throw first
      await new Promise<void>(resolve => { setTimeout(resolve, METADATA_RETRY_DELAY_MS) })
      try {
        return await this.readMetadataDocument(builtin)
      } catch (second: unknown) {
        // The first reason is the one that happened first, and it is usually
        // the more specific one; the second is appended because it may differ.
        throw new Error(`${reasonText(first)}; retry: ${reasonText(second)}`)
      }
    }
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
 * @param signal - the discovery request's cancellation. The harness states
 *   implementations "must honor the supplied signal", so it reaches the
 *   documentation fetch and a cancelled interrogation stops waiting on it.
 * @returns the advertised models, including the unconfigured ones so the
 *   settings surface can explain what is missing.
 * @throws {LlmError} `DISCOVERY_FAILED` when the listing itself failed.
 */
export async function discoverCatalogModels(
  catalog: OpencodeGoCatalog,
  signal?: AbortSignal,
): Promise<readonly LlmDiscoveredModel[]> {
  // Not a forced refresh. A page that lists the models is a page that shows
  // a snapshot, and the snapshot this process already has is the one to
  // show: a refresh goes on behind it, and the next visit sees the new one.
  // Waiting for the whole catalog here would make opening the model page
  // cost a network round trip that the page does not need to be useful.
  const snapshot = await catalog.snapshot(false, signal)
  // A listing that could not be read is a different matter: there is no
  // snapshot to show, and saying "unreachable" is the only honest answer.
  if (snapshot.listingFailure !== undefined) {
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
