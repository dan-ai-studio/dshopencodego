// @vitest-environment jsdom
/**
 * The settings page's per-model marks: declared capabilities as badges, the
 * declared input modalities on their own line, and silence left silent.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
      inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
      structuredOutput: true,
      temperature: true,
      openWeights: true,
    },
    // The document says nothing about this model's capabilities or inputs.
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

describe('settings model marks', () => {
  it('badges the declared capabilities', async () => {
    render(<Section controller={new SectionController(services)} t={t} />)
    expect(await screen.findByText('Structured · Temp · Open')).toBeTruthy()
  })

  it('lists the declared input modalities on their own line, and only where declared', async () => {
    render(<Section controller={new SectionController(services)} t={t} />)
    await screen.findByText('Silent Model')
    // Exact modality lines only: the sort picker's "Input price" option must
    // not count, and the model that declares nothing must show no line.
    const lines = screen.getAllByText(/^Input (Text|Image|Audio|Video|PDF)/)
    expect(lines).toHaveLength(1)
    expect(lines[0].textContent).toBe('Input Text · Image · Audio · Video · PDF')
  })
})
