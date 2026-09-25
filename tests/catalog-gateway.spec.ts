/**
 * The gateway listing reader: ids out, duplicates collapsed, malformed
 * replies rejected — and every endpoint failure named DISCOVERY_FAILED.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { fetchModelIds, readModelIds } from '../src/catalog/gateway.ts'
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

describe('fetchModelIds', () => {
  it('fetches the advertised ids', async () => {
    const server = await startMockGateway({ listing: ['x-1', 'x-2'] })
    gateways.push(server)
    await expect(fetchModelIds(server.baseURL)).resolves.toEqual(['x-1', 'x-2'])
    expect(server.requests.some(request => request.path.endsWith('/models'))).toBe(true)
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
