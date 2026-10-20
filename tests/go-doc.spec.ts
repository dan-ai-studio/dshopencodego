/**
 * The provider documentation parser: tables join by display name into gateway
 * ids, tiered rows agree or drop, and a source without a usable table counts as
 * a failure rather than an empty document.
 */
import { describe, expect, it, vi } from 'vitest'
import { fetchGoDocument, GO_DOC_URLS, parseGoDocument } from '../src/catalog/go-doc.ts'

const DOCUMENT = [
  '## Usage limits',
  '',
  '| Model | Input | Output | Cached Read | Cached Write | Monthly limit |',
  '| --- | --- | --- | --- | --- | --- |',
  '| GLM-5.3-Flash | $0.15 | $0.50 | $0.03 | - | **$60** |',
  '| Qwen3.7 Plus (≤ 256K tokens) | $0.40 | $1.60 | $0.04 | $0.50 | **$60** |',
  '| Qwen3.7 Plus (> 256K tokens) | $1.20 | $4.80 | $0.12 | $1.50 | **$60** |',
  '| Conflicted (Peak) | $1.00 | $2.00 | - | - | **$30** |',
  '| Conflicted (Off-Peak) | $2.00 | $4.00 | - | - | **$60** |',
  '| Space Bunny Free | Free | Free | Free | - | **Unlimited** Limited time |',
  '| Not In Endpoints | $1.00 | $1.00 | - | - | **$10** |',
  '| Broken Allowance | $1.00 | $1.00 | - | - | n/a |',
  '',
  '### Estimated requests',
  '',
  '| Model | requests per 5 hour | requests per week | requests per month |',
  '| --- | --- | --- | --- |',
  '| GLM-5.3-Flash | 6,320 | 15,790 | 31,580 |',
  '| Space Bunny Free | Unlimited | Unlimited | Unlimited |',
  '',
  '## Endpoints',
  '',
  '| Model | Model ID | Endpoint | AI SDK Package |',
  '| --- | --- | --- | --- |',
  '| GLM-5.3-Flash | glm-5.3-flash | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |',
  '| Qwen3.7 Plus | qwen3.7-plus | `https://opencode.ai/zen/go/v1/messages` | `@ai-sdk/anthropic` |',
  '| Grok 4.7 | grok-4.7 | `https://opencode.ai/zen/go/v1/responses` | `@ai-sdk/openai` |',
  '| Space Bunny Free | space-bunny-free | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |',
  '| Conflicted | conflicted | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |',
  '| Broken Allowance | broken-allowance | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |',
  '| Weird One | weird-one | `https://opencode.ai/zen/go/v1/unknown` | `@ai-sdk/openai-compatible` |',
  '',
  '## Goals',
  '',
  'Done.',
].join('\n')

describe('parseGoDocument', () => {
  const doc = parseGoDocument(DOCUMENT)

  it('joins the allowance tables to gateway ids through the endpoint table', () => {
    expect(doc.quotas.get('glm-5.3-flash')).toEqual({ monthlyUsd: 60, monthlyRequests: 31_580 })
    // Tiered rows repeat one allowance; the id gets the value, not the band.
    expect(doc.quotas.get('qwen3.7-plus')).toEqual({ monthlyUsd: 60 })
    expect(doc.quotas.get('space-bunny-free')).toEqual({ monthlyUsd: 'unlimited', monthlyRequests: 'unlimited' })
  })

  it('drops a tiered model whose rows disagree, and skips unusable rows', () => {
    expect(doc.quotas.has('conflicted')).toBe(false)
    // No endpoint row names its id, and one row carries no usable number.
    expect(doc.quotas.has('not-in-endpoints')).toBe(false)
    expect(doc.quotas.has('broken-allowance')).toBe(false)
  })

  it('maps every documented endpoint to its protocol, and ignores unknown paths', () => {
    expect(doc.protocols.get('glm-5.3-flash')).toBe('openai-completions')
    expect(doc.protocols.get('qwen3.7-plus')).toBe('anthropic-messages')
    expect(doc.protocols.get('grok-4.7')).toBe('openai-responses')
    expect(doc.protocols.has('weird-one')).toBe(false)
  })

  it('returns empty sets for a document with no tables at all', () => {
    const empty = parseGoDocument('# Nothing here\n\nJust prose.\n')
    expect(empty.quotas.size).toBe(0)
    expect(empty.protocols.size).toBe(0)
  })

  it('reads an allowance table the provider nested inside a component', () => {
    // The provider puts the allowance table in a component's slot, and every
    // line of it arrives indented. A parser that requires the row to start
    // at the first column skips that table whole, and the page then shows a
    // hand-transcribed snapshot where the provider's own numbers would be.
    const nested = [
      '## Usage limits',
      '',
      '<PlanTabs id="go-pricing" label="Go plan" syncKey="go-plan">',
      '  <div slot="go">',
      '',
      '    | Model | Input | Output | Cached Read | Cached Write | Monthly limit |',
      '    | --------------------------------------- | ------ | ------ | ----------- | ------------ | --- |',
      '    | GLM-5.3-Flash | $0.15 | $0.50 | $0.03 | - | **$60** |',
      '    | Space Bunny Free | Free | Free | Free | - | **Unlimited** |',
      '',
      '  </div>',
      '</PlanTabs>',
      '',
      '## Endpoints',
      '',
      '| Model | Model ID | Endpoint | AI SDK Package |',
      '| --- | --- | --- | --- |',
      '| GLM-5.3-Flash | glm-5.3-flash | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |',
      '| Space Bunny Free | space-bunny-free | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |',
    ].join('\n')
    const doc = parseGoDocument(nested)
    expect(doc.quotas.get('glm-5.3-flash')).toEqual({ monthlyUsd: 60 })
    expect(doc.quotas.get('space-bunny-free')).toEqual({ monthlyUsd: 'unlimited' })
    // The endpoint table is not indented, and it still reads.
    expect(doc.protocols.get('glm-5.3-flash')).toBe('openai-completions')
  })
})

describe('fetchGoDocument', () => {
  it('falls through to the next source when one fails', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValueOnce(new Response(DOCUMENT, { status: 200 }))
    const doc = await fetchGoDocument()
    expect(doc.quotas.size).toBeGreaterThan(0)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('treats a source without a table as a failure and keeps trying', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('# Moved elsewhere\n', { status: 200 }))
      .mockResolvedValueOnce(new Response('also gone', { status: 404 }))
    // The discovery is injected so this case stays offline: the point is what
    // happens when the known paths are exhausted, not what the provider's
    // repository says today.
    await expect(fetchGoDocument(undefined, { discover: async () => [] }))
      .rejects.toMatchObject({ code: 'DOCUMENT_UNAVAILABLE' })
    expect(spy).toHaveBeenCalledTimes(GO_DOC_URLS.length)
  })

  it('accepts a document that carries only the endpoint table', async () => {
    // The provider restructured its page: the endpoint table — the provider's
    // own statement of each model's protocol — survived, the allowance table
    // did not. One missing table must not discard the other, or the protocol
    // evidence disappears and every model falls back to a guess.
    const endpointOnly = [
      '## Endpoints',
      '',
      '| Model | Model ID | Endpoint | AI SDK Package |',
      '| --- | --- | --- | --- |',
      '| GLM-5.3-Flash | glm-5.3-flash | `https://opencode.ai/inference/go/openai/v1/chat/completions` | `@ai-sdk/openai-compatible` |',
    ].join('\n')
    // Every source is asked concurrently, so both answers are stubbed.
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(endpointOnly, { status: 200 }))
    const doc = await fetchGoDocument()
    expect(doc.protocols.get('glm-5.3-flash')).toBe('openai-completions')
    expect(doc.quotas.size).toBe(0)
    expect(spy).toHaveBeenCalledTimes(GO_DOC_URLS.length)
  })
})
