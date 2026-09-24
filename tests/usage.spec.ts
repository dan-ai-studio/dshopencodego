/**
 * Usage contract: account windows from the gateway, spend from the process.
 *
 * The distinction matters and is asserted here: `/usage` answers "how much
 * quota is left", the meter answers "what has this process actually spent", and
 * neither is presented as the other.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { UsageMeter } from '../src/usage/meter.ts'
import { parseGoUsage, readUsageWindows } from '../src/usage/windows.ts'
import { parseGoMeter, parseUsageWindows } from '../src/usage/contract.ts'
import { usageFailure } from '../src/usage/service.ts'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { OpencodeGoAdapter } from '../src/adapter.ts'
import type { OpencodeGoConfig } from '../src/config.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { startMockGateway, stubModelsDev, modelsDevDocument } from './mock-gateway.ts'
import type { MockGateway } from './mock-gateway.ts'

const gateways: MockGateway[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
})

async function gateway(options?: Parameters<typeof startMockGateway>[0]): Promise<MockGateway> {
  const started = await startMockGateway(options)
  gateways.push(started)
  return started
}

const GOOD = {
  usage: {
    rolling: { status: 'ok', percent: 12.5, resetsAt: '2026-09-24T20:00:00.000Z' },
    weekly: { status: 'ok', percent: 44, resetsAt: '2026-09-28T00:00:00.000Z' },
    monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-10-01T00:00:00.000Z' },
  },
}

describe('usage window parsing', () => {
  it('accepts the three windows the gateway reports', () => {
    expect(parseGoUsage(GOOD.usage)).toEqual({
      rolling: { status: 'ok', percent: 12.5, resetsAt: '2026-09-24T20:00:00.000Z' },
      weekly: { status: 'ok', percent: 44, resetsAt: '2026-09-28T00:00:00.000Z' },
      monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-10-01T00:00:00.000Z' },
    })
  })

  it('refuses to turn an unavailable reading into a zero percentage', () => {
    expect(() => parseGoUsage(undefined)).toThrow(/invalid usage response/)
    expect(() => parseGoUsage({ ...GOOD.usage, weekly: undefined })).toThrow(/weekly/)
    expect(() => parseGoUsage({ ...GOOD.usage, rolling: { status: 'weird', percent: 1, resetsAt: '2026-01-01T00:00:00Z' } })).toThrow(/rolling/)
    expect(() => parseGoUsage({ ...GOOD.usage, monthly: { status: 'ok', percent: 'lots', resetsAt: '2026-01-01T00:00:00Z' } })).toThrow(/monthly/)
    expect(() => parseGoUsage({ ...GOOD.usage, rolling: { status: 'ok', percent: 1, resetsAt: 'not-a-date' } })).toThrow(/rolling/)
  })
})

describe('usage endpoint', () => {
  it('reads the windows with the credential and tags the reading', async () => {
    const server = await gateway({ apiKey: 'test-key', usage: GOOD })
    const reading = await readUsageWindows({ baseURL: server.baseURL, apiKey: 'test-key', source: 'src-1' })
    expect(reading).toMatchObject({ source: 'src-1', monthly: { status: 'rate-limited', percent: 100 } })
    const request = server.requests.find(entry => entry.path.endsWith('/usage'))
    expect(request?.headers.authorization).toBe('Bearer test-key')
    expect(request?.headers['user-agent']).toMatch(/^deepseek-harness\//)
  })

  it('fails loudly on a rejected credential, an unreachable endpoint, and a bad document', async () => {
    const server = await gateway({ apiKey: 'test-key', usage: GOOD })
    await expect(readUsageWindows({ baseURL: server.baseURL, apiKey: 'wrong' }))
      .rejects.toMatchObject({ code: 'USAGE_UNAVAILABLE' })
    await expect(readUsageWindows({ baseURL: server.baseURL, apiKey: undefined }))
      .rejects.toMatchObject({ code: 'USAGE_UNAVAILABLE' })
    await expect(readUsageWindows({ baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k' }))
      .rejects.toMatchObject({ code: 'USAGE_UNAVAILABLE' })

    const bad = await gateway({ usage: { usage: { rolling: { status: 'ok' } } } })
    await expect(readUsageWindows({ baseURL: bad.baseURL, apiKey: 'k' }))
      .rejects.toMatchObject({ code: 'USAGE_UNAVAILABLE' })
  })
})

describe('usage failure semantics', () => {
  it('invalidates a stale reading when the account is gone, keeps it when the read failed', () => {
    const missing = usageFailure(new LlmError('no credential', 'MISSING_CREDENTIAL'), undefined)
    expect(missing.details).toMatchObject({ retryable: false, retainPrevious: false })

    const transport = usageFailure(new LlmError('could not reach', 'USAGE_UNAVAILABLE'), 'src-1')
    expect(transport.details).toMatchObject({ retryable: true, retainPrevious: true, source: 'src-1' })
    expect(transport.message).toBe('could not reach')
  })
})

describe('since-boot meter', () => {
  it('accumulates disjoint counts into a billed total, per model', () => {
    const meter = new UsageMeter()
    meter.record('glm-5.3', { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0, totalTokens: 115 })
    meter.record('glm-5.3', { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 3, totalTokens: 6 })
    meter.record('kimi-k3', { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1200 })
    const snapshot = meter.snapshot()
    expect(snapshot.totals).toEqual({
      calls: 3, inputTokens: 1011, outputTokens: 207, cacheReadTokens: 100, cacheWriteTokens: 3, totalTokens: 1321,
    })
    expect(snapshot.models.map(entry => entry.model)).toEqual(['kimi-k3', 'glm-5.3'])
    expect(snapshot.models[1]).toMatchObject({ model: 'glm-5.3', calls: 2, totalTokens: 121 })
    expect(snapshot.atMs).toBeGreaterThanOrEqual(snapshot.sinceMs)
  })

  it('round-trips through the wire validators', () => {
    const meter = new UsageMeter()
    meter.record('glm-5.3', { inputTokens: 1, outputTokens: 2, totalTokens: 3 })
    expect(parseGoMeter(meter.snapshot()).totals).toMatchObject({ calls: 1, totalTokens: 3 })
    expect(() => parseGoMeter({ sinceMs: 1, atMs: 2, models: [{ model: 'x', calls: -1 }] })).toThrow(/invalid meter/)
    expect(() => parseGoMeter({ sinceMs: 1, atMs: 2, totals: {}, models: [] })).toThrow(/invalid meter/)
    expect(parseUsageWindows({ rolling: { status: 'ok', percent: 1, resetsAt: '2026-01-01T00:00:00Z' }, weekly: { status: 'ok', percent: 1, resetsAt: '2026-01-01T00:00:00Z' }, monthly: { status: 'ok', percent: 1, resetsAt: '2026-01-01T00:00:00Z' } }).rolling.percent).toBe(1)
  })

  it('records what the provider reported for a real streamed call', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { name: 'GLM-5.3', reasoning: true, limit: { context: 128_000, output: 8_192 } },
    }))
    const meter = new UsageMeter()
    const config: OpencodeGoConfig = {
      enabled: true, modelVisibility: {}, apiKeyEnv: 'OPENCODE_GO_API_KEY', baseURL: server.baseURL,
      refreshMinutes: 60, streamIdleTimeoutMs: 30_000, maxRequestImageBytes: 6_000_000,
      requestImagePixelBudget: 1_440_000, requestImageMaxBytes: 400_000, modelLimits: {}, modelProtocols: {},
    }
    try {
      const adapter = new OpencodeGoAdapter({
        config: () => config,
        resolveApiKey: async () => 'test-key',
        onUsage: ({ model, usage }) => meter.record(model, usage),
      })
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: 'opencode-go', model: 'glm-5.3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) chunks.push(chunk)
      expect(chunks.some(chunk => chunk.type === 'usage')).toBe(true)
      // The mock gateway reports 11 prompt tokens of which 5 were cached.
      expect(meter.snapshot().totals).toMatchObject({ calls: 1, inputTokens: 6, outputTokens: 3, cacheReadTokens: 5, totalTokens: 14 })
      expect(meter.snapshot().models[0]?.model).toBe('glm-5.3')
    } finally {
      stub.restore()
    }
  })
})
