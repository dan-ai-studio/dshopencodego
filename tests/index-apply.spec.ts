/**
 * Plugin mount: the route gate.
 *
 * Registration is gated on configuration *and* credential; a route another
 * adapter owns is reported rather than crashing the mount, and discovery plus
 * the configuration surface stay mounted either way.
 */
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

interface Ctx {
  registerAdapter: ReturnType<typeof vi.fn>
  undiscover: ReturnType<typeof vi.fn>
  errors: string[]
  infos: string[]
}

function context(options: {
  enabled?: boolean
  configured?: boolean
  registerAdapter?: (providers: string[], adapter: unknown) => (() => void)
} = {}): { ctx: Record<string, unknown>; state: Ctx } {
  const undiscover = vi.fn()
  const registerAdapter = vi.fn(options.registerAdapter ?? (() => () => {}))
  const errors: string[] = []
  const infos: string[] = []
  const ctx: Record<string, unknown> = {
    get: (name: string) => {
      if (name === 'credentials') {
        return {
          describe: async () => ({ configured: options.configured ?? false }),
          resolve: async () => undefined,
        }
      }
      return undefined
    },
    llm: {
      registerAdapter,
      registerModelDiscovery: vi.fn(() => undiscover),
    },
    plugin: vi.fn(),
    effect: vi.fn(),
    on: vi.fn(),
    inject: vi.fn(),
    logger: {
      info: vi.fn((message: string) => { infos.push(message) }),
      warn: vi.fn(),
      error: vi.fn((message: string) => { errors.push(message) }),
    },
  }
  return { ctx, state: { registerAdapter, undiscover, errors, infos } }
}

const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

describe('apply route gate', () => {
  it('registers the route when enabled with a configured credential', async () => {
    const { ctx, state } = context({ enabled: true, configured: true })
    apply(ctx as never, { enabled: true })
    await tick()
    expect(state.registerAdapter).toHaveBeenCalledTimes(1)
    expect(state.registerAdapter.mock.calls[0]![0]).toEqual(['opencode-go'])
  })

  it('withdraws the route when disabled, keeping discovery mounted', async () => {
    const { ctx, state } = context({ enabled: false, configured: true })
    apply(ctx as never, { enabled: false })
    await tick()
    expect(state.registerAdapter).not.toHaveBeenCalled()
    const discovery = (ctx.llm as { registerModelDiscovery: ReturnType<typeof vi.fn> }).registerModelDiscovery
    expect(discovery).toHaveBeenCalledTimes(1)
    expect(discovery.mock.calls[0]![0]).toBe('dshopencodego')
  })

  it('registers nothing without a credential, and fails loud on resolve', async () => {
    const { ctx, state } = context({
      enabled: true,
      configured: false,
    })
    apply(ctx as never, { enabled: true, apiKeyEnv: 'DSHOPENCODEGO_TEST_MISSING_KEY_XYZ' })
    await tick()
    expect(state.registerAdapter).not.toHaveBeenCalled()
  })

  it('reports a contested route instead of crashing the mount', async () => {
    const { ctx, state } = context({
      enabled: true,
      configured: true,
      registerAdapter: () => { throw new Error("DUPLICATE_ADAPTER") },
    })
    expect(() => apply(ctx as never, { enabled: true })).not.toThrow()
    await tick()
    expect(state.errors.join('\n')).toMatch(/another adapter already owns it/)
  })
})

/**
 * The `internal/config` waterfall is the only place a profile edit is checked
 * before it is persisted. Cordis 4.0.6 (DSH 0.2.2-alpha.3) moved the owning
 * fiber from `this` into the first argument, which used to carry the candidate
 * config — so the listener has to recognise both shapes, and the engine range
 * spans both releases.
 */
describe('internal/config validation listener', () => {
  type Listener = (this: unknown, ...args: unknown[]) => unknown

  function listenerOf(ctx: Record<string, unknown>): Listener {
    const on = ctx.on as ReturnType<typeof vi.fn>
    const call = on.mock.calls.find(([name]) => name === 'internal/config')
    expect(call, 'the internal/config listener was never registered').toBeDefined()
    return call![1] as Listener
  }

  // Plain http to a public host is the one baseURL rule a candidate can break
  // without any other field being wrong.
  const candidate = { enabled: true, baseURL: 'http://example.com' }

  it('validates when the fiber arrives as `this` (cordis 4.0.5)', () => {
    const { ctx } = context({ enabled: true, configured: true })
    const fiber = {}
    ctx.fiber = fiber
    apply(ctx as never, { enabled: true })
    expect(() => listenerOf(ctx).call(fiber, candidate, () => candidate)).toThrow(/must use https/)
  })

  it('validates when the fiber arrives as the first argument (cordis 4.0.6)', () => {
    const { ctx } = context({ enabled: true, configured: true })
    const fiber = {}
    ctx.fiber = fiber
    apply(ctx as never, { enabled: true })
    expect(() => listenerOf(ctx).call(undefined, fiber, () => candidate)).toThrow(/must use https/)
  })

  it('leaves another fiber\'s config alone in both shapes', () => {
    const { ctx } = context({ enabled: true, configured: true })
    ctx.fiber = {}
    apply(ctx as never, { enabled: true })
    const listener = listenerOf(ctx)
    const other = {}
    expect(listener.call(other, candidate, () => candidate)).toBe(candidate)
    expect(listener.call(undefined, other, () => candidate)).toBe(candidate)
  })

  it('does not validate before the mount has a fiber', () => {
    const { ctx } = context({ enabled: true, configured: true })
    apply(ctx as never, { enabled: true })
    // `ctx.fiber` is undefined here, which is also what `this` is under the
    // 4.0.6 shape — the guard must not read that as "this is my fiber".
    expect(listenerOf(ctx).call(undefined, undefined, () => candidate)).toBe(candidate)
  })
})
