// @vitest-environment jsdom
/**
 * The settings page's fixed-IP block: the one place a person can say which
 * address the gateway's name should be sent to.
 *
 * The block is rendered, not merely described: a person setting an address
 * has to see the host it applies to, the address in force, and whether the
 * plugin is still using it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Section, SectionController } from '../src/client/Section.tsx'
import type { SectionServices } from '../src/client/Section.tsx'
import { en } from '../src/client/locales.ts'
import type { CatalogReading } from '../src/catalog/contract.ts'

const READING: CatalogReading = {
  models: [],
  stale: false,
  degradations: [],
  fetchedAtMs: 1,
  quotaSource: 'seed',
  counts: { total: 0, enabled: 0, deprecated: 0, unconfigured: 0, inferred: 0 },
}

const ok = <T,>(value: T): never => ({ ok: true, value }) as never

/** Services whose gateway is pinned to one address. */
function servicesFor(network: { host: string, address?: string, failed?: boolean }): SectionServices {
  return {
    remote: {
      opencodeGoCatalog: { read: async () => ok(READING), refresh: async () => ok(READING) },
      opencodeGoUpdate: {
        readUpdate: async () => ok({ current: '0.1.22', latest: '0.1.22', available: false, checkedAt: 0, checked: true }),
        refreshUpdate: async () => ok({ current: '0.1.22', latest: '0.1.22', available: false, checkedAt: 0, checked: true }),
      },
      opencodeGoNetwork: { readNetwork: async () => ok(network) },
      credentials: {
        describe: async () => ok({}),
        set: async () => ok(undefined),
        unset: async () => ok(undefined),
      },
    },
    scope: undefined,
  }
}

const t = (key: string): string => (en as Record<string, string>)[key] ?? key

afterEach(() => { cleanup() })

describe('the fixed-IP block on the settings page', () => {
  it('names the gateway the address applies to', async () => {
    render(<Section controller={new SectionController(servicesFor({ host: 'opencode.ai' }))} t={t} />)
    await screen.findByText('Fixed IP')
    expect(screen.getByText('opencode.ai')).toBeTruthy()
  })

  it('says so when nothing is pinned', async () => {
    render(<Section controller={new SectionController(servicesFor({ host: 'opencode.ai' }))} t={t} />)
    await screen.findByText('System DNS')
  })

  it('shows the address in force', async () => {
    render(<Section controller={new SectionController(servicesFor({ host: 'opencode.ai', address: '1.2.3.4' }))} t={t} />)
    await screen.findByText('1.2.3.4')
    // And the field carries it, so the address can be edited rather than
    // retyped.
    const field = screen.getByLabelText('Fixed IP') as HTMLInputElement
    expect(field.value).toBe('1.2.3.4')
  })

  it('says when the address was found to be gone', async () => {
    render(<Section controller={new SectionController(servicesFor({ host: 'opencode.ai', address: '1.2.3.4', failed: true }))} t={t} />)
    await screen.findByText('Unreachable — using the system DNS')
  })

  it('offers a field for the address', async () => {
    render(<Section controller={new SectionController(servicesFor({ host: 'opencode.ai' }))} t={t} />)
    await screen.findByText('Fixed IP')
    const field = screen.getByLabelText('Fixed IP') as HTMLInputElement
    expect(field.getAttribute('type')).toBe('text')
    expect(screen.getByText('Save address')).toBeTruthy()
    expect(screen.getByText('Remove address')).toBeTruthy()
  })
})
