/**
 * The protocol ladder as pure decisions: family inference, the npm mapping,
 * the four-level precedence, and the configured-string narrowing.
 */
import { describe, expect, it } from 'vitest'
import {
  asWireProtocol,
  decideProtocol,
  inferProtocol,
  piApiOf,
  protocolOfNpm,
  WIRE_PROTOCOLS,
} from '../src/catalog/protocol.ts'

describe('inferProtocol', () => {
  it('routes the Responses families by prefix, case-insensitively', () => {
    expect(inferProtocol('grok-4.7')).toBe('openai-responses')
    expect(inferProtocol('GPT-6-Luna')).toBe('openai-responses')
    expect(inferProtocol('muse-spark-1.3-contributor')).toBe('openai-responses')
  })

  it('defaults everything else to Chat Completions', () => {
    expect(inferProtocol('deepseek-v4-flash')).toBe('openai-completions')
    // Qwen and MiniMax are deliberately absent: members of those families
    // disagree, so no prefix rule may claim them.
    expect(inferProtocol('qwen3.8-flash')).toBe('openai-completions')
    expect(inferProtocol('minimax-m3')).toBe('openai-completions')
    expect(inferProtocol('brand-new-model')).toBe('openai-completions')
  })
})

describe('protocolOfNpm', () => {
  it('names the protocol each AI SDK package implies', () => {
    expect(protocolOfNpm('@ai-sdk/anthropic')).toBe('anthropic-messages')
    expect(protocolOfNpm('@ai-sdk/openai')).toBe('openai-responses')
    expect(protocolOfNpm('@ai-sdk/openai-compatible')).toBe('openai-completions')
  })

  it('answers undefined for anything else', () => {
    expect(protocolOfNpm(undefined)).toBeUndefined()
    expect(protocolOfNpm('@ai-sdk/google')).toBeUndefined()
    expect(protocolOfNpm(42)).toBeUndefined()
  })
})

describe('decideProtocol', () => {
  it('walks override, builtin, online, then inference', () => {
    expect(decideProtocol('x', { override: 'anthropic-messages' }))
      .toEqual({ api: 'anthropic-messages', source: 'override' })
    expect(decideProtocol('x', { builtin: 'openai-completions', online: 'anthropic-messages' }))
      .toEqual({ api: 'openai-completions', source: 'builtin' })
    expect(decideProtocol('x', { online: 'anthropic-messages' }))
      .toEqual({ api: 'anthropic-messages', source: 'online' })
    expect(decideProtocol('grok-9', {})).toEqual({ api: 'openai-responses', source: 'inferred' })
    expect(decideProtocol('new-thing', {})).toEqual({ api: 'openai-completions', source: 'inferred' })
  })
})

describe('asWireProtocol', () => {
  it('narrows configured strings to drivable protocols', () => {
    expect(asWireProtocol('openai-responses')).toBe('openai-responses')
    expect(asWireProtocol('anthropic-messages')).toBe('anthropic-messages')
    expect(asWireProtocol('openai-completions')).toBe('openai-completions')
    expect(asWireProtocol('google-generative-ai')).toBeUndefined()
    expect(asWireProtocol(undefined)).toBeUndefined()
  })

  it('covers exactly the three gateway protocols', () => {
    expect([...WIRE_PROTOCOLS].toSorted()).toEqual(
      ['anthropic-messages', 'openai-completions', 'openai-responses'])
    for (const protocol of WIRE_PROTOCOLS) expect(piApiOf(protocol)).toBe(protocol)
  })
})
