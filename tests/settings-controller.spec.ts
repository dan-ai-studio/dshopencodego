/**
 * Settings-page controller: the write path, its refusals, and its read-only
 * degradation. These are the behaviours a human would notice as "it saved" or
 * "it lied", so they are asserted against fake remotes rather than a browser.
 */
import { describe, expect, it } from 'vitest'
import { SectionController, API_KEY_REF } from '../src/client/Section.tsx'
import type { SectionServices, SettingsScopeLike } from '../src/client/Section.tsx'
import type { CatalogReading } from '../src/catalog/contract.ts'

const READING: CatalogReading = {
  models: [
    { id: 'glm-5.3', name: 'GLM-5.3', protocolSource: 'builtin', assumedLimits: false },
    { id: 'glm-5', name: 'GLM-5', deprecated: true },
  ],
  stale: false,
  fetchedAtMs: 1,
  counts: { total: 2, enabled: 1, deprecated: 1, unconfigured: 0, inferred: 0 },
}

interface Harness {
  readonly services: SectionServices
  readonly writes: Array<{ field: string; value: unknown }>
  readonly setWritable: (writable: boolean) => void
  readonly setVisibilityValue: (value: Record<string, boolean>) => void
  readonly failRefresh: () => void
}

function harness(options: { withScope?: boolean; rejectWrites?: boolean } = {}): Harness {
  const writes: Array<{ field: string; value: unknown }> = []
  let writable = true
  let visibility: Record<string, boolean> = { 'glm-5': true }
  let refreshFails = false
  const listeners = new Set<() => void>()
  const scope: SettingsScopeLike = {
    getSnapshot: () => ({
      status: 'ready',
      value: { modelVisibility: visibility, refreshMinutes: 60 },
      revision: 1,
      writable,
    }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: async (field, value) => {
      writes.push({ field, value })
      return options.rejectWrites === true ? false : true
    },
  }
  const services: SectionServices = {
    remote: {
      opencodeGoCatalog: {
        read: async () => ({ ok: true, value: READING }),
        refresh: async () => (refreshFails
          ? { ok: false, error: new Error('the listing is unreachable') }
          : { ok: true, value: READING }),
      },
      credentials: {
        describe: async () => ({ ok: true, value: { [API_KEY_REF]: { configured: true } } }),
        set: async () => ({ ok: true, value: undefined }),
        unset: async () => ({ ok: true, value: undefined }),
      },
    },
    scope: options.withScope === false ? undefined : scope,
  }
  return {
    services,
    writes,
    setWritable: (next) => {
      writable = next
      for (const listener of listeners) listener()
    },
    setVisibilityValue: (next) => {
      visibility = next
      for (const listener of listeners) listener()
    },
    failRefresh: () => { refreshFails = true },
  }
}

/** Let the controller's constructor-time reads settle. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

describe('settings controller', () => {
  it('writes the whole visibility dict so untouched switches survive', async () => {
    const test = harness()
    const controller = new SectionController(test.services)
    await settle()
    await controller.setVisibility('glm-5.3', true)
    expect(test.writes).toEqual([{ field: 'modelVisibility', value: { 'glm-5': true, 'glm-5.3': true } }])
    await controller.setVisibility('glm-5', false)
    expect(test.writes.at(-1)).toEqual({ field: 'modelVisibility', value: { 'glm-5': false, 'glm-5.3': true } })
  })

  it('surfaces a rejected write instead of reporting it as saved', async () => {
    const test = harness({ rejectWrites: true })
    const controller = new SectionController(test.services)
    await settle()
    await controller.setVisibility('glm-5.3', true)
    expect(test.writes).toHaveLength(1)
    expect(controller.snapshot().failure).toBe('the settings write was rejected')
    expect(controller.snapshot().saving).toBe(false)
  })

  it('refuses an out-of-range refresh interval without writing', async () => {
    const test = harness()
    const controller = new SectionController(test.services)
    await settle()
    await controller.setRefreshMinutes(0)
    await controller.setRefreshMinutes(7 * 24 * 60 + 1)
    await controller.setRefreshMinutes(1.5)
    expect(test.writes).toHaveLength(0)
    await controller.setRefreshMinutes(30)
    expect(test.writes).toEqual([{ field: 'refreshMinutes', value: 30 }])
  })

  it('stays read-only when there is no settings surface', async () => {
    const test = harness({ withScope: false })
    const controller = new SectionController(test.services)
    await settle()
    expect(controller.snapshot().writable).toBe(false)
    expect(controller.snapshot().settings).toBeUndefined()
    await controller.setVisibility('glm-5.3', true)
    await controller.setRefreshMinutes(30)
    expect(test.writes).toHaveLength(0)
  })

  it('tracks the switches the Host reports back', async () => {
    const test = harness()
    const controller = new SectionController(test.services)
    await settle()
    test.setVisibilityValue({ 'glm-5.3': false })
    expect(controller.snapshot().settings?.modelVisibility).toEqual({ 'glm-5.3': false })
    test.setWritable(false)
    expect(controller.snapshot().writable).toBe(false)
  })

  it('keeps the previous reading when a refresh fails, and says why', async () => {
    const test = harness()
    const controller = new SectionController(test.services)
    await settle()
    expect(controller.snapshot().reading?.counts.total).toBe(2)
    test.failRefresh()
    await controller.load(true)
    expect(controller.snapshot().reading?.counts.total).toBe(2)
    expect(controller.snapshot().failure).toBe('the listing is unreachable')
    expect(controller.snapshot().loading).toBe(false)
  })
})
