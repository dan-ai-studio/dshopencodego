/**
 * The OpenCode Go adapter: one route, one live catalog, one mandatory header.
 *
 * The gateway has two requirements a generic pi-ai route cannot express — a
 * model list that rotates faster than any shipped catalog, and a per
 * conversation `x-opencode-session` routing header — so this adapter owns both
 * instead of delegating them to configuration.
 *
 * Each operation reads the current configuration and resolves the catalog
 * snapshot once, before its first await, so a settings change reaches the next
 * request and never mixes two catalog generations inside one call.
 *
 * @module @dan-ai-studio/dshopencodego/adapter
 */

import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { getSupportedThinkingLevels, normalizeContext } from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { DISPLAY_NAME, PROVIDER_ID, OpencodeGoCatalog } from './catalog/index.ts'
import { toPiModel } from './catalog/metadata.ts'
import { assertBaseURL } from './config.ts'
import type { OpencodeGoConfig, OpencodeGoModelLimits } from './config.ts'
import { toPiContext, toStreamChunks } from './conversion/index.ts'
import type { PiImageRequestContext } from './conversion/index.ts'
import { isModelEnabled, recommendedIds } from './models.ts'
import { providerHeaders } from './session-header.ts'

/**
 * pi-ai thinking formats that answer an unset effort with an explicit disable.
 * Every other format omits the parameter and lets the provider decide, so only
 * these need a default effort to avoid silently turning thinking off.
 */
const DISABLES_THINKING_WHEN_UNSET: ReadonlySet<string> = new Set(['deepseek', 'zai', 'qwen', 'qwen-chat-template'])

/** Apply one request's configured capacities without touching the catalog. */
function withModelLimit(model: Model<Api>, limits: OpencodeGoModelLimits): Model<Api> {
  const limit = limits[model.id]
  if (limit === null || limit === undefined) return model
  return {
    ...model,
    contextWindow: limit.contextWindow ?? model.contextWindow,
    maxTokens: limit.maxTokens ?? model.maxTokens,
  }
}

/** Image machinery the adapter reads once per request. */
export interface OpencodeGoImageAccess {
  /** Resolve the durable attachment service at request time. */
  readonly resolveAttachments: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current tool execution world. */
  readonly resolveImageAccess: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
}

/** Constructor inputs for {@link OpencodeGoAdapter}. */
export interface OpencodeGoAdapterOptions {
  /** Current configuration, re-read at every operation. */
  readonly config: () => OpencodeGoConfig
  /** Resolve the route credential; a miss must fail loud, never fall back. */
  readonly resolveApiKey: () => Promise<string | undefined>
  /** Image input machinery; absent refuses image content. */
  readonly imageAccess?: OpencodeGoImageAccess
  /** Observe a catalog source falling back to retained data. */
  readonly onFallback?: (detail: { url: string; error: unknown; kept: number }) => void
  /** Observe gateway models this build cannot configure. */
  readonly onUnconfigured?: (detail: { id: string; reason: string }[]) => void
  /** Observe assistant history degrading to provider-neutral conversion. */
  readonly onReplayDegrade?: (reason: string) => void
  /**
   * Observe the provider's own usage for one completed call. This is the only
   * honest source of token counts: the gateway's `/usage` endpoint reports
   * account percentages, not tokens.
   */
  readonly onUsage?: (detail: { model: string; usage: TokenUsage }) => void
}

/** The catalog and the configuration facts it was built from. */
interface CatalogCache {
  readonly key: string
  readonly catalog: OpencodeGoCatalog
}

/**
 * The single `opencode-go` route's adapter.
 *
 * The catalog is cached per endpoint, refresh interval, and protocol-override
 * set: changing any of those builds a new one, while a settings change that
 * touches none of them keeps the cached snapshot for its full TTL.
 */
export class OpencodeGoAdapter extends LlmAdapter {
  private cache: CatalogCache | undefined

  private readonly options: OpencodeGoAdapterOptions

  constructor(options: OpencodeGoAdapterOptions) {
    super()
    this.options = options
  }

  /** The catalog for one configuration, rebuilt when its owned facts change. */
  catalogOf(config: OpencodeGoConfig): OpencodeGoCatalog {
    const key = `${config.baseURL}|${String(config.refreshMinutes)}|${JSON.stringify(config.modelProtocols)}`
    if (this.cache?.key !== key) {
      this.cache = {
        key,
        catalog: new OpencodeGoCatalog({
          baseURL: assertBaseURL(config.baseURL),
          refreshMs: config.refreshMinutes * 60_000,
          defaults: {
            contextWindow: 262_144,
            maxTokens: 32_768,
            input: ['text'],
          },
          overrides: config.modelProtocols,
          observers: {
            ...this.options.onFallback === undefined ? {} : { onFallback: this.options.onFallback },
            ...this.options.onUnconfigured === undefined ? {} : { onUnconfigured: this.options.onUnconfigured },
          },
        }),
      }
    }
    return this.cache.catalog
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: DISPLAY_NAME }
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const config = this.options.config()
    const snapshot = await this.catalogOf(config).snapshot()
    // DSH resolves every listed model before showing the provider, so an
    // unconfigurable id belongs in the settings diagnostics, not this list.
    const facts = [...snapshot.facts.values()]
    // The same default the settings page marks: without explicit switches the
    // top few by published monthly estimate stay enabled.
    const recommended = recommendedIds(facts)
    return facts
      .map(fact => ({ ...fact, recommended: recommended.has(fact.id) }))
      .filter(fact => isModelEnabled(fact, config.modelVisibility))
      .map(fact => ({
        provider: PROVIDER_ID,
        id: fact.id,
        name: fact.name,
        inputModalities: [...fact.input],
      }))
  }

  override async resolveModel(_provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const config = this.options.config()
    const snapshot = await this.catalogOf(config).forModel(model)
    const facts = snapshot.facts.get(model)
    if (facts === undefined) throw new LlmError(`opencode-go has no model "${model}"`, 'UNKNOWN_MODEL')
    return this.modelInfo(withModelLimit(toPiModel(facts, config.baseURL), config.modelLimits))
  }

  /** Describe one model: capacities plus the reasoning levels it really offers. */
  private modelInfo(model: Model<Api>): LlmResolvedModelInfo {
    const reasoning: Pick<LlmResolvedModelInfo, 'reasoning'> = {}
    const levels = model.reasoning ? getSupportedThinkingLevels(model) : []
    if (levels.length > 0) {
      // A format that disables thinking when no effort is named would silently
      // strip reasoning from a model that offers levels, so it gets a default.
      const format = (model.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat
      const fallback = format !== undefined && DISABLES_THINKING_WHEN_UNSET.has(format)
        ? levels.includes('high') ? 'high' : levels.findLast(level => level !== 'off')
        : undefined
      reasoning.reasoning = {
        efforts: levels.map(level => ({
          id: ReasoningEffortId(level),
          name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
        })),
        ...fallback === undefined ? {} : { defaultEffort: ReasoningEffortId(fallback) },
      }
    }
    return {
      provider: PROVIDER_ID,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
      context: { contextWindow: model.contextWindow },
      ...reasoning,
    }
  }

  /** Validate an explicit effort against the model's own levels, without clamping. */
  private resolveReasoningLevel(model: Model<Api>, effort: GenerateOptions['reasoningEffort']): ModelThinkingLevel | undefined {
    if (effort === undefined) return undefined
    const supported = getSupportedThinkingLevels(model)
    if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
    throw new LlmError(
      `opencode-go model "${model.id}" does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('dshopencodego does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    const config = this.options.config()
    const snapshot = await this.catalogOf(config).forModel(options.model)
    const facts = snapshot.facts.get(options.model)
    if (facts === undefined) throw new LlmError(`opencode-go has no model "${options.model}"`, 'UNKNOWN_MODEL')
    const model = withModelLimit(toPiModel(facts, config.baseURL), config.modelLimits)
    const outputLimit = config.modelLimits[model.id]?.maxTokens
    const maxTokens = outputLimit === null || outputLimit === undefined
      ? options.maxTokens
      : Math.min(options.maxTokens ?? outputLimit, outputLimit)
    const apiKey = await this.options.resolveApiKey()
    if (apiKey === undefined || apiKey.length === 0) {
      throw new LlmError('dshopencodego: no credential resolved for the opencode-go route', 'MISSING_CREDENTIAL')
    }
    const reasoning = this.resolveReasoningLevel(model, options.reasoningEffort)

    const consumer = new AbortController()
    const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, config.streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`opencode-go model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      let imageRequest: PiImageRequestContext | undefined
      if (containsImage) {
        const access = this.options.imageAccess
        const store = access?.resolveAttachments()
        if (access === undefined || store === undefined) {
          throw new LlmError('dshopencodego image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
        }
        imageRequest = {
          attachments: store,
          resolveImageAccess: ref => access.resolveImageAccess(store, ref),
          maxRequestImageBytes: config.maxRequestImageBytes,
          requestImagePolicy: { maxPixels: config.requestImagePixelBudget, maxBytes: config.requestImageMaxBytes },
        }
      }
      const context = imageRequest === undefined
        ? await toPiContext(options, undefined, this.options.onReplayDegrade)
        : await toPiContext({ ...options, signal: watchdog.signal }, imageRequest, this.options.onReplayDegrade)
      const events = snapshot.provider.streamSimple(model, normalizeContext(context), {
        apiKey,
        ...reasoning === undefined || reasoning === 'off' ? {} : { reasoning },
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...maxTokens === undefined ? {} : { maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        // The gateway refuses a request without `x-opencode-session`; the
        // attribution user-agent rides along on the same object.
        headers: providerHeaders(options.sessionId === undefined ? undefined : String(options.sessionId)),
        // The agent recovery layer owns visible attempts; one adapter call is
        // one SDK attempt.
        maxRetries: 0,
      })
      const iterator = toStreamChunks(events, model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
            throw new LlmError('opencode-go stream idle timeout', 'TIMEOUT')
          }
          if (result.done) {
            exhausted = true
            return
          }
          if (result.value.type === 'usage') {
            this.options.onUsage?.({ model: options.model, usage: result.value.usage })
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('opencode-go stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError('opencode-go stream idle timeout', 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('opencode-go request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('opencode-go stream consumer stopped')
    }
  }
}

/** Re-exported so a composition can assert the attribution contract in one place. */
export { attributionHeaders }
