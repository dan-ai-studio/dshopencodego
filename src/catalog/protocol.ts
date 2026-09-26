/**
 * Wire-protocol vocabulary and the inference ladder.
 *
 * The gateway is a multi-protocol front door: the same base URL answers
 * `chat/completions`, `responses`, and `messages`, and each model speaks
 * exactly one of them. Four evidence levels decide which, first hit wins:
 *
 * 1. the installed pi-ai catalog entry for that exact id (protocol *and* the
 *    wire quirks in its `compat`);
 * 2. models.dev's per-model `provider.npm`, which names the AI SDK package the
 *    OpenCode Go console itself uses;
 * 3. a family rule, for ids neither source describes;
 * 4. an explicit configuration override, which always wins.
 *
 * Measured 2026-09-24: of the 12 gateway ids pi-ai 0.87.1 does not know, 10 are
 * fully described by models.dev and 2 (`deepseek-flash`, `hy3-preview`) are
 * absent from it — the family rule exists for those two and for any future id
 * that lands the same way, not to rescue a large set.
 *
 * @module @dan-ai-studio/dshopencodego/catalog/protocol
 */

import type { Api } from '@earendil-works/pi-ai'

/** The three wire protocols the OpenCode Go gateway serves. */
export type WireProtocol = 'anthropic-messages' | 'openai-completions' | 'openai-responses'

/** Every protocol this plugin can drive, in catalog order. */
export const WIRE_PROTOCOLS: readonly WireProtocol[] = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
]

/**
 * Which evidence level produced a protocol decision, most authoritative first:
 * a configured `override`, the installed catalog (`builtin`), the provider's own
 * endpoint table (`document`), models.dev's SDK hint (`online`), and last the
 * family rule (`inferred`).
 */
export type ProtocolSource = 'builtin' | 'document' | 'online' | 'inferred' | 'override'

/** One model's protocol decision with the evidence that produced it. */
export interface ProtocolDecision {
  readonly api: WireProtocol
  readonly source: ProtocolSource
}

/** The AI SDK package names models.dev uses to name a model's protocol. */
const NPM_PROTOCOLS: Readonly<Record<string, WireProtocol>> = {
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/openai': 'openai-responses',
  '@ai-sdk/openai-compatible': 'openai-completions',
}

/**
 * Families whose models are served over the OpenAI Responses API.
 *
 * Only families where every known member agrees are listed. Qwen and MiniMax
 * are deliberately absent: the installed catalog serves `qwen3.8-flash` and
 * `minimax-m3` over Anthropic Messages while serving `qwen3.6-plus`,
 * `qwen3.7-*`, `qwen3.8-max`, and `minimax-m2.7` over Chat Completions, so a
 * family rule would be wrong about half of them.
 */
const RESPONSES_FAMILIES: readonly string[] = ['grok', 'gpt', 'muse']

/** The protocol a models.dev `npm` field names, when it names one. */
export function protocolOfNpm(npm: unknown): WireProtocol | undefined {
  return typeof npm === 'string' ? NPM_PROTOCOLS[npm] : undefined
}

/**
 * The family rule for one id: the Responses families by prefix, everything else
 * over Chat Completions, which is what the gateway's provider-level default
 * (`@ai-sdk/openai-compatible`) implies for an id no per-model record covers.
 * @param id - the gateway model id.
 * @returns the inferred protocol; the caller records it as `inferred`.
 */
export function inferProtocol(id: string): WireProtocol {
  const lower = id.toLowerCase()
  return RESPONSES_FAMILIES.some(family => lower.startsWith(family))
    ? 'openai-responses'
    : 'openai-completions'
}

/** Narrow an arbitrary configured string to a protocol this plugin can drive. */
export function asWireProtocol(value: string | undefined): WireProtocol | undefined {
  return value !== undefined && (WIRE_PROTOCOLS as readonly string[]).includes(value)
    ? value as WireProtocol
    : undefined
}

/** One model's evidence, as gathered from the three automatic sources. */
export interface ProtocolEvidence {
  /** Protocol the installed pi-ai catalog declares for this exact id. */
  readonly builtin?: WireProtocol
  /** Protocol models.dev names for this model, or its provider-level default. */
  readonly online?: WireProtocol
  /** The configured override for this id, if any. */
  readonly override?: WireProtocol
}

/**
 * Walk the ladder for one model.
 * @param id - the gateway model id, used only by the family rule.
 * @param evidence - what the automatic sources and configuration say.
 * @returns the decision, or `undefined` when the override names a protocol this
 *   build cannot drive (the caller reports that as a configuration error rather
 *   than silently falling back to a guess).
 */
export function decideProtocol(id: string, evidence: ProtocolEvidence): ProtocolDecision | undefined {
  if (evidence.override !== undefined) return { api: evidence.override, source: 'override' }
  if (evidence.builtin !== undefined) return { api: evidence.builtin, source: 'builtin' }
  if (evidence.online !== undefined) return { api: evidence.online, source: 'online' }
  return { api: inferProtocol(id), source: 'inferred' }
}

/** The pi-ai API string for one wire protocol. */
export function piApiOf(api: WireProtocol): Api {
  return api
}
