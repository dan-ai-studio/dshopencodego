/**
 * The settings page's pin: what it writes, what it refuses, and what it
 * shows.
 *
 * The page is the only place a person can set the address, so its refusals
 * are the ones that stand between a typo and a request that quietly goes
 * somewhere else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SectionController } from '../src/client/Section.tsx'
import type { SectionServices, SettingsScopeLike } from '../src/client/Section.tsx'
import { isAddress } from '../src/client/address.ts'
import type { CatalogReading } from '../src/catalog/contract.ts'

const READING: CatalogReading = {
  models: [],
  stale: false,
  degradations: [],
  fetchedAtMs: 1,
  quotaSource: 'seed',
  counts: { total: 0, enabled: 0, deprecated: 0, unconfigured: 0, inferred: 0 },
}

interface Harness {
  readonly services: SectionServices
  readonly writes: Array<{ field: string, value: unknown }>
  /** The pins the settings surface reports, as the Host would. */
  readonly setPins: (pins: Record<string, string>) => void
}

function harness(options: { withNetwork?: boolean, writable?: boolean } = {}): Harness {
  const writes: Array<{ field: string, value: unknown }> = []
  const listeners = new Set<() => void>()
  let writable = options.writable ?? true
  let pins: Record<string, string> = {}
  const scope: SettingsScopeLike = {
    getSnapshot: () => ({
      status: 'ready',
      value: { modelVisibility: {}, refreshMinutes: 60, pinnedAddresses: pins },
      revision: 1,
      writable,
    }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: async (field, value) => { writes.push({ field, value }); return true },
  }
  const services: SectionServices = {
    remote: {
      opencodeGoCatalog: {
        read: async () => ({ ok: true, value: READING }),
        refresh: async () => ({ ok: true, value: READING }),
      },
      credentials: {
        describe: async () => ({ ok: true, value: {} }),
        set: async () => ({ ok: true, value: undefined }),
        unset: async () => ({ ok: true, value: undefined }),
      },
      ...options.withNetwork === false ? {} : {
        opencodeGoNetwork: {
          readNetwork: async () => ({ ok: true, value: { host: 'opencode.ai', address: '1.2.3.4' } }),
        },
      },
    },
    scope,
  }
  return {
    services,
    writes,
    setPins: (next) => {
      pins = next
      for (const listener of listeners) listener()
    },
  }
}

const settle = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the address the page accepts', () => {
  it('takes an IPv4 address', () => {
    expect(isAddress('1.2.3.4')).toBe(true)
    expect(isAddress(' 8.8.8.8 ')).toBe(true)
  })

  it('takes an IPv6 address', () => {
    expect(isAddress('::1')).toBe(true)
    expect(isAddress('2001:db8::1')).toBe(true)
    expect(isAddress('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(true)
    expect(isAddress('::ffff:192.168.1.1')).toBe(true)
  })

  it('refuses anything a socket could not be sent to', () => {
    expect(isAddress('')).toBe(false)
    expect(isAddress('not-an-address')).toBe(false)
    expect(isAddress('1.2.3.256')).toBe(false)
    // A leading zero is read as octal by some resolvers and as ten by others.
    expect(isAddress('010.1.1.1')).toBe(false)
    expect(isAddress('2001:db8::1::2')).toBe(false)
    expect(isAddress('1.2.3')).toBe(false)
  })
})

describe('the pin on the settings page', () => {
  it('shows the address the Host reports', async () => {
    const test = harness()
    const controller = new SectionController(test.services)
    await settle()
    expect(controller.snapshot().network).toEqual({ host: 'opencode.ai', address: '1.2.3.4' })
  })

  it('writes the address for the gateway name', async () => {
    const test = harness()
    const controller = new SectionController(test.services)
    await settle()
    await controller.savePin('5.6.7.8')
    expect(test.writes).toContainEqual({
      field: 'pinnedAddresses',
      value: { 'opencode.ai': '5.6.7.8' },
    })
  })

  it('refuses an address that is not one, and writes nothing', async () => {
    const test = harness()
    const controller = new SectionController(test.services)
    await settle()
    await controller.savePin('300.1.1.1')
    expect(test.writes).toHaveLength(0)
    expect(controller.snapshot().pinInvalid).toBe(true)
  })

  it('removes the address', async () => {
    const test = harness()
    const controller = new SectionController(test.services)
    await settle()
    await controller.clearPin()
    expect(test.writes).toContainEqual({ field: 'pinnedAddresses', value: {} })
  })

  it('keeps a pin for another name', async () => {
    const test = harness()
    const controller = new SectionController(test.services)
    await settle()
    // The scope reports a pin for a host this plugin does not use; the write
    // must not drop it.
    test.setPins({ 'other.test': '9.9.9.9' })
    await controller.savePin('5.6.7.8')
    expect(test.writes.at(-1)).toEqual({
      field: 'pinnedAddresses',
      value: { 'other.test': '9.9.9.9', 'opencode.ai': '5.6.7.8' },
    })
  })

  it('stays read-only when there is no settings surface', async () => {
    const test = harness()
    const services: SectionServices = { ...test.services, scope: undefined }
    const controller = new SectionController(services)
    await settle()
    await controller.savePin('5.6.7.8')
    await controller.clearPin()
    expect(test.writes).toHaveLength(0)
  })

  it('renders without the network namespace', async () => {
    const test = harness({ withNetwork: false })
    const controller = new SectionController(test.services)
    await settle()
    // No pin to show is not a failure: the page says nothing rather than
    // claiming an address it does not know.
    expect(controller.snapshot().network).toBeUndefined()
    expect(controller.snapshot().networkFailure).toBeUndefined()
  })
})
