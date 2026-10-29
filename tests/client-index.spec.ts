/**
 * Client mount: one Remote contribution carrying both namespaces.
 *
 * The settings page mounts `remote.opencodeGoCatalog`; a mount carrying usage
 * alone leaves that namespace unregistered and the settings section never
 * appears — which is exactly the defect a live run once caught. This asserts
 * the contribution as a set.
 */
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

function scope() {
  const slotsInject = vi.fn((_name: string, run: () => unknown) => {
    const result = run()
    // A generator registration yields its disposers; the real registry
    // consumes them, so the fake does too — otherwise a `function*`
    // registration never happens and the assertion below sees nothing.
    if (result !== null && typeof result === 'object' && typeof (result as { next?: unknown }).next === 'function') {
      (result as Generator).next()
    }
    return result
  })
  const slotsRegister = vi.fn((_options: unknown, component: unknown) => component)
  const base = {
    get: (name: string) => (name === 'configForms' ? { get: () => undefined } : undefined),
    remote: {
      $mount: vi.fn(async () => async () => {}),
      opencodeGoCatalog: {},
      opencodeGoUpdate: {},
      opencodeGoUsage: {},
      opencodeGoNetwork: {},
      opencodeGoRequestLog: {},
      pluginManager: {},
      credentials: {},
    },
    locale: { bind: () => (key: string) => key, getLocale: () => ({ active: 'en' }) },
    slots: { inject: slotsInject, register: slotsRegister },
    effect: vi.fn(),
    modelDirectories: { directoryFor: () => ({ store: {} }) },
  }
  return {
    ...base,
    // Cordis fires a nested `inject` as soon as its dependency is usable; the
    // fake hands the same scope back so the callback's namespace read resolves.
    inject: vi.fn((_services: string[], run: (scope: unknown) => unknown) => run(base)),
  }
}

function context() {
  const mounted: unknown[] = []
  return {
    ctx: {
      effect: vi.fn((run: () => unknown) => run()),
      locale: { register: vi.fn() },
      remote: { $mount: vi.fn(async (contribution: unknown) => { mounted.push(contribution); return async () => {} }) },
      inject: vi.fn((_services: string[], run: (scope: unknown) => unknown) => run(scope())),
    } as never,
    mounted,
  }
}

describe('client apply', () => {
  it('mounts usage and catalog methods under one package', async () => {
    const { ctx, mounted } = context()
    apply(ctx)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(mounted).toHaveLength(1)
    const contribution = mounted[0] as {
      package: string
      descriptors: Array<{ namespace: string; method: string }>
    }
    expect(contribution.package).toBe('@dan-ai-studio/dshopencodego')
    expect(contribution.descriptors.map(entry => `${entry.namespace}/${entry.method}`).toSorted()).toEqual([
      'opencodeGoCatalog/read',
      'opencodeGoCatalog/refresh',
      'opencodeGoNetwork/readNetwork',
      'opencodeGoRequestLog/readLog',
      'opencodeGoUpdate/readUpdate',
      'opencodeGoUpdate/refreshUpdate',
      'opencodeGoUsage/readMeter',
      'opencodeGoUsage/readWindows',
    ])
  })

  it('places the settings section and the usage pill', () => {    const { ctx } = context()
    const injected: unknown[][] = []
    const mockInject = (ctx as unknown as { inject: ReturnType<typeof vi.fn> }).inject
    mockInject.mockImplementation(
      (services: string[], run: (scope: unknown) => unknown) => {
        injected.push([services, run])
        run(scope())
      },
    )
    apply(ctx)
    // Both inject callbacks ran without throwing on a minimal scope. Every
    // namespace a closure reads must appear here: Cordis throws
    // `cannot get property "…" without inject` on an undeclared read, and a
    // missing `remote.opencodeGoUpdate` once made the update panel blank for
    // three releases. `remote.pluginManager` is deliberately absent — it is
    // read through the lenient `ctx.get()` so a composition without a plugin
    // manager still renders this section.
    expect(injected.map(([services]) => services)).toEqual([
      ['layout'],
      ['uiWorkspace'],
      ['workspaces'],
      ['configForms', 'remote.opencodeGoCatalog', 'remote.opencodeGoUpdate', 'remote.opencodeGoNetwork', 'remote.opencodeGoRequestLog', 'remote.credentials'],
      ['modelDirectories', 'remote.opencodeGoUsage', 'remote.session'],
    ])
  })

  it('registers the request log in the sidebar and in the conversation', () => {
    const { ctx } = context()
    const registered: Array<Record<string, unknown>> = []
    const mockInject = (ctx as unknown as { inject: ReturnType<typeof vi.fn> }).inject
    mockInject.mockImplementation(
      (services: string[], run: (scope: unknown) => unknown) => {
        void services
        const current = scope()
        const original = current.slots.register
        current.slots.register = ((options: unknown, component: unknown) => {
          registered.push(options as Record<string, unknown>)
          return original(options, component)
        }) as typeof current.slots.register
        run(current)
      },
    )
    apply(ctx)
    const names = registered.map(options => options['name'])
    // Three seats for the log: the settings section, the sidebar's panel
    // entry, and the conversation's own View.
    expect(names).toContain('settings.section')
    expect(names).toContain('sidebar.panellist')
    expect(names).toContain('conversation.view')
    expect(names).toContain('main')
    // The sidebar entry and the main panel must be one identity: the sidebar
    // resolves a row's label from the list and selects the panel with the
    // matching key.
    const panel = registered.find(options => options['name'] === 'main')
    const entry = registered.find(options => options['name'] === 'sidebar.panellist')
    expect(panel?.['key']).toBe(entry?.['id'])
    expect(panel?.['key']).toBe('dshopencodego-request-log')
  })

  it('hides the request-log seats while the master switch is off', () => {
    let enabled = false
    const listeners = new Set<() => void>()
    const fire = (): void => { listeners.forEach(fn => fn()) }
    const profile = {
      getSnapshot: () => ({
        status: 'ready',
        value: { requestLogEnabled: enabled },
        revision: 1,
        writable: true,
      }),
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
      set: async () => true,
    }
    const registered: Array<Record<string, unknown>> = []
    const disposed: string[] = []
    const { ctx } = context()
    const mockInject = (ctx as unknown as { inject: ReturnType<typeof vi.fn> }).inject
    mockInject.mockImplementation(
      (services: string[], run: (scope: unknown) => unknown) => {
        void services
        const current = scope()
        current.get = ((name: string) => (name === 'configForms' ? { get: () => profile } : undefined)) as typeof current.get
        current.slots.register = ((options: unknown, component: unknown) => {
          void component
          const record = options as Record<string, unknown>
          registered.push(record)
          return () => { disposed.push(String(record['name'])) }
        }) as typeof current.slots.register
        run(current)
      },
    )
    apply(ctx)
    const names = (): unknown[] => registered.map(options => options['name'])
    // The settings section stays: it owns the switch that brings the log back.
    expect(names()).toContain('settings.section')
    // Off means gone: no sidebar entry, no main panel, no conversation tab.
    expect(names()).not.toContain('main')
    expect(names()).not.toContain('sidebar.panellist')
    expect(names()).not.toContain('conversation.view')
    // Flipping the switch registers all three seats without a restart, and a
    // repeat notification does not register them twice.
    enabled = true
    fire()
    fire()
    expect(names()).toContain('main')
    expect(names()).toContain('sidebar.panellist')
    expect(names()).toContain('conversation.view')
    expect(names().filter(name => name === 'main')).toHaveLength(1)
    const panel = registered.find(options => options['name'] === 'main')
    const entry = registered.find(options => options['name'] === 'sidebar.panellist')
    expect(panel?.['key']).toBe(entry?.['id'])
    // And flipping it back removes them again.
    enabled = false
    fire()
    expect(disposed).toContain('main')
    expect(disposed).toContain('sidebar.panellist')
    expect(disposed).toContain('conversation.view')
  })
})
