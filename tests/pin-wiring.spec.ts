/**
 * Where the pin reaches: the three requests that go to the gateway.
 *
 * The pin is a claim about the socket, so it is only worth anything where a
 * request is actually made. The listing, the inference call and the usage
 * reading are the three; the metadata registry and the provider's
 * documentation are not, and neither is anything the Harness itself asks
 * for.
 *
 * Every assertion here is made against a real request a real transport sent
 * to a real local server.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OpencodeGoAdapter } from '../src/adapter.ts'
import { OpencodeGoUsageService } from '../src/usage/service.ts'
import { UsageMeter } from '../src/usage/meter.ts'
import type { OpencodeGoConfig } from '../src/config.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { offlineDocument, startMockGateway, stubModelsDev, modelsDevDocument } from './mock-gateway.ts'
import type { MockGateway } from './mock-gateway.ts'

const gateways: MockGateway[] = []

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
})

const DOCUMENT = modelsDevDocument({
  'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 128_000, output: 8_192 } },
})

/** A configuration for one endpoint. */
function configFor(baseURL: string): OpencodeGoConfig {
  return {
    enabled: true,
    modelVisibility: {},
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    baseURL,
    refreshMinutes: 60,
    streamIdleTimeoutMs: 30_000,
    maxRequestImageBytes: 6_000_000,
    requestImagePixelBudget: 1_440_000,
    requestImageMaxBytes: 400_000,
    modelLimits: {},
    modelProtocols: {},
    pinnedAddresses: {},
  }
}

/** A fetch that counts the requests it carried. */
function countingFetch(calls: { count: number }): typeof fetch {
  return (input, init) => {
    calls.count += 1
    return globalThis.fetch(input, init)
  }
}

async function gateway(options?: Parameters<typeof startMockGateway>[0]): Promise<MockGateway> {
  const started = await startMockGateway(options)
  gateways.push(started)
  return started
}

function options(model: string): GenerateOptions {
  return {
    provider: 'opencode-go',
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) { /* the request is the point, not the answer */ }
}

describe('the pin reaches every gateway request', () => {
  it('sends the model listing through it', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(DOCUMENT)
    const calls = { count: 0 }
    const adapter = new OpencodeGoAdapter({
      config: () => configFor(server.baseURL),
      resolveApiKey: async () => 'test-key',
      readDocument: offlineDocument(),
      fetch: () => countingFetch(calls),
    })
    try {
      await adapter.listModels('opencode-go')
      expect(calls.count).toBeGreaterThan(0)
      expect(server.requests.some(entry => entry.path.endsWith('/models'))).toBe(true)
    } finally {
      stub.restore()
    }
  })

  it('sends the inference request through it', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(DOCUMENT)
    const calls = { count: 0 }
    const adapter = new OpencodeGoAdapter({
      config: () => configFor(server.baseURL),
      resolveApiKey: async () => 'test-key',
      readDocument: offlineDocument(),
      fetch: () => countingFetch(calls),
    })
    try {
      await collect(adapter.stream(options('glm-5.3')))
      expect(calls.count).toBeGreaterThan(0)
      expect(server.requests.some(entry => entry.path.endsWith('/chat/completions'))).toBe(true)
    } finally {
      stub.restore()
    }
  })

  it('sends the usage reading through it', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(DOCUMENT)
    const calls = { count: 0 }
    const service = new OpencodeGoUsageService({ reflect: { provide: () => {} } } as never, {
      baseURL: () => server.baseURL,
      resolveApiKey: async () => 'test-key',
      meter: new UsageMeter(),
      fetch: () => countingFetch(calls),
    })
    try {
      await service.readWindows()
      expect(calls.count).toBeGreaterThan(0)
      expect(server.requests.some(entry => entry.path.endsWith('/usage'))).toBe(true)
    } finally {
      stub.restore()
    }
  })

  it('reads the catalog through the same fetch, so one pin covers both', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(DOCUMENT)
    const calls = { count: 0 }
    const adapter = new OpencodeGoAdapter({
      config: () => configFor(server.baseURL),
      resolveApiKey: async () => 'test-key',
      readDocument: offlineDocument(),
      fetch: () => countingFetch(calls),
    })
    try {
      // The listing and the inference call are two different transports, and
      // one pin has to cover both.
      await adapter.listModels('opencode-go')
      await collect(adapter.stream(options('glm-5.3')))
      expect(calls.count).toBeGreaterThanOrEqual(2)
    } finally {
      stub.restore()
    }
  })
})
