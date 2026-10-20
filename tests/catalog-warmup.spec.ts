/**
 * The catalog is built while the host starts, not when a session waits.
 *
 * A new session resolves its model, and resolving a model builds the
 * catalog — the gateway listing, the provider's document, and 5.6 MB of
 * model metadata. That download is a wait measured in seconds on a desktop
 * build, and it lands on the first message of a session. So the mount asks
 * for the catalog in the background, and the session finds it ready.
 */
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { modelsDevDocument } from './mock-gateway.ts'

/** A context the mount accepts, with no Harness home. */
function context(): Record<string, unknown> {
  return {
    get: (name: string) => name === 'credentials'
      ? { describe: async () => ({ configured: true }), resolve: async () => undefined }
      : undefined,
    llm: {
      registerAdapter: vi.fn(() => () => {}),
      registerModelDiscovery: vi.fn(() => () => {}),
    },
    plugin: vi.fn(),
    // The effect runs its callback, as the framework does.
    effect: vi.fn((fn: () => (() => void) | void) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    }),
    on: vi.fn(),
    inject: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
}

/** Let the mount's asynchronous parts and the background read run. */
function settle(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 50) })
}

describe('the catalog warm-up', () => {
  it('asks for the catalog while the host is still starting', async () => {
    const asked: string[] = []
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://models.dev/')) {
        asked.push(url)
        return new Response(JSON.stringify(modelsDevDocument({})), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"v1"' },
        })
      }
      return realFetch(input as RequestInfo, init)
    })
    try {
      const ctx = context()
      apply(ctx as never, { enabled: true })
      await settle()
      // The read happened without anybody asking for a model.
      expect(asked.length).toBeGreaterThan(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not hold the mount up', async () => {
    const realFetch = globalThis.fetch
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://models.dev/')) {
        await gate
        return new Response(JSON.stringify(modelsDevDocument({})), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return realFetch(input as RequestInfo, init)
    })
    try {
      const ctx = context()
      // The mount returns while the read is still waiting on the network.
      apply(ctx as never, { enabled: true })
      await settle()
      const registered = (ctx.llm as { registerAdapter: ReturnType<typeof vi.fn> }).registerAdapter
      expect(registered).toHaveBeenCalledTimes(1)
      release?.()
      await settle()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
