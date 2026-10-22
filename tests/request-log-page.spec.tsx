// @vitest-environment jsdom
/**
 * The request-log page: the numbers it shows and the filters it applies.
 *
 * The page is rendered, not merely described — a log page that shows the
 * wrong column is worse than no log page, and only a rendered row proves
 * what a person actually reads.
 *
 * The table is addressed through its own role, because the same words also
 * appear in the filter dropdowns and in the summary cards: a test that
 * matched them loosely would pass on a page that shows the wrong row.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RequestLogPage } from '../src/client/RequestLogPage.tsx'
import type { RequestLogFace } from '../src/client/RequestLogPage.tsx'
import { en } from '../src/client/locales.ts'
import type { RequestLogEntry, RequestLogSnapshot } from '../src/request-log/contract.ts'

const t = (key: string): string => (en as Record<string, string>)[key] ?? key

/** One recorded request. */
function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    seq: 1,
    atMs: Date.UTC(2026, 0, 1, 12, 0, 0),
    model: 'glm-5.3',
    session: 'session-a',
    method: 'POST',
    url: 'https://opencode.ai/inference/go/v1/chat/completions',
    status: 200,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    durationMs: 2_000,
    firstTokenMs: 400,
    decodeMs: 1_600,
    tps: 31.25,
    ok: true,
    shape: { messages: 2, hasImage: false, tools: 1 },
    ...overrides,
  }
}

/** A snapshot with the given entries. */
function snapshotOf(entries: RequestLogEntry[]): RequestLogSnapshot {
  return {
    entries,
    poolEvents: [],
    totalRecords: entries.length,
    droppedRecords: 0,
    newConnections: 1,
  }
}

/** A face whose snapshot is fixed. */
function faceFor(snapshot: RequestLogSnapshot, enabled = true): RequestLogFace {
  return {
    readLog: async () => snapshot,
    enabled: () => enabled,
    t,
    getLocale: () => 'en',
  }
}

/** The table, once it has rows. */
async function table(): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = screen.getByRole('table')
    expect(found).toBeTruthy()
    return found
  })
}

/** The value card under one label. */
function card(label: string): string {
  return screen.getByText(label).parentElement?.textContent ?? ''
}

afterEach(() => { cleanup() })

describe('request-log page', () => {
  it('shows the readings of every recorded request', async () => {
    render(<RequestLogPage {...faceFor(snapshotOf([entry()]))} />)
    const rows = await table()
    // The rate is a column of its own, not a detail behind a click: it is
    // the number a person reads while watching a reply stream.
    expect(within(rows).getByText('31.3')).toBeTruthy()
    expect(within(rows).getByText('2.00s')).toBeTruthy()
    expect(within(rows).getByText('400ms')).toBeTruthy()
    expect(within(rows).getByText('100')).toBeTruthy()
    expect(within(rows).getByText('50')).toBeTruthy()
    expect(within(rows).getByText('glm-5.3')).toBeTruthy()
  })

  it('summarises the filtered set', async () => {
    render(<RequestLogPage {...faceFor(snapshotOf([
      entry(),
      entry({ seq: 2, ok: false, code: 'TRANSPORT' }),
    ]))} />)
    await table()
    // One failed request of two.
    expect(card('Failures')).toContain('1')
    // The mean rate covers the request that reported one.
    expect(card('Mean tok/s')).toContain('31.3')
  })

  it('says so when the log is off', async () => {
    render(<RequestLogPage {...faceFor(snapshotOf([]), false)} />)
    await waitFor(() => { expect(screen.getByText('The request log is off.')).toBeTruthy() })
  })

  it('filters by model', async () => {
    render(<RequestLogPage {...faceFor(snapshotOf([
      entry(),
      entry({ seq: 2, model: 'kimi-k3' }),
    ]))} />)
    const rows = await table()
    fireEvent.change(screen.getByDisplayValue('All models'), { target: { value: 'kimi-k3' } })
    await waitFor(() => { expect(within(rows).queryByText('glm-5.3')).toBeNull() })
    expect(within(rows).getByText('kimi-k3')).toBeTruthy()
  })

  it('filters by result', async () => {
    render(<RequestLogPage {...faceFor(snapshotOf([
      entry(),
      entry({ seq: 2, ok: false, code: 'TIMEOUT' }),
    ]))} />)
    const rows = await table()
    fireEvent.change(screen.getByDisplayValue('All'), { target: { value: 'fail' } })
    await waitFor(() => { expect(within(rows).queryByText('200')).toBeNull() })
    expect(within(rows).getByText('TIMEOUT')).toBeTruthy()
  })

  it('shows one session when it is scoped to one', async () => {
    // Session ids are UUIDs; the common log keeps the first eight characters,
    // and that prefix is what a scoped window matches on.
    render(<RequestLogPage {...faceFor(snapshotOf([
      entry({ session: 'aaaaaaaa-1111' }),
      entry({ seq: 2, session: 'bbbbbbbb-2222' }),
    ]))} sessionId="aaaaaaaa-1111-2222-3333" />)
    const rows = await table()
    // The other session's row is filtered away by default.
    expect(within(rows).queryByText('bbbbbbbb-2222')).toBeNull()
    expect(within(rows).getByText('aaaaaaaa-1111')).toBeTruthy()
    expect(screen.getByText(/this session only/)).toBeTruthy()
  })

  it('expands one row into its request detail', async () => {
    render(<RequestLogPage {...faceFor(snapshotOf([entry()]))} />)
    const rows = await table()
    fireEvent.click(within(rows).getByText('glm-5.3'))
    await waitFor(() => {
      expect(within(rows).getByText('https://opencode.ai/inference/go/v1/chat/completions')).toBeTruthy()
    })
    expect(within(rows).getByText(/2 messages/)).toBeTruthy()
  })
})
