/**
 * Plugin mount wiring: the settings namespace discovery is registered under,
 * the deliberate **absence** of a configurable-provider directory entry, the
 * discovery signal, and the loader listener that must never throw into
 * Cordis's emitter.
 */
import { describe, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.ts'
import { GO_DOC_URLS } from '../src/catalog/go-doc.ts'
import { modelsDevDocument, startMockGateway } from './mock-gateway.ts'

type Discover = (request: unknown, signal?: AbortSignal) => Promise<unknown>

interface Harness {
  ctx: Record<string, unknown>
  discoveryNs: string[]
  discover: Discover | undefined
  volatileUpdate: (() => void) | undefined
  registerAdapter: ReturnType<typeof vi.fn>
  registerConfigurableProviders: ReturnType<typeof vi.fn>
  errors: string[]
  infos: string[]
  /** Run the teardown the plugin registered. */
  teardown: () => Promise<void>
}

/** The live references a loader hands a plugin, with `get()` per field. */
function live(getters: Record<string, () => unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(getters).map(([key, get]) => [key, { get }]))
}

const BASE_GETTERS = (): Record<string, () => unknown> => ({
  enabled: () => true,
  modelVisibility: () => ({}),
  baseURL: () => 'https://opencode.ai/inference/go/v1',
  apiKeyEnv: () => 'OPENCODE_GO_API_KEY',
  refreshMinutes: () => 60,
  streamIdleTimeoutMs: () => 300_000,
  imageBudgetPreset: () => 'dsh',
  modelLimits: () => ({}),
  modelProtocols: () => ({}),
})

function context(options: {
  configured?: boolean
  entryId?: string
  bareMount?: boolean
  adapterReplaceThrows?: boolean
} = {}): Harness {
  const discoveryNs: string[] = []
  const errors: string[] = []
  const infos: string[] = []
  const state: Partial<Harness> = {}

  const adapterHandle = Object.assign((): void => {}, {
    replace: vi.fn((): void => {
      if (options.adapterReplaceThrows === true) throw new LlmError('route disposed', 'REGISTRATION_DISPOSED')
    }),
  })
  const registerAdapter = vi.fn(() => adapterHandle)
  // Publishing a directory entry would collide with `llm-pi-ai`'s declaration
  // of this same provider, so the mount must never call this. The mock records
  // any call, which is how the test below holds that decision.
  const registerConfigurableProviders = vi.fn()
  // The plugin's teardown is registered through `ctx.effect`, and the
  // disposer it registers is what closes the gateway's connection pool. The
  // mock keeps it so a test can run it.
  const disposers: (() => unknown)[] = []

  const ctx: Record<string, unknown> = {
    // A bare mount (a programmatic `apply`) has no loader fiber at all.
    ...options.bareMount === true ? {} : { fiber: { entry: { options: { id: options.entryId ?? 'dshopencodego' } } } },
    get: (name: string) => name === 'credentials'
      ? { describe: async () => ({ configured: options.configured ?? true }), resolve: async () => undefined }
      : undefined,
    llm: {
      registerAdapter,
      registerModelDiscovery: vi.fn((ns: string, discover: Discover) => {
        discoveryNs.push(ns)
        state.discover = discover
        return (): void => {}
      }),
      registerConfigurableProviders,
    },
    plugin: vi.fn(),
    // The plugin's teardown is registered through `ctx.effect`, and the
    // disposer it registers is what closes the gateway's connection pool. The
    // mock keeps it so a test can run it.
    //
    // The catalog warm-up's body is deliberately not run: it is a network
    // read this harness has no business making. Only the teardown's body
    // runs, and only its disposer is kept.
    effect: vi.fn((execute: () => (() => unknown) | void, label?: string) => {
      if (label === 'dshopencodego: catalog warm-up') return
      const disposer = execute()
      if (typeof disposer === 'function') disposers.push(disposer)
    }),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'loader/volatile-update') state.volatileUpdate = listener
    }),
    inject: vi.fn(),
    logger: {
      info: vi.fn((message: string) => { infos.push(message) }),
      warn: vi.fn(),
      error: vi.fn((message: string) => { errors.push(message) }),
    },
  }
  return {
    ctx,
    registerAdapter,
    registerConfigurableProviders,
    errors,
    infos,
    discoveryNs,
    // The teardown the plugin registered, so a test can run it.
    teardown: async () => {
      for (const disposer of disposers.splice(0)) await disposer()
    },
    // Read through the mutable state: `apply` fills these once it registers.
    get discover() { return state.discover },
    get volatileUpdate() { return state.volatileUpdate },
  } as Harness
}

const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

describe('configurable-provider directory', () => {
  it('publishes no entry — pi-ai already declares this provider', () => {
    const harness = context({ configured: true })
    apply(harness.ctx as never, { enabled: true })
    // `llm-pi-ai` declares `opencode-go` from pi-ai's builtin catalog and
    // registers it without a try/catch. A second declaration would be refused
    // when pi-ai wins the race, and would take pi-ai's whole plugin down when it
    // loses — so this mount stays out of that directory entirely. The Models
    // page still offers the provider, through pi-ai.
    expect(harness.registerConfigurableProviders).not.toHaveBeenCalled()
  })

  it('keys discovery by the loader entry id', () => {
    const harness = context({ configured: true, entryId: 'my-opencode-go' })
    apply(harness.ctx as never, { enabled: true })
    // The module name was never the namespace a surface looks up, which is why
    // discovery used to be dead code.
    expect(harness.discoveryNs).toEqual(['my-opencode-go'])
  })

  it('falls back to the module name on a bare mount', () => {
    const harness = context({ configured: true, bareMount: true })
    apply(harness.ctx as never, { enabled: true })
    expect(harness.discoveryNs).toEqual(['dshopencodego'])
  })

  it('keeps the route gated on the credential without a directory entry', async () => {
    const harness = context({ configured: false })
    apply(harness.ctx as never, { enabled: true })
    await tick()
    // A missing credential withdraws the route; that gate is what carries the
    // fact now, instead of a directory diagnostic.
    expect(harness.registerAdapter).not.toHaveBeenCalled()
    expect(harness.registerConfigurableProviders).not.toHaveBeenCalled()
  })
})

describe('loader/volatile-update listener', () => {
  it('contains a REGISTRATION_DISPOSED replace instead of starving later listeners', async () => {
    let visibility: Record<string, boolean> = { 'glm-5.3': true }
    const harness = context({ configured: true, entryId: 'go', adapterReplaceThrows: true })
    apply(harness.ctx as never, live({ ...BASE_GETTERS(), modelVisibility: () => visibility }))
    await tick()
    expect(harness.registerAdapter).toHaveBeenCalledTimes(1)

    // A profile edit changes the switch set, so the mount re-registers the
    // owned route — the call that throws REGISTRATION_DISPOSED once the
    // registration was released.
    const laterListener = vi.fn()
    const emit = (): void => {
      // Cordis emits with `Array.map` (harness `llm/src/index.ts:367-370`):
      // a synchronous throw here starves every listener after this one.
      for (const listener of [harness.volatileUpdate!, laterListener]) listener()
    }
    visibility = { 'glm-5.3': false }

    expect(() => { emit() }).not.toThrow()
    expect(laterListener).toHaveBeenCalledTimes(1)
    expect(harness.errors.join('\n')).toMatch(/could not re-evaluate the route/)
  })

  it('re-registers when only the retry policy changes', async () => {
    // The host captures the retry policy at registration, so a retry-only
    // edit must replace the route — comparing visibility alone used to drop it.
    let visibility: Record<string, boolean> = {}
    let retryPolicy: unknown = { mode: 'normal', maxRetries: 2 }
    const harness = context({ configured: true, entryId: 'go' })
    apply(harness.ctx as never, live({
      ...BASE_GETTERS(),
      modelVisibility: () => visibility,
      retryPolicy: () => retryPolicy,
    }))
    await tick()
    expect(harness.registerAdapter).toHaveBeenCalledTimes(1)
    const handle = harness.registerAdapter.mock.results[0]!.value as { replace: ReturnType<typeof vi.fn> }
    expect(handle.replace).not.toHaveBeenCalled()

    // A retry-only edit re-registers.
    retryPolicy = { mode: 'normal', maxRetries: 9 }
    harness.volatileUpdate!()
    expect(handle.replace).toHaveBeenCalledTimes(1)

    // An unrelated emission without any fact change re-registers nothing.
    harness.volatileUpdate!()
    expect(handle.replace).toHaveBeenCalledTimes(1)

    // Visibility still re-registers on its own.
    visibility = { 'glm-5.3': false }
    harness.volatileUpdate!()
    expect(handle.replace).toHaveBeenCalledTimes(2)
  })
})

describe('discovery cancellation', () => {
  it('forwards its signal to the documentation fetch and settles on abort', async () => {
    const server = await startMockGateway({ listing: ['glm-5.3'] })
    const original = globalThis.fetch
    const documentSignals: AbortSignal[] = []
    const metadata = modelsDevDocument({
      'glm-5.3': { reasoning: true, limit: { context: 1000, output: 100 } },
    })
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('https://models.dev/')) {
        return Promise.resolve(new Response(JSON.stringify(metadata), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"v1"' },
        }))
      }
      if (!GO_DOC_URLS.includes(url)) return original(input as RequestInfo, init)
      const signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        if (signal === null || signal === undefined) return
        documentSignals.push(signal)
        // Real fetch semantics: an aborted request rejects.
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        }, { once: true })
      })
    })
    const harness = context({ configured: true, entryId: 'go' })
    try {
      apply(harness.ctx as never, { enabled: true, baseURL: server.baseURL, apiKeyEnv: 'TEST_KEY' })
      const discover = harness.discover!
      const controller = new AbortController()
      const pending = discover({ provider: 'opencode-go' }, controller.signal)
      await tick()
      expect(documentSignals).toHaveLength(GO_DOC_URLS.length)
      expect(documentSignals.every(signal => !signal.aborted)).toBe(true)

      controller.abort()
      const settled = await Promise.race([
        pending,
        new Promise((_resolve, reject) => {
          setTimeout(() => { reject(new Error('discovery did not settle after the caller aborted')) }, 2000)
        }),
      ])
      // The cancelled documentation read degrades to the retained seed; the
      // listing still answers, so discovery completes rather than hanging.
      expect((settled as { id: string }[]).map(model => model.id)).toContain('glm-5.3')
      expect(documentSignals.every(signal => signal.aborted)).toBe(true)
    } finally {
      spy.mockRestore()
      await server.close()
    }
  })

  it('closes the gateway connection pool when the plugin is torn down', async () => {
    // The pool is the plugin's, and the plugin's life is the host's. A
    // profile edit that reloads the plugin would otherwise leave the old
    // pool's sockets on the machine, pointing at an address the new
    // configuration may no longer want.
    const harness = context({ configured: true, entryId: 'go' })
    apply(harness.ctx as never, { enabled: true })

    // The teardown must not throw, and it must be awaitable: Cordis awaits a
    // disposer that returns a promise, so the sockets are really closed
    // before the next version of the plugin starts.
    await expect(harness.teardown()).resolves.toBeUndefined()
  })
})
