/**
 * pi-ai assistant events translated into the Harness streaming protocol.
 *
 * pi-ai hands back parsed tool-call arguments while the Harness keeps their raw
 * JSON representation, and it reports failures as terminal stream events rather
 * than throws. Both are normalized here, together with usage and stop reasons.
 *
 * @module @dan-ai-studio/dshopencodego/conversion/stream
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { isContextOverflow } from '@earendil-works/pi-ai'
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'
import { toPiReplayState } from './replay.ts'

/**
 * Map pi-ai usage (reasoning already folded into output).
 * @param usage - the terminal event's cumulative usage.
 * @returns Harness counts; cache fields appear only when non-zero, because
 *   pi-ai reports zeros rather than absence.
 */
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

/**
 * The account-quota failure class, written out rather than imported:
 * `dsh-llm` exports it as `ACCOUNT_QUOTA_EXCEEDED_CODE` from `0.1.7-rc.2`, and
 * the spelling is the stable protocol value the host routes on, so spelling it
 * here keeps the route correct on every host this plugin supports.
 */
const ACCOUNT_QUOTA_CODE = 'ACCOUNT_QUOTA'

/**
 * Classify a provider error string into a Harness error code.
 *
 * pi-ai flattens a caught transport error to its `message` before this point,
 * so the actionable detail is only available as text. The patterns are ordered
 * from most specific to least, and anything unrecognized stays `PI_AI_ERROR`
 * rather than being guessed into a retryable class.
 *
 * Exhausted quota is reported as `ACCOUNT_QUOTA` rather than the generic
 * `QUOTA`: this gateway meters a prepaid balance (the usage window the plugin
 * shows is the same meter), so the remedy is topping up, not retrying — the
 * same upgrade `llm-deepseek-account` applies to its own prepaid route.
 */
export function classifyPiAiError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return ACCOUNT_QUOTA_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  if (/\b413\b|payload too large|request body too large|length limit exceeded/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'PI_AI_ERROR'
}

/**
 * Map a terminal pi-ai message to the Harness finish reason.
 * @param message - the assistant message carried by `done` or `error`.
 * @param contextWindow - catalog capacity, for usage-based overflow detection.
 * @returns the finish reason; a recognized overflow, a zero-content `stop`, and
 *   the non-terminal `pending`/`deferred` states all become errors.
 */
export function mapStopReason(message: AssistantMessage, contextWindow?: number): FinishReason {
  const overflow = isContextOverflow(message, contextWindow)
    || (message.stopReason === 'error'
      && message.errorMessage !== undefined
      && isContextWindowExceededError(message.errorMessage))
  if (overflow) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }
  switch (message.stopReason) {
    case 'stop':
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'pending': return {
      kind: 'error',
      failure: { message: `pi-ai stream for model "${message.model}" ended pending`, code: 'PI_AI_ERROR' },
    }
    case 'deferred': return {
      kind: 'error',
      failure: { message: `pi-ai deferred response for model "${message.model}" is not supported`, code: 'PI_AI_ERROR' },
    }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' },
    }
    case 'error': {
      const text = message.errorMessage ?? 'pi-ai stream error'
      return { kind: 'error', failure: { message: text, code: classifyPiAiError(text) } }
    }
  }
}

/**
 * Translate one assistant turn's pi-ai events into Harness chunks.
 * @param events - the pi-ai event stream for this turn.
 * @param contextWindow - catalog capacity, for usage-based overflow detection.
 * @param callerSignal - caller cancellation; an aborted caller turns an in-band
 *   terminal error into an aborted finish.
 * @param requestedModel - request identity recorded in the replay envelope.
 * @returns chunks ending in `usage` then `finish`.
 * @throws {LlmError} `STREAM_CLOSED` when the source ends with no terminal event.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
  callerSignal?: AbortSignal,
  requestedModel?: string,
): AsyncGenerator<StreamChunk> {
  const toolCalls = new Map<number, { id: string; name: string }>()
  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        // The id and name live on the partial message at this index.
        const partial = event.partial.content[event.contentIndex]
        toolCalls.set(event.contentIndex, {
          id: partial?.type === 'toolCall' ? partial.id : '',
          name: partial?.type === 'toolCall' ? partial.name : '',
        })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolCalls.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: brandString<ToolCallId>(known?.id ?? ''),
          ...known !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: brandString<ToolCallId>(event.toolCall.id),
            name: event.toolCall.name,
            // pi-ai parses the arguments; the Harness vocabulary keeps the raw
            // JSON string it stores and replays.
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(event.message, contextWindow),
          replayState: toPiReplayState(event.message, requestedModel),
        }
        return
      case 'error':
        // pi-ai delivers failures in-band; the Harness protocol's other
        // sanctioned error path is an error/aborted finish chunk.
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(
            callerSignal?.aborted ? { ...event.error, stopReason: 'aborted' } : event.error,
            contextWindow,
          ),
        }
        return
    }
  }
  throw new LlmError('pi-ai event stream ended without a terminal event', 'STREAM_CLOSED')
}
