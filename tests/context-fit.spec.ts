import { describe, expect, it, afterEach } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { estimateInputTokens, resolveFittedMaxTokens } from '../src/context-fit.ts'
import { OpencodeGoAdapter } from '../src/adapter.ts'
import type { OpencodeGoConfig } from '../src/config.ts'
import { modelsDevDocument, offlineDocument, startMockGateway, stubModelsDev } from './mock-gateway.ts'
import type { MockGateway } from './mock-gateway.ts'

const gateways: MockGateway[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
})

function textOptions(text: string, extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'opencode-go',
    model: 'fit-model',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    ...extra,
  } as GenerateOptions
}

describe('context-fit estimate', () => {
  it('bounds empty input at zero and counts text conservatively', () => {
    expect(estimateInputTokens({ messages: [] })).toBe(0)
    // 9 chars / 3 + one message overhead.
    expect(estimateInputTokens(textOptions('123456789'))).toBeGreaterThanOrEqual(3 + 8)
  })

  it('counts tools without dropping them', () => {
    const without = estimateInputTokens(textOptions('hi'))
    const tools = [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }]
    const withTools = estimateInputTokens(textOptions('hi', { tools: tools as never }))
    expect(withTools).toBeGreaterThan(without)
  })
})

describe('context-fit resolve', () => {
  it('passes through a fitting request unchanged', () => {
    expect(resolveFittedMaxTokens({
      modelId: 'm',
      contextWindow: 1_048_576,
      routeMaxTokens: 131_072,
      requestedMaxTokens: 131_072,
      estimatedInputTokens: 1000,
    })).toBe(131_072)
  })

  it('clamps the reported overflow shape instead of sending a gateway 400', () => {
    // 918672 + 131072 > 1048576 的真实报错形状：收缩后恰好装进窗口。
    const fitted = resolveFittedMaxTokens({
      modelId: 'muse-spark-1.3-contributor',
      contextWindow: 1_048_576,
      routeMaxTokens: 131_072,
      requestedMaxTokens: 131_072,
      estimatedInputTokens: 918_672,
    })
    expect(fitted).toBe(1_048_576 - 918_672 - 2048)
    expect(918_672 + (fitted as number) + 2048).toBeLessThanOrEqual(1_048_576)
  })

  it('caps a route default the caller never named', () => {
    const fitted = resolveFittedMaxTokens({
      modelId: 'm',
      contextWindow: 8192,
      routeMaxTokens: 2048,
      requestedMaxTokens: undefined,
      estimatedInputTokens: 5008,
    })
    expect(fitted).toBe(8192 - 5008 - 2048)
  })

  it('fails an input that already fills the window', () => {
    try {
      resolveFittedMaxTokens({
        modelId: 'm',
        contextWindow: 8192,
        routeMaxTokens: 2048,
        requestedMaxTokens: 2048,
        estimatedInputTokens: 8008,
      })
      expect.unreachable()
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
    }
  })
})

describe('context-fit on the wire', () => {
  function configFor(baseURL: string): OpencodeGoConfig {
    return {
      enabled: true,
      modelVisibility: {},
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
      baseURL,
      refreshMinutes: 60,
      streamIdleTimeoutMs: 30_000,
      keepAliveTimeoutMs: 600_000,
      imageBudgetPreset: 'dsh',
      modelLimits: {},
      modelProtocols: {},
      pinnedAddresses: {},
      requestLogEnabled: false,
      requestLogDebug: false,
      requestLogMaxEntries: 200,
    }
  }

  async function wireBody(text: string, maxTokens?: number): Promise<{ sent: unknown; requests: MockGateway['requests'] }> {
    const server = await startMockGateway({ listing: ['fit-model'] })
    gateways.push(server)
    const stub = stubModelsDev(modelsDevDocument({
      'fit-model': { name: 'Fit', limit: { context: 8192, output: 2048 } },
    }))
    try {
      const adapter = new OpencodeGoAdapter({
        config: () => configFor(server.baseURL),
        resolveApiKey: async () => 'test-key',
        readDocument: offlineDocument(),
      })
      const options = textOptions(text, maxTokens === undefined ? {} : { maxTokens })
      for await (const _chunk of adapter.stream(options)) { /* drain */ }
      const sent = server.requests.find(entry => entry.path.endsWith('/chat/completions'))?.body
      return { sent, requests: server.requests }
    } finally {
      stub.restore()
    }
  }

  function wireMaxTokens(body: unknown): number | undefined {
    if (typeof body !== 'object' || body === null) return undefined
    const row = body as Record<string, unknown>
    for (const key of ['max_tokens', 'maxTokens', 'max_completion_tokens', 'max_output_tokens']) {
      if (typeof row[key] === 'number') return row[key] as number
    }
    return undefined
  }

  it('shrinks an overflowing output instead of taking a gateway 400', async () => {
    const { sent } = await wireBody('a'.repeat(15_000), 2048)
    const clamped = wireMaxTokens(sent)
    expect(clamped).toBeDefined()
    expect(clamped as number).toBeLessThan(2048)
    // 5008 估算输入 + 收缩输出 + 2048 预留恰好装进 8192。
    expect(5008 + (clamped as number) + 2048).toBeLessThanOrEqual(8192)
  })

  it('fails before the wire when the input alone fills the window', async () => {
    const server = await startMockGateway({ listing: ['fit-model'] })
    gateways.push(server)
    const stub = stubModelsDev(modelsDevDocument({
      'fit-model': { name: 'Fit', limit: { context: 8192, output: 2048 } },
    }))
    try {
      const adapter = new OpencodeGoAdapter({
        config: () => configFor(server.baseURL),
        resolveApiKey: async () => 'test-key',
        readDocument: offlineDocument(),
      })
      await expect((async () => {
        for await (const _chunk of adapter.stream(textOptions('a'.repeat(24_000), { maxTokens: 2048 }))) { /* drain */ }
      })()).rejects.toMatchObject({ code: CONTEXT_WINDOW_EXCEEDED_CODE })
      expect(server.requests.some(entry => entry.path.endsWith('/chat/completions'))).toBe(false)
    } finally {
      stub.restore()
    }
  })
})
