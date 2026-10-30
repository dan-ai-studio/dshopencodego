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
    canOpenSession: () => false,
    openSession: () => true,
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

/** A row for a request that has not finished: identity, no counts yet. */
function runningEntry(seq: number): RequestLogEntry {
  const next = entry({ seq, ok: false, running: true })
  // The store omits unreported fields rather than writing them as
  // undefined; the deletions below reproduce that shape.
  const record = next as unknown as Partial<Record<string, unknown>>
  for (const key of ['status', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'durationMs', 'firstTokenMs', 'decodeMs', 'tps']) {
    delete record[key]
  }
  return next
}

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

  it('names the session when the catalog knows it', async () => {
    // Rows spell the conversation's title; the full id stays one hover away.
    const useSessions = ((selector: (state: unknown) => unknown): unknown =>
      selector({ byId: { 'session-a': { title: '排查记录' } } })) as never
    const { container } = render(<RequestLogPage {...faceFor(snapshotOf([entry()]))} useSessions={useSessions} />)
    const rows = await table()
    const cell = within(rows).getByText('排查记录')
    expect(cell.getAttribute('title')).toBe('session-a')
    // The search box matches the title as well as the id.
    const search = container.querySelector('input[type="search"]')
    expect(search).not.toBeNull()
    fireEvent.change(search!, { target: { value: '排查' } })
    await waitFor(() => { expect(screen.getByText('排查记录')).toBeTruthy() })
    fireEvent.change(search!, { target: { value: 'zzz-no-such-session' } })
    await waitFor(() => { expect(screen.queryByText('排查记录')).toBeNull() })
  })

  it('opens the conversation when its title is clicked', async () => {
    const useSessions = ((selector: (state: unknown) => unknown): unknown =>
      selector({ byId: { 'session-a': { title: '排查记录' } } })) as never
    const opened: string[] = []
    render(<RequestLogPage
      {...faceFor(snapshotOf([entry()]))}
      useSessions={useSessions}
      canOpenSession={() => true}
      openSession={(id) => { opened.push(id); return true }}
    />)
    const rows = await table()
    fireEvent.click(within(rows).getByText('排查记录'))
    expect(opened).toEqual(['session-a'])
    expect(screen.queryByText(/archived/)).toBeNull()
  })

  it('says why when the session cannot be opened', async () => {
    const useSessions = ((selector: (state: unknown) => unknown): unknown =>
      selector({ byId: { 'session-a': { title: '排查记录' } } })) as never
    render(<RequestLogPage
      {...faceFor(snapshotOf([entry()]))}
      useSessions={useSessions}
      canOpenSession={() => true}
      openSession={() => false}
    />)
    const rows = await table()
    fireEvent.click(within(rows).getByText('排查记录'))
    await waitFor(() => { expect(screen.getByText('That session is archived and cannot be opened.')).toBeTruthy() })
  })

  it('falls back to the id when no catalog is injected', async () => {
    render(<RequestLogPage {...faceFor(snapshotOf([entry()]))} />)
    const rows = await table()
    expect(within(rows).getByText('session-a')).toBeTruthy()
  })

  it('tells shown-apart-from-total in the footer', async () => {
    const snapshot: RequestLogSnapshot = { ...snapshotOf([entry(), entry({ seq: 2 })]), totalRecords: 5 }
    render(<RequestLogPage {...faceFor(snapshot)} />)
    await table()
    // Two rows on the page, five records on the Host: the rest fell out of
    // the ring before this snapshot was read.
    expect(screen.getByText(/Requests: 2 \(of 5\)/)).toBeTruthy()
  })

  it('shows no total when nothing fell out', async () => {
    render(<RequestLogPage {...faceFor(snapshotOf([entry()]))} />)
    await table()
    expect(screen.getByText('Requests: 1')).toBeTruthy()
    // The pager ("1 of 1") is not a total: only the footer's parenthetical counts.
    expect(screen.queryByText(/\(of/)).toBeNull()
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

  it('shows a running request without counting it as a failure', async () => {
    // A request that has not finished reports no counts yet — and must
    // neither inflate the failure card nor appear under the fail filter.
    render(<RequestLogPage {...faceFor(snapshotOf([
      runningEntry(1),
      entry({ seq: 2, model: 'other-model', ok: false, code: 'TRANSPORT' }),
    ]))} />)
    const rows = await table()
    // The row names its state instead of failing.
    expect(within(rows).getByText(/Requesting/)).toBeTruthy()
    // One real failure of two rows: the running one is not counted.
    expect(card('Failures')).toContain('1')
    // And the fail filter hides the running row.
    fireEvent.change(screen.getByDisplayValue('All'), { target: { value: 'fail' } })
    await waitFor(() => { expect(within(rows).queryByText('glm-5.3')).toBeNull() })
    expect(within(rows).getByText('TRANSPORT')).toBeTruthy()
  })

  it('groups a running request on its own', async () => {
    render(<RequestLogPage {...faceFor(snapshotOf([
      runningEntry(1),
      entry({ seq: 2, ok: false, code: 'TIMEOUT' }),
    ]))} />)
    await table()
    fireEvent.change(screen.getByDisplayValue('None'), { target: { value: 'result' } })
    // The running header is the translated word, not a code.
    await waitFor(() => { expect(screen.getByText('Requesting')).toBeTruthy() })
  })

  it('shows one session when it is scoped to one', async () => {
    // Sessions are stored whole, so the scoped window matches exactly — a
    // prefix could also catch a different conversation.
    render(<RequestLogPage {...faceFor(snapshotOf([
      entry({ session: 'aaaaaaaa-1111-2222-3333' }),
      entry({ seq: 2, session: 'bbbbbbbb-2222-3333-4444' }),
    ]))} sessionId="aaaaaaaa-1111-2222-3333" />)
    const rows = await table()
    // The other session's row is filtered away by default.
    expect(within(rows).queryByText('bbbbbbbb-2222-3333-4444')).toBeNull()
    expect(within(rows).getByText('aaaaaaaa-1111-2222-3333')).toBeTruthy()
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

  it('shows the protocol, price, and reasoning split in the detail', async () => {
    render(<RequestLogPage {...faceFor(snapshotOf([entry({
      protocol: 'openai-responses',
      reasoningTokens: 120,
      cacheWriteTokens: 7,
      costUsd: 0.00130654,
      requestBytes: 3_621_468,
      streamMs: 120,
    })]))} />)
    const rows = await table()
    fireEvent.click(within(rows).getByText('glm-5.3'))
    await waitFor(() => {
      expect(within(rows).getByText('openai-responses')).toBeTruthy()
    })
    expect(within(rows).getByText(/Reasoning 120/)).toBeTruthy()
    expect(within(rows).getByText(/Cache write 7/)).toBeTruthy()
    expect(within(rows).getByText('$0.001307')).toBeTruthy()
    expect(within(rows).getByText('3.45 MB')).toBeTruthy()
  })

  it('shows the preparation split in the detail', async () => {
    render(<RequestLogPage {...faceFor(snapshotOf([entry({ prepMs: 1234 })]))} />)
    const rows = await table()
    fireEvent.click(within(rows).getByText('glm-5.3'))
    await waitFor(() => {
      expect(within(rows).getByText('Preparation')).toBeTruthy()
    })
    expect(within(rows).getByText('1.23s')).toBeTruthy()
  })

  it('splits the wire body into text and images in the detail', async () => {
    render(<RequestLogPage {...faceFor(snapshotOf([entry({
      requestBytes: 3_000_000,
      imageBytes: 2_700_000,
    })]))} />)
    const rows = await table()
    fireEvent.click(within(rows).getByText('glm-5.3'))
    await waitFor(() => {
      // 300,000 residual bytes of text against 2,700,000 of images.
      expect(within(rows).getByText(/Text 293\.0 KB \/ Images 2\.57 MB/)).toBeTruthy()
    })
  })

  it('hides the split when the request carries no images', async () => {
    render(<RequestLogPage {...faceFor(snapshotOf([entry()]))} />)
    const rows = await table()
    fireEvent.click(within(rows).getByText('glm-5.3'))
    await waitFor(() => {
      expect(within(rows).getByText('https://opencode.ai/inference/go/v1/chat/completions')).toBeTruthy()
    })
    expect(within(rows).queryByText(/Images/)).toBeNull()
  })

  it('orders rows when a column head is clicked', async () => {
    // Newest first is the default; a click on Latency reorders slowest
    // first, and a second click flips it.
    const first = Date.UTC(2026, 0, 1, 12, 0, 0)
    render(<RequestLogPage {...faceFor(snapshotOf([
      entry({ seq: 1, model: 'slow-model', atMs: first, durationMs: 2_000 }),
      entry({ seq: 2, model: 'fast-model', atMs: first + 1_000, durationMs: 500 }),
    ]))} />)
    const rows = await table()
    const order = (): string[] => within(rows).getAllByRole('row').slice(1, 3)
      .map(row => within(row).getAllByRole('cell')[1]?.textContent ?? '')
    expect(order()).toEqual(['fast-model', 'slow-model'])
    fireEvent.click(screen.getByText(/Latency/))
    await waitFor(() => { expect(order()).toEqual(['slow-model', 'fast-model']) })
    // The flipped direction is marked on the head.
    expect(screen.getByText(/Latency ▼/)).toBeTruthy()
    fireEvent.click(screen.getByText(/Latency/))
    await waitFor(() => { expect(order()).toEqual(['fast-model', 'slow-model']) })
    expect(screen.getByText(/Latency ▲/)).toBeTruthy()
  })

  it('shows the cache-hit share of each request', async () => {
    // 20 cached of 120 input reads as 17%; a request that reported no
    // input has no share to show.
    const withoutInput = { ...entry({ seq: 2 }) }
    // The store omits unreported counts rather than writing them as
    // undefined; the deletion below reproduces that shape.
    delete (withoutInput as Partial<Record<'inputTokens' | 'cacheReadTokens', unknown>>).inputTokens
    delete (withoutInput as Partial<Record<'inputTokens' | 'cacheReadTokens', unknown>>).cacheReadTokens
    render(<RequestLogPage {...faceFor(snapshotOf([
      entry({ inputTokens: 100, cacheReadTokens: 20 }),
      withoutInput,
    ]))} />)
    const rows = await table()
    expect(within(rows).getByText('17%')).toBeTruthy()
    // The request that reported no input shows dashes instead of shares.
    expect(within(rows).getAllByText('—').length).toBeGreaterThan(0)
    // And the summary averages the ones that reported one.
    expect(card('Mean cache hit')).toContain('17%')
  })
})
