/**
 * One-click update panel: the check surfacing, the confirm arm, and the
 * inspect → remove → install drive through the host's own package manager.
 * Asserted against fake remotes rather than a browser.
 */
import { describe, expect, it } from 'vitest'
import { SectionController } from '../src/client/Section.tsx'
import type { SectionServices } from '../src/client/Section.tsx'

const STATUS = { current: '0.1.22', latest: '0.1.23', available: true, checkedAt: 1 }

interface ManagerScript {
  inspect?: unknown
  remove?: { ok: boolean; value?: unknown; error?: unknown }
  install?: { ok: boolean; value?: unknown; error?: unknown }
}

function services(script: ManagerScript = {}, available = true): SectionServices {
  return {
    remote: {
      opencodeGoCatalog: {
        read: async () => ({ ok: true, value: undefined }) as never,
        refresh: async () => ({ ok: true, value: undefined }) as never,
      },
      opencodeGoUpdate: {
        // Mirrors the gateway client's arity check: a zero-parameter wire
        // method rejects any positional argument, so the page must call both
        // methods with none. A `force` flag riding `readUpdate` would throw on
        // the wire and hide the banner forever — this fake fails the same way.
        readUpdate: async (...args: unknown[]) => {
          if (args.length > 0) throw new Error('client api: opencodeGoUpdate/readUpdate expected 0 argument(s)')
          return {
            ok: true,
            value: available ? STATUS : { current: '0.1.22', latest: undefined, available: false, checkedAt: 1 },
          } as never
        },
        refreshUpdate: async (...args: unknown[]) => {
          if (args.length > 0) throw new Error('client api: opencodeGoUpdate/refreshUpdate expected 0 argument(s)')
          return {
            ok: true,
            value: available ? STATUS : { current: '0.1.22', latest: undefined, available: false, checkedAt: 1 },
          } as never
        },
      },
      pluginManager: {
        inspect: async () => script.inspect ?? {},
        removeBundle: async () => (script.remove ?? { ok: true, value: {} }) as never,
        installBundle: async () => (script.install ?? { ok: true, value: { application: 'applied' } }) as never,
      },
      credentials: {
        describe: async () => ({ ok: true, value: {} }) as never,
        set: async () => ({ ok: true, value: undefined }) as never,
        unset: async () => ({ ok: true, value: undefined }) as never,
      },
    },
    scope: undefined,
  }
}

/** Let the constructor's reads settle. */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve()
}

async function ready(): Promise<SectionController> {
  const controller = new SectionController(services())
  await settle()
  return controller
}

describe('update panel', () => {
  it('shows the banner only when a newer release is published', async () => {
    const controller = await ready()
    expect(controller.snapshot().update.phase).toBe('ready')
    const quiet = new SectionController(services({}, false))
    await settle()
    expect(quiet.snapshot().update.phase).toBe('current')
  })

  it('survives an update namespace that mounts after the page opens', async () => {
    // The section is built as soon as the catalog and credentials are visible,
    // which can precede the rest of this package's own Remote contribution:
    // the mount is asynchronous and registers namespace by namespace. Reading
    // `opencodeGoUpdate` before it exists threw a TypeError into the page's
    // catch, which returned the panel to `idle` — a permanently blank panel
    // with no retry, the defect a live run reported.
    const tracking = services()
    const real = tracking.remote.opencodeGoUpdate!
    let reads = 0
    Object.defineProperty(tracking.remote, 'opencodeGoUpdate', {
      configurable: true,
      get: () => { reads += 1; return reads > 1 ? real : undefined },
    })
    const controller = new SectionController(tracking)
    await new Promise(resolve => { setTimeout(resolve, 200) })
    expect(controller.snapshot().update.phase).toBe('ready')
  })

  it('keeps a failed check visible with a retry instead of vanishing', async () => {
    // A silent return to `idle` renders nothing at all, so no failure was ever
    // observable and none could be retried from the page.
    const tracking = services()
    const boom = async () => { throw new Error('registry exploded') }
    Object.defineProperty(tracking.remote, 'opencodeGoUpdate', {
      configurable: true,
      value: { readUpdate: boom, refreshUpdate: boom },
    })
    const controller = new SectionController(tracking)
    await settle()
    expect(controller.snapshot().update).toMatchObject({ phase: 'failed' })
    expect(controller.snapshot().update.message).toContain('registry exploded')
  })

  it('routes forced refresh through the zero-arg refreshUpdate method', async () => {
    // The gateway client rejects any call whose positional arity differs from
    // the descriptor's `parameters`, and every descriptor here declares none —
    // so a `force` flag must never ride `readUpdate`. The strict fakes above
    // throw on any positional argument, exactly like the wire would.
    const tracking = services()
    let refreshed = 0
    tracking.remote.opencodeGoUpdate!.refreshUpdate = (async (...args: unknown[]) => {
      if (args.length > 0) throw new Error('client api: opencodeGoUpdate/refreshUpdate expected 0 argument(s)')
      refreshed += 1
      return { ok: true, value: STATUS } as never
    }) as never
    const controller = new SectionController(tracking)
    await settle()
    await controller.checkUpdate(true)
    expect(refreshed).toBe(1)
    expect(controller.snapshot().update.phase).toBe('ready')
  })

  it('runs inspect, remove, then install on confirm', async () => {
    const calls: string[] = []
    const tracking = services()
    const manager = tracking.remote.pluginManager
    const inspect = manager.inspect
    const remove = manager.removeBundle
    const install = manager.installBundle
    tracking.remote.pluginManager.inspect = async (...args: unknown[]) => { calls.push('inspect'); return inspect(...args as [string]) }
    tracking.remote.pluginManager.removeBundle = async (...args: unknown[]) => {
      calls.push('remove'); return remove(...args as [string])
    }
    tracking.remote.pluginManager.installBundle = async (...args: unknown[]) => {
      calls.push('install'); return install(...args as [string])
    }
    const controller = new SectionController(tracking)
    await settle()
    controller.armUpdate()
    expect(controller.snapshot().update.phase).toBe('confirming')
    await controller.applyUpdate()
    expect(calls).toEqual(['inspect', 'remove', 'install'])
    expect(controller.snapshot().update.phase).toBe('done')
  })

  it('does nothing without the confirm arm', async () => {
    const controller = await ready()
    await controller.applyUpdate()
    expect(controller.snapshot().update.phase).toBe('ready')
  })

  it('reports a restart when the host defers activation', async () => {
    const controller = new SectionController(services({
      install: { ok: true, value: { application: 'restart-required' } },
    }))
    await settle()
    controller.armUpdate()
    await controller.applyUpdate()
    expect(controller.snapshot().update).toMatchObject({ phase: 'done', message: 'restart-required' })
  })

  it('surfaces incompatibility and pending builds as guidance, never retries', async () => {
    const incompatible = new SectionController(services({
      install: { ok: true, value: { error: { code: 'incompatible-version' } } },
    }))
    await settle()
    incompatible.armUpdate()
    await incompatible.applyUpdate()
    expect(incompatible.snapshot().update).toMatchObject({ phase: 'failed', message: 'incompatible-version' })

    const builds = new SectionController(services({
      install: { ok: true, value: { pendingBuilds: ['esbuild'] } },
    }))
    await settle()
    builds.armUpdate()
    await builds.applyUpdate()
    expect(builds.snapshot().update).toMatchObject({ phase: 'failed', message: 'pending-builds' })
  })

  it('reports a removal that needs a restart first', async () => {
    const controller = new SectionController(services({
      remove: { ok: true, value: { error: { code: 'stop-profile' } } },
    }))
    await settle()
    controller.armUpdate()
    await controller.applyUpdate()
    expect(controller.snapshot().update).toMatchObject({ phase: 'failed', message: 'stop-profile' })
  })

  it('stops before removing when inspection fails', async () => {
    let removed = false
    const tracking = services()
    tracking.remote.pluginManager.inspect = async () => { throw new Error('registry unreachable') }
    tracking.remote.pluginManager.removeBundle = async () => { removed = true; return { ok: true, value: {} } as never }
    const controller = new SectionController(tracking)
    await settle()
    controller.armUpdate()
    await controller.applyUpdate()
    expect(removed).toBe(false)
    expect(controller.snapshot().update.phase).toBe('failed')
  })
})
