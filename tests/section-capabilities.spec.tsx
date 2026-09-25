// @vitest-environment jsdom
/**
 * The settings page's capability marks: a declared "yes" is labelled, an
 * undeclared capability leaves the cell empty, and neither view turns silence
 * into a denial.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { Section, SectionController } from '../src/client/Section.tsx'
import type { SectionServices } from '../src/client/Section.tsx'
import { en } from '../src/client/locales.ts'
import type { CatalogReading } from '../src/catalog/contract.ts'

const READING: CatalogReading = {
  models: [
    {
      id: 'glm-5.3',
      name: 'GLM-5.3',
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      releaseDate: '2026-08-14',
      structuredOutput: true,
      temperature: true,
      openWeights: true,
    },
    // The document says nothing about this model's capabilities.
    { id: 'silent-model', name: 'Silent Model', contextWindow: 1000, maxTokens: 100 },
  ],
  stale: false,
  fetchedAtMs: 1,
  counts: { total: 2, enabled: 2, deprecated: 0, unconfigured: 0, inferred: 0 },
}

const ok = <T,>(value: T): never => ({ ok: true, value }) as never

const services: SectionServices = {
  remote: {
    opencodeGoCatalog: { read: async () => ok(READING), refresh: async () => ok(READING) },
    credentials: {
      describe: async () => ok({}),
      set: async () => ok(undefined),
      unset: async () => ok(undefined),
    },
  },
  scope: undefined,
}

const t = (key: string): string => (en as Record<string, string>)[key] ?? key

afterEach(() => { cleanup() })

/** The capability cell of one table row; the header fixes the column order. */
function capabilityCell(name: string): string {
  const row = screen.getByText(name).closest('tr')
  if (row === null) throw new Error(`no table row for ${name}`)
  // toggle, model, id, released, context, in/out, price, quota, capabilities, notes
  return within(row).getAllByRole('cell')[8].textContent ?? ''
}

describe('settings capabilities', () => {
  it('marks the declared capabilities in the list view', async () => {
    render(<Section controller={new SectionController(services)} t={t} />)
    expect(await screen.findByText('Structured · Temp · Open')).toBeTruthy()
  })

  it('adds a capabilities column and leaves an undeclared model unmarked', async () => {
    render(<Section controller={new SectionController(services)} t={t} />)
    await screen.findByText('GLM-5.3')
    screen.getByRole('button', { name: en.viewTable }).click()
    expect(await screen.findByRole('columnheader', { name: en.headerCapabilities })).toBeTruthy()
    expect(capabilityCell('GLM-5.3')).toBe('Structured · Temp · Open')
    // Unstated is not "unsupported": the cell says nothing rather than a "no".
    expect(capabilityCell('Silent Model')).toBe('—')
  })
})
