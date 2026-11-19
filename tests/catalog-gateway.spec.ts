/**
 * The gateway listing reader: ids out, duplicates collapsed, malformed
 * replies rejected — and every endpoint failure named DISCOVERY_FAILED.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { fetchModelIds, fetchModelListing, readGatewayProtocols, readModelIds, readModelListing } from '../src/catalog/gateway.ts'
import { GO_MODELS_FIXTURE } from './fixtures/go-models.ts'
import { startMockGateway } from './mock-gateway.ts'
import type { MockGateway } from './mock-gateway.ts'

const gateways: MockGateway[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
})

describe('readModelIds', () => {
  it('reads ids in endpoint order and collapses duplicates', () => {
    expect(readModelIds({
      object: 'list',
      data: [
        { id: 'b', object: 'model' },
        { id: 'a', object: 'model' },
        { id: 'b', object: 'model' },
        { id: '', object: 'model' },
        { noid: true },
      ],
    })).toEqual(['b', 'a'])
  })

  it('rejects a body with no data array', () => {
    expect(() => readModelIds({ object: 'list' })).toThrow(/no "data" array/)
    expect(() => readModelIds(null)).toThrow(/no "data" array/)
  })
})

describe('readGatewayProtocols', () => {
  it('maps recommended_api through its AI SDK package to a wire protocol', () => {
    const protocols = readGatewayProtocols({
      data: [
        { id: 'chat', recommended_api: 'chat-completions', api: { 'chat-completions': { sdk: { aisdk: '@ai-sdk/openai-compatible' } } } },
        { id: 'resp', recommended_api: 'responses', api: { responses: { sdk: { aisdk: '@ai-sdk/openai' } } } },
        { id: 'msg', recommended_api: 'messages', api: { messages: { sdk: { aisdk: '@ai-sdk/anthropic' } } } },
      ],
    })
    expect([...protocols]).toEqual([
      ['chat', 'openai-completions'],
      ['resp', 'openai-responses'],
      ['msg', 'anthropic-messages'],
    ])
  })

  it('omits protocols this plugin cannot drive, without failing the listing', () => {
    const protocols = readGatewayProtocols({
      data: [
        // generate-content is an image protocol; the model is still listed.
        { id: 'image', recommended_api: 'generate-content', api: { 'generate-content': { sdk: { aisdk: '@ai-sdk/google' } } } },
        { id: 'no-api', recommended_api: 'chat-completions' },
        { id: 'no-detail', recommended_api: 'responses', api: {} },
        { id: 'malformed', recommended_api: 42, api: { chat: { sdk: { aisdk: '@ai-sdk/openai-compatible' } } } },
        { id: 'chat', recommended_api: 'chat-completions', api: { 'chat-completions': { sdk: { aisdk: '@ai-sdk/openai-compatible' } } } },
      ],
    })
    expect([...protocols.keys()]).toEqual(['chat'])
  })

  it('names no protocol for a body with no data array', () => {
    expect(readGatewayProtocols({ object: 'list' }).size).toBe(0)
  })

  it('reads the recorded gateway fixture into 32 ids and 31 protocols', () => {
    const listing = readModelListing(GO_MODELS_FIXTURE)
    expect(listing.ids).toHaveLength(32)
    // Exactly one model declares generate-content, an image protocol this
    // plugin cannot drive — no protocol is claimed for it.
    expect(listing.protocols.size).toBe(31)
  })

  it('reads the protocols of the models shown in the console', () => {
    const { protocols } = readModelListing(GO_MODELS_FIXTURE)
    expect(protocols.get('deepseek-v4.1-flash')).toBe('openai-completions')
    expect(protocols.get('beam-free')).toBe('openai-completions')
    expect(protocols.get('hy4-flash-free')).toBe('openai-completions')
    expect(protocols.get('iceman-contributor-free')).toBe('openai-completions')
    expect(protocols.get('longcat-2.5-free')).toBe('openai-completions')
    expect(protocols.get('muse-spark-1.2-contributor')).toBe('openai-responses')
    expect(protocols.get('muse-spark-1.3-contributor')).toBe('openai-responses')
  })
})

describe('fetchModelIds', () => {
  it('fetches the advertised ids', async () => {
    const server = await startMockGateway({ listing: ['x-1', 'x-2'] })
    gateways.push(server)
    await expect(fetchModelIds(server.baseURL)).resolves.toEqual(['x-1', 'x-2'])
    expect(server.requests.some(request => request.path.endsWith('/models'))).toBe(true)
  })

  it('fetches gateway-declared protocols alongside the ids', async () => {
    const server = await startMockGateway({ listingDetail: [
      { id: 'chat', recommended_api: 'chat-completions', api: { 'chat-completions': { sdk: { aisdk: '@ai-sdk/openai-compatible' } } } },
      { id: 'msg', recommended_api: 'messages', api: { messages: { sdk: { aisdk: '@ai-sdk/anthropic' } } } },
    ] })
    gateways.push(server)
    const listing = await fetchModelListing(server.baseURL)
    expect(listing.ids).toEqual(['chat', 'msg'])
    expect([...listing.protocols]).toEqual([
      ['chat', 'openai-completions'],
      ['msg', 'anthropic-messages'],
    ])
  })

  it('names an endpoint failure DISCOVERY_FAILED', async () => {
    const server = await startMockGateway({ listingStatus: 500 })
    gateways.push(server)
    const error = await fetchModelIds(server.baseURL).catch(error => error)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('DISCOVERY_FAILED')
    expect(String((error as LlmError).message)).toMatch(/HTTP 500/)
  })

  it('names an unreachable endpoint DISCOVERY_FAILED', async () => {
    const error = await fetchModelIds('http://127.0.0.1:1/v1').catch(error => error)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('DISCOVERY_FAILED')
  })
})
