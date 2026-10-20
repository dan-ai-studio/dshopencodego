/**
 * Catalog read-path fixes: the documentation fetch is asked concurrently and
 * honours cancellation, the snapshot forwards its caller's signal, the
 * settings Remote reports its own domain failure code, and visibility switches
 * for ids the gateway does not advertise are diagnosed once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { OpencodeGoCatalog, discoverCatalogModels } from '../src/catalog/index.ts'
import { fetchGoDocument, GO_DOC_URLS } from '../src/catalog/go-doc.ts'
import { OpencodeGoCatalogService } from '../src/catalog/service.ts'
import { unadvertisedVisibilityIds } from '../src/models.ts'
import { modelsDevDocument, offlineDocument, startMockGateway, stubModelsDev } from './mock-gateway.ts'
import type { MockGateway } from './mock-gateway.ts'

const DEFAULTS = { contextWindow: 262_144, maxTokens: 32_768, input: ['text'] as const }

/** A Cordis context stub: the service base only registers through `reflect`. */
const CTX = { reflect: { provide: () => {} } } as never

const gateways: MockGateway[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
})

async function gateway(options?: Parameters<typeof startMockGateway>[0]): Promise<MockGateway> {
  const started = await startMockGateway(options)
  gateways.push(started)
  return started
}

/** A usable allowance table, with the monthly figure identifying the source. */
function documented(monthlyUsd: number): string {
  return [
    '| Model | Input | Output | Cached Read | Cached Write | Monthly limit |',
    '| --- | --- | --- | --- | --- | --- |',
    `| GLM-5.3 | $0.15 | $0.50 | - | - | **$${monthlyUsd}** |`,
    '',
    '| Model | Model ID | Endpoint | AI SDK Package |',
    '| --- | --- | --- | --- |',
    '| GLM-5.3 | glm-5.3 | `https://opencode.ai/inference/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |',
  ].join('\n')
}

describe('fetchGoDocument request shape', () => {
  it('asks every source concurrently and still prefers the first that answers', async () => {
    const resolvers: Array<(response: Response) => void> = []
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      new Promise<Response>(resolve => { resolvers.push(resolve) }))
    try {
      const pending = fetchGoDocument()
      // Both requests are in flight before either answered. Sequential code
      // issued the second only after the first failed, so a cold process paid
      // two 10 s timeouts before its first token.
      expect(resolvers).toHaveLength(GO_DOC_URLS.length)
      // Answer the fallback first, then the primary: the declared order still
      // decides which document is used.
      resolvers[1]!(new Response(documented(30), { status: 200 }))
      resolvers[0]!(new Response(documented(60), { status: 200 }))
      const document = await pending
      expect(document.quotas.get('glm-5.3')).toEqual({ monthlyUsd: 60 })
      expect(document.protocols.get('glm-5.3')).toBe('openai-completions')
    } finally {
      spy.mockRestore()
    }
  })

  it('forwards the caller signal into every source request', async () => {
    const controller = new AbortController()
    const signals: AbortSignal[] = []
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const signal = init?.signal
      if (signal !== null && signal !== undefined) signals.push(signal)
      return Promise.resolve(new Response('# moved elsewhere\n', { status: 200 }))
    })
    try {
      await expect(fetchGoDocument(controller.signal, { discover: async () => [] }))
        .rejects.toMatchObject({ code: 'DOCUMENT_UNAVAILABLE' })
      expect(signals).toHaveLength(GO_DOC_URLS.length)
      expect(signals.every(signal => !signal.aborted)).toBe(true)
      // The request signal is the composition of the caller's cancellation and
      // the shared timeout, so aborting the caller aborts the transport.
      controller.abort()
      expect(signals.every(signal => signal.aborted)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('catalog cancellation', () => {
  it('hands the snapshot signal to the documentation reader', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { reasoning: true, limit: { context: 1000, output: 100 } },
    }))
    const seen: Array<AbortSignal | undefined> = []
    const catalog = new OpencodeGoCatalog({
      baseURL: server.baseURL,
      refreshMs: 60_000,
      defaults: DEFAULTS,
      overrides: {},
      readDocument: async (signal) => {
        seen.push(signal)
        return { quotas: new Map([['glm-5.3', { monthlyUsd: 60 }]]), protocols: new Map() }
      },
    })
    const controller = new AbortController()
    try {
      const snapshot = await catalog.snapshot(true, controller.signal)
      expect(seen).toEqual([controller.signal])
      expect(snapshot.documentQuotas?.get('glm-5.3')).toEqual({ monthlyUsd: 60 })
    } finally {
      stub.restore()
    }
  })

  it('hands the discovery signal to the documentation reader and still answers', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(modelsDevDocument({}))
    const seen: Array<AbortSignal | undefined> = []
    const catalog = new OpencodeGoCatalog({
      baseURL: server.baseURL,
      refreshMs: 60_000,
      defaults: DEFAULTS,
      overrides: {},
      readDocument: async (signal) => {
        seen.push(signal)
        // A cancelled documentation read is a fallback, not a failed catalog:
        // the listing and the metadata still decide the answer.
        throw new Error('documentation cancelled')
      },
    })
    const controller = new AbortController()
    try {
      const models = await discoverCatalogModels(catalog, controller.signal)
      expect(seen).toEqual([controller.signal])
      expect(models.map(model => model.id)).toContain('glm-5.3')
    } finally {
      stub.restore()
    }
  })
})

describe('catalog domain failure', () => {
  it('wraps a projection that cannot run in the catalog code', async () => {
    const service = new OpencodeGoCatalogService(CTX, {
      catalog: () => ({ snapshot: async () => { throw new Error('listing exploded') } }) as never,
      visibility: () => ({}),
    })
    const error: unknown = await service.read().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(RemoteError)
    expect(error).toMatchObject({ code: 'dshopencodego/catalog-unavailable' })
    expect((error as RemoteError).message).toBe('listing exploded')
    expect((error as RemoteError).details).toMatchObject({ retryable: true, retainPrevious: true })
  })
})

describe('unadvertised visibility switches', () => {
  it('names configured ids the gateway does not advertise', () => {
    expect(unadvertisedVisibilityIds(
      { 'space-bunny-free': true, 'glm-5.3': false },
      ['glm-5.3', 'kimi-k3'],
    )).toEqual(['space-bunny-free'])
    // An unconfigurable-but-advertised id is not "unadvertised": the other
    // diagnostic (`onUnconfigured`) owns that case.
    expect(unadvertisedVisibilityIds({ 'bad-model': false }, ['bad-model'])).toEqual([])
    expect(unadvertisedVisibilityIds({}, ['glm-5.3'])).toEqual([])
  })

  it('reports once per distinct set, from a live listing only', async () => {
    const server = await gateway({ listing: ['glm-5.3'] })
    const stub = stubModelsDev(modelsDevDocument({
      'glm-5.3': { reasoning: true, limit: { context: 1000, output: 100 } },
    }))
    const catalog = new OpencodeGoCatalog({
      baseURL: server.baseURL,
      refreshMs: 60_000,
      defaults: DEFAULTS,
      overrides: {},
      readDocument: offlineDocument(),
    })
    let visibility: Record<string, boolean> = { 'space-bunny-free': true, 'glm-5.3': false }
    const reported: string[][] = []
    const service = new OpencodeGoCatalogService(CTX, {
      catalog: () => catalog,
      visibility: () => visibility,
      onUnadvertised: (ids) => { reported.push([...ids]) },
    })
    try {
      await service.read()
      await service.read()
      expect(reported).toEqual([['space-bunny-free']])

      // A retained snapshot after a listing outage is not evidence of absence,
      // so a changed switch set is not accused while the gateway is down.
      server.setListingStatus(500)
      visibility = { 'space-bunny-free': true, 'glm-5.3': false, 'brand-new-switch': true }
      await service.refresh()
      expect(reported).toEqual([['space-bunny-free']])

      // The listing answers again: the new set is reported exactly once.
      server.setListingStatus(200)
      await service.refresh()
      expect(reported).toEqual([['space-bunny-free'], ['brand-new-switch', 'space-bunny-free']])
      await service.refresh()
      expect(reported).toEqual([['space-bunny-free'], ['brand-new-switch', 'space-bunny-free']])
    } finally {
      stub.restore()
    }
  })
})
