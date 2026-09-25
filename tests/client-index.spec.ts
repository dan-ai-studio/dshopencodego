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
  const slotsInject = vi.fn((name: string, run: () => unknown) => run())
  const slotsRegister = vi.fn((_options: unknown, component: unknown) => component)
  return {
    get: (name: string) => (name === 'configForms' ? { get: () => undefined } : undefined),
    remote: {
      $mount: vi.fn(async () => async () => {}),
      opencodeGoCatalog: {},
      opencodeGoUsage: {},
      credentials: {},
    },
    locale: { bind: () => (key: string) => key, getLocale: () => ({ active: 'en' }) },
    slots: { inject: slotsInject, register: slotsRegister },
    effect: vi.fn(),
    modelDirectories: { directoryFor: () => ({ store: {} }) },
  }
}

function context() {
  const mounted: unknown[] = []
  return {
    ctx: {
      effect: vi.fn((run: () => unknown) => run()),
      locale: { register: vi.fn() },
      remote: { $mount: vi.fn(async (contribution: unknown) => { mounted.push(contribution); return async () => {} }) },
      inject: vi.fn((services: string[], run: (scope: unknown) => unknown) => run(scope())),
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
      'opencodeGoUsage/readMeter',
      'opencodeGoUsage/readWindows',
    ])
  })

  it('places the settings section and the usage pill', () => {
    const { ctx } = context()
    const injected: unknown[][] = []
    ;(ctx.inject as ReturnType<typeof vi.fn>).mockImplementation(
      (services: string[], run: (scope: unknown) => unknown) => {
        injected.push([services, run])
        run(scope())
      },
    )
    apply(ctx)
    // Both inject callbacks ran without throwing on a minimal scope.
    expect(injected.map(([services]) => services)).toEqual([
      ['configForms', 'remote.opencodeGoCatalog', 'remote.credentials'],
      ['modelDirectories', 'remote.opencodeGoUsage'],
    ])
  })
})
