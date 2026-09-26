/**
 * Settings-page controller: the write path, its coalescing, its refusals, and
 * its read-only degradation. These are the behaviours a human would notice as
 * "it saved", "it lagged" or "it lied", so they are asserted against fake
 * remotes rather than a browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SectionController, API_KEY_REF, VISIBILITY_WRITE_DELAY_MS } from '../src/client/Section.tsx'
import type { SectionServices, SettingsScopeLike } from '../src/client/Section.tsx'
import type { CatalogReading } from '../src/catalog/contract.ts'

const READING: CatalogReading = {
  models: [
    { id: 'glm-5.3', name: 'GLM-5.3', protocolSource: 'builtin', assumedLimits: false },
    { id: 'glm-5', name: 'GLM-5', deprecated: true },
  ],
  stale: false,
  fetchedAtMs: 1,
  quotaSource: 'seed',
  counts: { total: 2, enabled: 1, deprecated: 1, unconfigured: 0, inferred: 0 },
}

interface Harness {
  readonly services: SectionServices
  readonly writes: Array<{ field: string; value: unknown }>
  readonly setWritable: (writable: boolean) => void
  readonly setVisibilityValue: (value: Record<string, boolean>) => void
  readonly failRefresh: () => void
}

function harness(options: { withScope?: boolean; rejectWrites?: boolean; rejectFirstWrite?: boolean } = {}): Harness {
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
      if (options.rejectWrites === true) return false
      if (options.rejectFirstWrite === true && writes.length === 1) return false
      return true
    },
  }
  const services: SectionServices = {
    remote: {
      opencodeGoCatalog: {
        read: async () => ({ ok: true, value: READING }),
        refresh: async () => (refreshFails
          ? { ok: false, error: new Error('the listing is unreachable') as never }
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
const settle = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

/** Drive the coalescing window so the pending write reaches the fake scope. */
const flushWrites = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(VISIBILITY_WRITE_DELAY_MS + 50) }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('settings controller', () => {
  it('publishes a flip immediately and coalesces a burst into one write', async () => {
    const test = harness()
    const controller = new SectionController(test.services)
    await settle()
    controller.setVisibility('glm-5.3', true)
    // The switch state is visible before any write happens.
    expect(controller.snapshot().settings?.modelVisibility).toEqual({ 'glm-5': true, 'glm-5.3': true })
    expect(test.writes).toHaveLength(0)
    controller.setVisibility('glm-5', false)
    await flushWrites()
    // One write carrying the final dict, not one per click.
    expect(test.writes).toEqual([{ field: 'modelVisibility', value: { 'glm-5': false, 'glm-5.3': true } }])
  })

  it('writes the whole visibility dict so untouched switches survive', async () => {
    const test = harness()
    const controller = new SectionController(test.services)
    await settle()
    controller.setVisibility('glm-5.3', true)
    await flushWrites()
    expect(test.writes).toEqual([{ field: 'modelVisibility', value: { 'glm-5': true, 'glm-5.3': true } }])
    controller.setVisibility('glm-5', false)
    await flushWrites()
    expect(test.writes.at(-1)).toEqual({ field: 'modelVisibility', value: { 'glm-5': false, 'glm-5.3': true } })
  })

  it('select-all skips deprecated models and select-none clears everything', async () => {
    const test = harness()
    const controller = new SectionController(test.services)
    await settle()
    // A deprecated model arrives switched off; select-all must leave it off.
    test.setVisibilityValue({ 'glm-5': false })
    controller.setAllVisibility(true)
    await flushWrites()
    expect(test.writes.at(-1)).toEqual({ field: 'modelVisibility', value: { 'glm-5': false, 'glm-5.3': true } })
    controller.setAllVisibility(false)
    await flushWrites()
    expect(test.writes.at(-1)).toEqual({ field: 'modelVisibility', value: { 'glm-5': false, 'glm-5.3': false } })
  })

  it('retries a refused write once and reports it only if the retry fails too', async () => {
    const test = harness({ rejectWrites: true })
    const controller = new SectionController(test.services)
    await settle()
    controller.setVisibility('glm-5.3', true)
    await flushWrites()
    // The original attempt plus the settle-the-race retry.
    expect(test.writes).toHaveLength(2)
    expect(controller.snapshot().writeFailure).toEqual({ kind: 'rejected' })
    expect(controller.snapshot().saving).toBe(false)
  })

  it('clears the failure when the retry lands', async () => {
    const test = harness({ rejectFirstWrite: true })
    const controller = new SectionController(test.services)
    await settle()
    controller.setVisibility('glm-5.3', true)
    await flushWrites()
    expect(test.writes).toHaveLength(2)
    expect(controller.snapshot().writeFailure).toBeUndefined()
    expect(controller.snapshot().settings?.modelVisibility).toEqual({ 'glm-5': true, 'glm-5.3': true })
  })

  it('narrows the list without writing anything to the Host', async () => {
    const test = harness()
    const controller = new SectionController(test.services)
    await settle()
    expect(controller.snapshot().filter).toMatchObject({ query: '', showDeprecated: false, onlyEnabled: false })
    controller.setFilter({ query: 'glm', showDeprecated: true, onlyEnabled: true, sort: 'name' })
    expect(controller.snapshot().filter).toMatchObject({
      query: 'glm', showDeprecated: true, onlyEnabled: true, sort: 'name',
    })
    await flushWrites()
    expect(test.writes).toHaveLength(0)
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
    controller.setVisibility('glm-5.3', true)
    controller.setAllVisibility(true)
    await controller.setRefreshMinutes(30)
    await flushWrites()
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
