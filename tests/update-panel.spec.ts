/**
 * One-click update panel: the check surfacing, the confirm arm, and the
 * inspect → remove → install drive through the host's own package manager.
 * Asserted against fake remotes rather than a browser.
 */
import { describe, expect, it } from 'vitest'
import { SectionController } from '../src/client/Section.tsx'
import type { SectionServices } from '../src/client/Section.tsx'

const STATUS = { current: '0.1.22', latest: '0.1.23', available: true, checkedAt: 1, checked: true }

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
            value: available ? STATUS : { current: '0.1.22', latest: '0.1.22', available: false, checkedAt: 1, checked: true },
          } as never
        },
        refreshUpdate: async (...args: unknown[]) => {
          if (args.length > 0) throw new Error('client api: opencodeGoUpdate/refreshUpdate expected 0 argument(s)')
          return {
            ok: true,
            value: available ? STATUS : { current: '0.1.22', latest: '0.1.22', available: false, checkedAt: 1, checked: true },
          } as never
        },
      },
      credentials: {
        describe: async () => ({ ok: true, value: {} }) as never,
        set: async () => ({ ok: true, value: undefined }) as never,
        unset: async () => ({ ok: true, value: undefined }) as never,
      },
    },
    pluginManager: {
      // Strict arity, mirroring the gateway client: each descriptor declares
      // its business arguments, and a call whose positional arity differs is
      // rejected before it reaches the Host. `inspect` declares two (spec and
      // options) even though options is optional in TypeScript — calling it
      // with one argument failed in a live run.
      inspect: async (...args: unknown[]) => {
        if (args.length !== 2) {
          throw new Error(`client api: pluginManager/inspect expected 2 business argument(s) plus an optional AbortSignal, got ${String(args.length)}`)
        }
        return script.inspect ?? { status: 'accepted', kind: 'registry', bundle: true }
      },
      removeBundle: async (...args: unknown[]) => {
        if (args.length !== 1) {
          throw new Error(`client api: pluginManager/removeBundle expected 1 argument(s), got ${String(args.length)}`)
        }
        return (script.remove ?? { ok: true, value: {} }) as never
      },
      installBundle: async (...args: unknown[]) => {
        if (args.length !== 2) {
          throw new Error(`client api: pluginManager/installBundle expected 2 business argument(s) plus an optional AbortSignal, got ${String(args.length)}`)
        }
        return (script.install ?? { ok: true, value: { application: 'applied' } }) as never
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

  it('survives a namespace that is absent when the first check runs', async () => {
    // The declared dependency is what guarantees the namespace exists. When it
    // is missing anyway, the page must say so rather than render nothing: an
    // earlier release returned the panel to `idle`, which hides every failure
    // behind a blank row with no retry.
    const tracking = services()
    Object.defineProperty(tracking.remote, 'opencodeGoUpdate', {
      configurable: true,
      value: undefined,
    })
    const controller = new SectionController(tracking)
    await settle()
    expect(controller.snapshot().update).toMatchObject({ phase: 'failed', message: 'remote-not-mounted' })
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

  it('never reports an unanswered lookup as up to date', async () => {
    // `checked: false` is the Host saying it could not reach the registry.
    // Rendering that as "already latest" would be a silent lie — the same
    // family of defect that hid this panel behind a blank row.
    const tracking = services()
    const unanswered = async () => ({
      ok: true,
      value: { current: '0.1.22', latest: undefined, available: false, checkedAt: 1, checked: false },
    })
    Object.defineProperty(tracking.remote, 'opencodeGoUpdate', {
      configurable: true,
      value: { readUpdate: unanswered, refreshUpdate: unanswered },
    })
    const controller = new SectionController(tracking)
    await settle()
    expect(controller.snapshot().update).toMatchObject({ phase: 'failed', message: 'registry-unreachable' })
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
    const manager = tracking.pluginManager!
    const inspect = manager.inspect
    const remove = manager.removeBundle
    const install = manager.installBundle
    manager.inspect = async (...args: unknown[]) => { calls.push('inspect'); return inspect(...args as [string]) }
    manager.removeBundle = async (...args: unknown[]) => {
      calls.push('remove'); return remove(...args as [string])
    }
    manager.installBundle = async (...args: unknown[]) => {
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
    tracking.pluginManager!.inspect = async (...args: unknown[]) => {
      expect(args).toHaveLength(2)
      throw new Error('registry unreachable')
    }
    tracking.pluginManager!.removeBundle = async () => { removed = true; return { ok: true, value: {} } as never }
    const controller = new SectionController(tracking)
    await settle()
    controller.armUpdate()
    await controller.applyUpdate()
    expect(removed).toBe(false)
    expect(controller.snapshot().update.phase).toBe('failed')
  })

  it('never uninstalls the running version when the target cannot be verified', async () => {
    // A refused inspection has no `bundle` field, so treating a missing answer
    // as "fine" would uninstall the running version and then fail to install
    // its replacement — leaving the user with no plugin at all.
    for (const inspected of [
      { status: 'refused', problem: 'network', reason: 'registry unreachable' },
      { status: 'accepted', kind: 'registry', bundle: false },
    ]) {
      let removed = false
      const tracking = services({ inspect: inspected })
      tracking.pluginManager!.removeBundle = async () => { removed = true; return { ok: true, value: {} } as never }
      const controller = new SectionController(tracking)
      await settle()
      controller.armUpdate()
      await controller.applyUpdate()
      expect(removed).toBe(false)
      expect(controller.snapshot().update.phase).toBe('failed')
    }
  })
})
