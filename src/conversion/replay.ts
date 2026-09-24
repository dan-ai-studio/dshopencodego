/**
 * Durable pi-ai replay metadata and assistant-history reconstruction.
 *
 * Harness content is the durable source of truth for text and tool calls; this
 * module stores only the provider-native metadata needed to rebuild a pi-ai
 * assistant message on a later request (signatures, response ids, native
 * thinking level). When that metadata is unusable — another adapter wrote it, a
 * future version wrote it, or it no longer matches the content — the message
 * degrades to provider-neutral history instead of failing the request.
 *
 * @module @dan-ai-studio/dshopencodego/conversion/replay
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Message, ModelMessageSource, ReplayEnvelope } from '@deepseek-ai/dsh-llm'
import type { Api, AssistantMessage, JsonObject, Usage as PiUsage } from '@earendil-works/pi-ai'

/** Per-block half of the replay envelope, one entry per content block. */
export type PiAiReplayBlock =
  | { type: 'text'; textSignature?: string }
  | { type: 'reasoning'; thinkingSignature?: string; redacted?: boolean }
  | { type: 'tool-call'; thoughtSignature?: string }

/** Versioned response-level half of the replay envelope. */
export interface PiAiReplayResponse {
  kind: 'pi-ai'
  version: 2
  api: Api
  provider: string
  /** Requested model identity, matching the durable assistant source. */
  model: string
  /** Provider-reported model, when it differs from the request. */
  responseModel?: string
  responseId?: string
  /** Provider-native effort, replayed as-is; absence stays absent. */
  providerThinkingLevel?: string
  stopReason: AssistantMessage['stopReason']
}

interface PiAiReplayState {
  response: PiAiReplayResponse
  blocks: PiAiReplayBlock[]
}

/** Tool arguments arrive as raw JSON strings; a malformed one becomes `{}`. */
function parseArguments(raw: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as JsonObject
    }
  } catch {
    // Malformed arguments are the model's fault, not a reason to fail replay.
  }
  return {}
}

/** Historical pi-ai messages require a usage value; none of it is replayed. */
function emptyPiUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/**
 * Project a successful pi-ai response into the minimal durable replay state.
 * @param message - the completed native response.
 * @param requestedModel - request identity stored on the assistant source.
 * @returns the versioned lossless-JSON envelope; `blocks` is index-aligned with
 *   the streamed blocks, so assembly prunes an entry with its block.
 */
export function toPiReplayState(message: AssistantMessage, requestedModel = message.model): ReplayEnvelope {
  const responseModel = message.api === 'anthropic-messages' && message.model !== requestedModel
    ? message.model
    : message.responseModel
  const response: PiAiReplayResponse = {
    kind: 'pi-ai',
    version: 2,
    api: message.api,
    provider: message.provider,
    model: requestedModel,
    ...responseModel === undefined ? {} : { responseModel },
    ...message.responseId === undefined ? {} : { responseId: message.responseId },
    ...message.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: message.providerThinkingLevel },
    stopReason: message.stopReason,
  }
  return {
    response,
    blocks: message.content.map((block): PiAiReplayBlock => {
      switch (block.type) {
        case 'text': return {
          type: 'text',
          ...block.textSignature === undefined ? {} : { textSignature: block.textSignature },
        }
        case 'thinking': return {
          type: 'reasoning',
          ...block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature },
          ...block.redacted === undefined ? {} : { redacted: block.redacted },
        }
        case 'toolCall': return {
          type: 'tool-call',
          ...block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature },
        }
      }
    }),
  }
}

function invalidReplay(message: string): never {
  throw new LlmError(`invalid pi-ai replay state: ${message}`, 'INVALID_REPLAY_STATE')
}

/** Validate a durable envelope before any of it reaches pi-ai. */
function readReplayState(value: unknown): PiAiReplayState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidReplay('expected a replay envelope')
  const envelope = value as Record<string, unknown>
  const rawResponse = envelope['response']
  if (typeof rawResponse !== 'object' || rawResponse === null || Array.isArray(rawResponse)) {
    return invalidReplay('expected a response object')
  }
  const response = rawResponse as Record<string, unknown>
  if (response['kind'] !== 'pi-ai') return invalidReplay('unknown state kind')
  if (response['version'] !== 2) return invalidReplay(`unsupported version ${String(response['version'])}`)
  for (const key of ['api', 'provider', 'model'] as const) {
    if (typeof response[key] !== 'string' || response[key].length === 0) return invalidReplay(`${key} must be a non-empty string`)
  }
  if (!['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(response['stopReason']))) {
    return invalidReplay('unknown stopReason')
  }
  for (const key of ['responseModel', 'responseId', 'providerThinkingLevel'] as const) {
    if (response[key] !== undefined && typeof response[key] !== 'string') return invalidReplay(`${key} must be a string`)
  }
  const blocks = envelope['blocks']
  if (!Array.isArray(blocks)) return invalidReplay('blocks must be an array')
  for (const [index, value] of blocks.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidReplay(`block ${index} must be an object`)
    const block = value as Record<string, unknown>
    if (!['text', 'reasoning', 'tool-call'].includes(String(block['type']))) {
      return invalidReplay(`block ${index} has an unknown type`)
    }
    for (const signature of ['textSignature', 'thinkingSignature', 'thoughtSignature'] as const) {
      if (block[signature] !== undefined && typeof block[signature] !== 'string') {
        return invalidReplay(`block ${index} ${signature} must be a string`)
      }
    }
    if (block['redacted'] !== undefined && typeof block['redacted'] !== 'boolean') {
      return invalidReplay(`block ${index} redacted must be boolean`)
    }
  }
  return { response: response as unknown as PiAiReplayResponse, blocks: blocks as PiAiReplayBlock[] }
}

/** Convert provider-neutral blocks without claiming same-model fidelity. */
function foreignAssistant(message: Message): AssistantMessage {
  const source = message.source.kind === 'model' ? message.source : undefined
  const content: AssistantMessage['content'] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text': content.push({ type: 'text', text: block.text }); break
      case 'reasoning': content.push({ type: 'thinking', thinking: block.text }); break
      case 'tool-call': content.push({
        type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments),
      }); break
      case 'image':
        throw new LlmError('pi-ai chat history cannot represent structured assistant image output', 'UNSUPPORTED_CONTENT')
      default:
        // Plugin-added block types have no pi-ai representation.
        break
    }
  }
  return {
    role: 'assistant',
    content,
    // Deliberately never equals a catalog API: absent replay state is foreign
    // even when the source names this same provider and model.
    api: 'dsh-foreign',
    provider: source?.provider ?? 'dsh-foreign',
    model: source?.model ?? 'dsh-foreign',
    usage: emptyPiUsage(),
    stopReason: content.some(piece => piece.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

/** Recombine durable content with validated replay metadata. */
function replayedAssistant(message: Message, source: ModelMessageSource, rawState: unknown): AssistantMessage {
  const state = readReplayState(rawState)
  if (state.response.provider !== source.provider) return invalidReplay('provider does not match assistant source')
  if (state.response.model !== source.model) return invalidReplay('model does not match assistant source')
  if (state.blocks.length !== message.content.length) return invalidReplay('block count does not match assistant content')
  const content: AssistantMessage['content'] = message.content.map((block, index) => {
    const replay = state.blocks[index]
    if (replay === undefined || replay.type !== block.type) return invalidReplay(`block ${index} does not match assistant content`)
    switch (block.type) {
      case 'text': return {
        type: 'text',
        text: block.text,
        ...replay.type === 'text' && replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {},
      }
      case 'reasoning': return {
        type: 'thinking',
        thinking: block.text,
        ...replay.type === 'reasoning' && replay.thinkingSignature !== undefined
          ? { thinkingSignature: replay.thinkingSignature } : {},
        ...replay.type === 'reasoning' && replay.redacted !== undefined ? { redacted: replay.redacted } : {},
      }
      case 'tool-call': return {
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
        ...replay.type === 'tool-call' && replay.thoughtSignature !== undefined
          ? { thoughtSignature: replay.thoughtSignature } : {},
      }
      default: return invalidReplay(`block ${index} has an unsupported Harness type`)
    }
  })
  return {
    role: 'assistant',
    content,
    api: state.response.api,
    provider: state.response.provider,
    // Anthropic reports aliases and fallbacks as `model`, unlike Completions'
    // informational `responseModel`.
    model: state.response.api === 'anthropic-messages'
      ? state.response.responseModel ?? state.response.model
      : state.response.model,
    ...state.response.responseModel === undefined ? {} : { responseModel: state.response.responseModel },
    ...state.response.responseId === undefined ? {} : { responseId: state.response.responseId },
    ...state.response.providerThinkingLevel === undefined
      ? {} : { providerThinkingLevel: state.response.providerThinkingLevel },
    usage: emptyPiUsage(),
    stopReason: state.response.stopReason,
    timestamp: 0,
  }
}

/**
 * Convert one durable assistant message into pi-ai history.
 * @param message - assistant content with its model source and optional replay metadata.
 * @param onDegrade - called with the reason when unusable metadata falls back.
 * @returns the native assistant message, or a provider-neutral reconstruction.
 */
export function toPiAssistant(message: Message, onDegrade?: (reason: string) => void): AssistantMessage {
  const source = message.source
  if (source.kind !== 'model' || source.replayState === undefined) return foreignAssistant(message)
  try {
    return replayedAssistant(message, source, source.replayState)
  } catch (error: unknown) {
    if (!(error instanceof LlmError) || error.code !== 'INVALID_REPLAY_STATE') throw error
    onDegrade?.(error.message)
    return foreignAssistant(message)
  }
}
