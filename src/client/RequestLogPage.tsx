/**
 * The request-log page: a full-height column in the main panel.
 *
 * It is a page, not a dialog: the sidebar carries an entry for it, the main
 * column shows it, and the column's own height is the page's height. The
 * table scrolls inside the page; the head, the summary and the filters stay
 * where they are.
 *
 * Everything on this page reads one snapshot. The snapshot is read when the
 * page opens and when the reader asks for a refresh — and, while any row is
 * still running, every two seconds on its own, so a request is watched
 * while it runs. A page nobody opens costs nothing; a page with no running
 * row costs one read per manual refresh.
 *
 * @module @dan-ai-studio/dshopencodego/client/RequestLogPage
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RequestLogEntry, RequestLogSnapshot } from '../request-log/contract.ts'
// A value import: the viewer names a burst with the same line the meter
// withholds a rate on, so the two can never disagree on what "at once" is.
import { MIN_STREAM_MS_FOR_RATE } from '../request-log/store.ts'
import css from './request-log.module.css'

/** What the page reads from the Host. */
export interface RequestLogFace {
  /** Read one snapshot; the caller unwraps the Remote result. */
  readonly readLog: () => Promise<RequestLogSnapshot>
  /** Whether the profile records at all. */
  readonly enabled: () => boolean
  /** Whether a title click can open its session. */
  readonly canOpenSession: () => boolean
  /**
   * Select a session and show its conversation; false when there is no
   * navigation to open it with (or the session is archived), and then the
   * title stays text.
   */
  readonly openSession: (sessionId: string) => boolean
  /** The page's translator. */
  readonly t: (key: string) => string
  /** The active locale, for number and time formatting. */
  readonly getLocale: () => string
}

/** Everything the main-panel renderer hands the page. */
export type RequestLogPageProps = PropsRuntime<'main'> & InjectFace<RequestLogFace>

/**
 * The page's own props.
 *
 * `sessionId` is present only in the in-conversation window, where the page
 * shows one session's requests by default. The sidebar page has no session
 * and shows everything. `useSessions` arrives through the framework's own
 * standard props in both seats (they are global); absent in a composition
 * without a session list, and then every row falls back to its session id.
 */
export type RequestLogProps = RequestLogFace & {
  /** The session this window belongs to, when it belongs to one. */
  readonly sessionId?: string
  readonly useSessions?: UseSessionsHook
}

/** The session catalog, reduced to what a label needs. */
interface SessionCatalog {
  readonly byId: Readonly<Record<string, { readonly title?: string }>>
}

/**
 * The framework's session-list hook, reduced to the label's needs.
 *
 * Structural on purpose: the full session-controller types live in a
 * package this plugin does not depend on, and a label needs one optional
 * field. A real session list satisfies this shape.
 */
type UseSessionsHook = <V>(selector: (state: SessionCatalog) => V) => V

type ResultFilter = 'all' | 'ok' | 'fail'
type GroupBy = 'none' | 'session' | 'model' | 'result'

/** Every column a click on its head can order by. */
type SortKey =
  | 'atMs' | 'model' | 'session'
  | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheRate'
  | 'tps' | 'prepMs' | 'waitMs' | 'firstTokenMs' | 'durationMs' | 'status'

type SortDir = 'asc' | 'desc'

/**
 * The direction a column starts in: time and magnitudes read largest-first,
 * names read A-first. A second click on the same head flips it.
 */
const SORT_DEFAULT_DIR: Record<SortKey, SortDir> = {
  atMs: 'desc',
  model: 'asc',
  session: 'asc',
  inputTokens: 'desc',
  outputTokens: 'desc',
  cacheReadTokens: 'desc',
  cacheRate: 'desc',
  tps: 'desc',
  prepMs: 'desc',
  waitMs: 'desc',
  firstTokenMs: 'desc',
  durationMs: 'desc',
  status: 'asc',
}

/**
 * The value a column orders by. Unreported counts sort as -1 — below zero,
 * so they never outrank a reported one in either direction's spirit — and
 * the status orders by outcome first, then by its code or number.
 */
function sortValue(entry: RequestLogEntry, key: SortKey): string | number {
  switch (key) {
    case 'atMs': return entry.atMs
    case 'model': return entry.model
    case 'session': return entry.session
    case 'inputTokens': return entry.inputTokens ?? -1
    case 'outputTokens': return entry.outputTokens ?? -1
    case 'cacheReadTokens': return entry.cacheReadTokens ?? -1
    case 'cacheRate': return cacheRate(entry) ?? -1
    case 'tps': return entry.tps ?? -1
    case 'prepMs': return entry.prepMs ?? -1
    case 'waitMs': return waitMs(entry) ?? -1
    case 'firstTokenMs': return entry.firstTokenMs ?? -1
    case 'durationMs': return entry.durationMs ?? -1
    case 'status': return entry.running === true ? 'running' : entry.ok ? `ok-${entry.status ?? ''}` : `fail-${entry.code ?? ''}`
  }
}

/** Rows per page; the snapshot's own bound caps the whole table. */
const PAGE_SIZE = 50

/** One reading, or a dash when the provider never reported one. */
function count(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString()
}

/** A duration in the unit a person reads it in. */
function duration(value: number | undefined): string {
  if (value === undefined) return '—'
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(2)}s`
}

/** A rate, to one decimal. */
function rate(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(1)
}

/** Estimated USD, trimmed to cents and below. */
function cost(value: number | undefined): string {
  if (value === undefined) return '—'
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`
}

/** A byte count in the unit a person reads it in. */
function bytes(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * The wire body split into text and images: the image share is the
 * estimate the adapter recorded, the text share is whatever is left, so
 * the two always reconcile with the total. The estimate can only
 * understate images (raw-byte protocols, resized versions), never invent
 * bytes the wire did not carry.
 */
function contentSplit(entry: RequestLogEntry, text: string, images: string): string {
  const imageBytes = entry.imageBytes ?? 0
  const textBytes = entry.requestBytes === undefined ? undefined : Math.max(0, entry.requestBytes - imageBytes)
  return `${text} ${textBytes === undefined ? '—' : bytes(textBytes)} / ${images} ${bytes(imageBytes)}`
}

/**
 * The share of input tokens the provider served from cache.
 *
 * The adapter reports uncached input and cache reads separately, so the
 * total input is their sum. Undefined when the provider reported no input
 * at all: a share of nothing is not a share.
 */
function cacheRate(entry: RequestLogEntry): number | undefined {
  if (entry.inputTokens === undefined) return undefined
  const cached = entry.cacheReadTokens ?? 0
  const total = entry.inputTokens + cached
  return total > 0 ? cached / total : undefined
}

/** One labeled slice of a request's life, in milliseconds from its start. */
interface TimelineBlock {
  readonly kind: 'prep' | 'wait' | 'stream' | 'streamAlt'
  readonly label: string
  readonly from: number
  readonly to: number
}

/**
 * A request's life as labeled blocks plus its end — or nothing worth
 * drawing. Everything unreported stays out rather than invented: a row that
 * never reached the wire has no timeline, and an old row without a
 * preparation mark reads as one waiting stretch. A finished row whose first
 * token has no meaningful streaming phase after it is named a burst, so the
 * missing output slice reads as a shape rather than a hole.
 *
 * The streaming slice is cut at the recorded marks into alternating blocks,
 * so a stall mid-output reads as a gap rather than a uniformly slow bar.
 * Blocks are proportions of one delivery each, not categories: the legend
 * names each phase once no matter how many blocks it drew.
 */
function timelineOf(
  entry: RequestLogEntry,
  t: (key: string) => string,
): {
  readonly blocks: readonly TimelineBlock[]
  readonly end: number
  readonly burst: boolean
  readonly responseAt: number | undefined
  readonly streamTotal: number | undefined
} | undefined {
  const running = entry.running === true
  const end = entry.durationMs
    ?? (running ? Math.max(0, Date.now() - entry.atMs) : undefined)
  if (end === undefined || end <= 0) return undefined
  const prep = entry.prepMs
  const first = entry.firstTokenMs
  if (prep === undefined && first === undefined) return undefined
  const start = prep ?? 0
  const blocks: TimelineBlock[] = []
  if (prep !== undefined && prep > 0) {
    blocks.push({ kind: 'prep', label: t('requestLogDetailPrep'), from: 0, to: Math.min(prep, end) })
  }
  const responseAt = entry.responseMs === undefined ? undefined : Math.min(Math.max(entry.responseMs, 0), end)
  let streamTotal: number | undefined
  if (first !== undefined) {
    if (first > start) {
      blocks.push({
        kind: 'wait',
        label: t('requestLogTimelineWait'),
        from: Math.min(start, end),
        to: Math.min(first, end),
      })
    }
    if (entry.streamMs !== undefined && entry.streamMs > 0) {
      const last = Math.min(first + entry.streamMs, end)
      if (last > first) {
        const cuts = [first, ...(entry.streamMarksMs ?? []).filter(mark => mark > first && mark < last), last]
        for (let index = 0; index + 1 < cuts.length; index += 1) {
          const from = cuts[index]
          const to = cuts[index + 1]
          if (from === undefined || to === undefined) continue
          blocks.push({
            kind: index % 2 === 0 ? 'stream' : 'streamAlt',
            label: t('requestLogTimelineStream'),
            from,
            to,
          })
        }
        streamTotal = last - first
      }
    }
  }
  if (blocks.length === 0) return undefined
  return {
    blocks,
    end,
    burst: !running && first !== undefined
      && (entry.streamMs === undefined || entry.streamMs < MIN_STREAM_MS_FOR_RATE),
    responseAt,
    streamTotal,
  }
}

/** A share as whole percent, or a dash when it is unknown. */
function percent(value: number | undefined): string {
  return value === undefined ? '—' : `${(value * 100).toFixed(0)}%`
}

/**
 * The gateway-side wait: first token minus local preparation. Old rows
 * carry no preparation mark, so their whole first token counts as waiting —
 * the same fallback the timeline uses.
 */
function waitMs(entry: RequestLogEntry): number | undefined {
  if (entry.firstTokenMs === undefined) return undefined
  return Math.max(0, entry.firstTokenMs - (entry.prepMs ?? 0))
}

/** The mean of a set, or undefined when the set is empty. */
function average(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

/** The group a row belongs under, or nothing when rows are not grouped. */
function groupKey(entry: RequestLogEntry, groupBy: GroupBy): string | undefined {
  switch (groupBy) {
    case 'session': return entry.session === '' ? '—' : entry.session
    case 'model': return entry.model
    // A running row is neither a success nor a failure yet: it groups on
    // its own instead of inflating either outcome.
    case 'result': return entry.running === true ? 'running' : entry.ok ? 'ok' : (entry.code ?? 'fail')
    case 'none': return undefined
  }
}

/**
 * The request-log page.
 * @param props - the page's own face, and the session it is scoped to.
 * @returns the page.
 */
export function RequestLogPage({ readLog, enabled, canOpenSession, openSession, t, getLocale, sessionId, useSessions }: RequestLogProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<RequestLogSnapshot | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
  const [model, setModel] = useState('all')
  const [result, setResult] = useState<ResultFilter>('all')
  const [slowOnly, setSlowOnly] = useState(false)
  const [slowSeconds, setSlowSeconds] = useState(5)
  const [sessionQuery, setSessionQuery] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<number | null>(null)
  // A title click that lands nowhere would read as a dead button, so the
  // failure says why instead of staying silent.
  const [sessionOpenFailed, setSessionOpenFailed] = useState(false)
  // Newest first: the snapshot already arrives in that order.
  const [sortKey, setSortKey] = useState<SortKey>('atMs')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  // The in-conversation window shows one session by default. Sessions are
  // stored whole, so this is an exact match — no prefix that could also
  // catch a different conversation.
  const [onlySession, setOnlySession] = useState(sessionId !== undefined)
  // How tall the stuck control block is, so the sticky table head can sit
  // exactly beneath it in the in-conversation window (whose height is
  // unbounded). Measured live: the block wraps on narrow columns.
  const stuckRef = useRef<HTMLDivElement>(null)
  const [stuckTop, setStuckTop] = useState(0)
  useEffect(() => {
    const element = stuckRef.current
    if (element === null) return
    const measure = (): void => { setStuckTop(element.getBoundingClientRect().height) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])
  // Session titles from the catalog, so rows name the conversation instead
  // of spelling its id. Absent while the composition has no session list,
  // and then every row falls back to its id.
  const catalog = useSessions?.(state => state)
  const sessionLabel = useCallback((id: string): { readonly text: string; readonly titled: boolean } => {
    const title = catalog?.byId[id]?.title?.trim()
    return title === undefined || title === ''
      ? { text: id === '' ? '—' : id, titled: false }
      : { text: title, titled: true }
  }, [catalog])

  /** A result group header reads as a word, with the running group naming itself. */
  const resultGroupLabel = (group: string): string =>
    group === 'ok' ? t('requestLogResultOk')
    : group === 'fail' ? t('requestLogResultFail')
    : group === 'running' ? t('requestLogRunning')
    : group

  /** Order by a column: a new column starts in its reading direction. */
  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir(SORT_DEFAULT_DIR[key])
    }
    setPage(0)
    setExpanded(null)
  }

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      const next = await readLog()
      setSnapshot(next)
      setFailure(undefined)
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setRefreshing(false)
    }
  }, [readLog])

  useEffect(() => { void load() }, [load])

  // A running row is a live request: refresh it on its own until it
  // finishes, then stop — the interval dies with the last running row, and
  // with the page. Two seconds, not one: the page re-renders the whole
  // table per refresh, and second-level precision buys nothing here.
  // Manual refresh keeps working on top of this.
  const hasRunning = (snapshot?.entries ?? []).some(entry => entry.running === true)
  useEffect(() => {
    if (!hasRunning) return
    const timer = setInterval(() => { void load() }, 2000)
    return () => { clearInterval(timer) }
  }, [hasRunning, load])

  const models = useMemo(() => {
    const ids = new Set<string>()
    for (const entry of snapshot?.entries ?? []) ids.add(entry.model)
    return [...ids].toSorted()
  }, [snapshot])

  const filtered = useMemo(() => {
    const query = sessionQuery.trim()
    return (snapshot?.entries ?? []).filter(entry => {
      if (model !== 'all' && entry.model !== model) return false
      if (result === 'ok' && !entry.ok) return false
      if (result === 'fail' && (entry.ok || entry.running === true)) return false
      if (slowOnly && (entry.durationMs ?? 0) < Math.max(0, slowSeconds) * 1000) return false
      if (onlySession && sessionId !== undefined && entry.session !== sessionId) return false
      if (query !== '') {
        const label = sessionLabel(entry.session)
        // The search matches the id and, when the catalog knows it, the title.
        if (!entry.session.includes(query) && !(label.titled && label.text.includes(query))) return false
      }
      return true
    })
  }, [snapshot, model, result, slowOnly, slowSeconds, sessionQuery, onlySession, sessionId, sessionLabel])

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pages - 1)
  // The sort is stable, so ties keep the snapshot's newest-first order.
  const sorted = useMemo(() => {
    const next = [...filtered]
    next.sort((a, b) => {
      const first = sortValue(a, sortKey)
      const second = sortValue(b, sortKey)
      const compared = typeof first === 'number' && typeof second === 'number'
        ? first - second
        : String(first) < String(second) ? -1 : String(first) > String(second) ? 1 : 0
      return sortDir === 'asc' ? compared : -compared
    })
    return next
  }, [filtered, sortKey, sortDir])
  const pageEntries = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  // A running row is not a failure yet: it must not inflate the count or
  // the fail filter while it still runs.
  const failures = filtered.filter(entry => !entry.ok && entry.running !== true).length
  const meanLatency = average(filtered.flatMap(entry => entry.durationMs === undefined ? [] : [entry.durationMs]))
  const meanFirstToken = average(filtered.flatMap(entry => entry.firstTokenMs === undefined ? [] : [entry.firstTokenMs]))
  const meanTps = average(filtered.flatMap(entry => entry.tps === undefined ? [] : [entry.tps]))
  const meanCacheRate = average(filtered.flatMap(entry => {
    const value = cacheRate(entry)
    return value === undefined ? [] : [value]
  }))
  // The reuse share is a property of the process, not of the filter: it counts
  // sockets against every request the Host has served.
  const reuse = snapshot !== undefined && snapshot.totalRecords > 0
    ? Math.max(0, Math.min(1, 1 - snapshot.newConnections / snapshot.totalRecords))
    : undefined

  /**
   * One sortable head cell: the arrow names the direction, a click flips it.
   * @param key - the column this head orders by.
   * @param label - the translated column name.
   * @param hint - the hover text, when the name alone misleads.
   * @returns the head cell.
   */
  const head = (key: SortKey, label: string, hint?: string): React.JSX.Element => (
    <th className={css.thSortable} onClick={() => { toggleSort(key) }} title={hint}>
      {label}{sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  )

  const rows = (): React.JSX.Element[] => {
    const out: React.JSX.Element[] = []
    let lastGroup: string | undefined
    for (const entry of pageEntries) {
      const group = groupKey(entry, groupBy)
      if (group !== undefined && group !== lastGroup) {
        lastGroup = group
        out.push(
          <tr key={`group-${group}-${entry.seq}`} className={css.group}>
            {/* A session group names the conversation when the catalog knows it. */}
            {/* Result groups read as words, not codes; the running group names itself. */}
            <td colSpan={13}>{groupBy === 'session' ? sessionLabel(group).text : groupBy === 'result' ? resultGroupLabel(group) : group}</td>
          </tr>,
        )
      }
      const state = entry.running === true ? 'rowRunning' : !entry.ok ? 'rowFail' : (entry.tps !== undefined && entry.tps < 5 ? 'rowSlow' : 'rowOk')
      const session = sessionLabel(entry.session)
      out.push(
        <tr
          key={entry.seq}
          className={`${css.row} ${css[state]}`}
          onClick={() => { setExpanded(expanded === entry.seq ? null : entry.seq) }}
        >
          <td>{new Date(entry.atMs).toLocaleTimeString(getLocale(), { hour12: false })}</td>
          <td className={css.mono}>
            <span className={css.modelText} title={entry.model}>{entry.model}</span>
          </td>
          <td className={session.titled ? undefined : css.mono}>
            {session.titled && canOpenSession()
              ? (
                <button
                  type="button"
                  className={`${css.sessionLink} ${css.sessionText}`}
                  title={`${session.text} · ${entry.session}`}
                  onClick={() => { setSessionOpenFailed(!openSession(entry.session)) }}
                >
                  {session.text}
                </button>
              )
              : (
                <span
                  className={css.sessionText}
                  title={session.titled ? `${session.text} · ${entry.session}` : entry.session}
                >
                  {session.text}
                </span>
              )}
          </td>
          <td>{count(entry.inputTokens)}</td>
          <td>{count(entry.outputTokens)}</td>
          <td>{count(entry.cacheReadTokens)}</td>
          <td>{percent(cacheRate(entry))}</td>
          <td>{rate(entry.tps)}</td>
          <td>{duration(entry.prepMs)}</td>
          <td>{duration(waitMs(entry))}</td>
          <td>{duration(entry.firstTokenMs)}</td>
          <td>{entry.running === true ? duration(Math.max(0, Date.now() - entry.atMs)) : duration(entry.durationMs)}</td>
          <td>{entry.running === true ? `${t('requestLogRunning')} · ${duration(Math.max(0, Date.now() - entry.atMs))}` : entry.ok ? (entry.status === undefined ? '✓' : String(entry.status)) : (entry.code ?? '✗')}</td>
        </tr>,
      )
      if (expanded === entry.seq) {
        out.push(
          <tr key={`detail-${entry.seq}`} className={css.detail}>
            <td colSpan={13}>
              <div className={css.detailGrid}>
                {(() => {
                  const timeline = timelineOf(entry, t)
                  if (timeline === undefined) return null
                  // String, in practice: the classes exist, and the
                  // annotation stays honest about the index signature.
                  const kindClass = (kind: TimelineBlock['kind']): string | undefined =>
                    kind === 'prep' ? css.timelinePrep
                    : kind === 'wait' ? css.timelineWait
                    : kind === 'stream' ? css.timelineStream
                    : css.timelineStreamAlt
                  // One legend item per phase even when the bar drew several
                  // blocks for it: the two streaming shades share one entry,
                  // and the response tick names the gateway's answer inside
                  // the wait.
                  const legend: Array<{ key: string; swatch: string | undefined; text: string }> = []
                  const legendKey = (kind: TimelineBlock['kind']): string =>
                    kind === 'streamAlt' ? 'stream' : kind
                  for (const block of timeline.blocks) {
                    const key = legendKey(block.kind)
                    const seen = legend.some(item => item.key === key)
                    if (!seen) {
                      legend.push({
                        key,
                        swatch: kindClass(key as TimelineBlock['kind']),
                        text: `${block.label} ${duration(
                          timeline.blocks.filter(other => legendKey(other.kind) === key)
                            .reduce((sum, other) => sum + (other.to - other.from), 0),
                        )}`,
                      })
                    }
                  }
                  if (timeline.responseAt !== undefined) {
                    legend.push({
                      key: 'response',
                      swatch: css.timelineTickSwatch,
                      text: `${t('requestLogTimelineFirstByte')} ${duration(timeline.responseAt)}`,
                    })
                  }
                  legend.push({
                    key: 'total',
                    swatch: css.timelineTickSwatch,
                    text: `${t('requestLogColLatency')} ${duration(timeline.end)}`,
                  })
                  // Spoken as one sentence for readers who cannot see the
                  // bar: the legend below says the same thing in parts.
                  const spoken = legend.map(item => item.text).join(', ')
                  const percent = (at: number): string => `${((at / timeline.end) * 100).toFixed(2)}%`
                  return (
                    <div className={css.timeline} role="img" aria-label={spoken}>
                      <div className={css.timelineTrackWrap}>
                        <div className={css.timelineTrack}>
                          {timeline.blocks.map((block, index) => (
                            <div
                              key={`${block.kind}-${index}`}
                              className={`${css.timelineSeg} ${kindClass(block.kind)}`}
                              style={{
                                left: percent(block.from),
                                width: percent(Math.max(0, block.to - block.from)),
                              }}
                              title={`${block.label} ${duration(block.to - block.from)}`}
                            />
                          ))}
                          {timeline.responseAt !== undefined && (
                            <div
                              className={css.timelineRespTick}
                              style={{ left: percent(Math.min(timeline.responseAt, timeline.end)) }}
                              title={`${t('requestLogTimelineFirstByte')} ${duration(timeline.responseAt)}`}
                            />
                          )}
                          <div className={css.timelineMidTick} />
                          <div className={css.timelineTick} title={duration(timeline.end)} />
                        </div>
                        <div className={css.timelineMid} style={{ left: '50%' }} title={duration(timeline.end / 2)}>
                          {duration(timeline.end / 2)}
                        </div>
                      </div>
                      <div className={css.timelineLegend}>
                        {legend.map(item => (
                          <span key={item.key} className={css.timelineItem}>
                            <span className={`${css.timelineSwatch} ${item.swatch ?? ''}`} />
                            {item.text}
                          </span>
                        ))}
                        {timeline.burst && (
                          <span className={css.timelineItem}>{t('requestLogTimelineBurst')}</span>
                        )}
                      </div>
                    </div>
                  )
                })()}
                <div className={css.detailItem}>
                  <span className={css.detailLabel}>{t('requestLogDetailMethod')}</span>
                  <span className={`${css.detailValue} ${css.mono}`}>{entry.method}</span>
                </div>
                {entry.protocol !== undefined && (
                  <div className={css.detailItem}>
                    <span className={css.detailLabel}>{t('requestLogDetailProtocol')}</span>
                    <span className={`${css.detailValue} ${css.mono}`}>{entry.protocol}</span>
                  </div>
                )}
                <div className={css.detailItem}>
                  <span className={css.detailLabel}>{t('requestLogDetailUrl')}</span>
                  <span className={`${css.detailValue} ${css.mono}`}>{entry.url}</span>
                </div>
                {entry.requestBytes !== undefined && (
                  <div className={css.detailItem}>
                    <span className={css.detailLabel}>{t('requestLogDetailRequestBytes')}</span>
                    <span className={css.detailValue}>{bytes(entry.requestBytes)}</span>
                  </div>
                )}
                {entry.imageBytes !== undefined && entry.imageBytes > 0 && (
                  <div className={css.detailItem}>
                    <span className={css.detailLabel}>{t('requestLogDetailContentSplit')}</span>
                    <span className={css.detailValue}>
                      {contentSplit(entry, t('requestLogDetailText'), t('requestLogDetailImages'))}
                    </span>
                  </div>
                )}
                {entry.prepMs !== undefined && (
                  <div className={css.detailItem}>
                    <span className={css.detailLabel}>{t('requestLogDetailPrep')}</span>
                    <span className={css.detailValue}>{duration(entry.prepMs)}</span>
                  </div>
                )}
                <div className={css.detailItem}>
                  <span className={css.detailLabel}>{t('requestLogDetailSession')}</span>
                  <span
                    className={`${css.detailValue} ${session.titled ? '' : css.mono}`}
                    title={session.titled ? entry.session : undefined}
                  >
                    {session.titled ? `${session.text} · ${entry.session}` : session.text}
                  </span>
                </div>
                {entry.poolKey !== undefined && (
                  <div className={css.detailItem}>
                    <span className={css.detailLabel}>{t('requestLogDetailPool')}</span>
                    <span className={`${css.detailValue} ${css.mono}`}>{entry.poolKey}</span>
                  </div>
                )}
                {entry.headers !== undefined && (entry.headers.session !== undefined || entry.headers.userAgent !== undefined) && (
                  <div className={css.detailItem}>
                    <span className={css.detailLabel}>{t('requestLogDetailUserAgent')}</span>
                    <span className={`${css.detailValue} ${css.mono}`}>
                      {[entry.headers.session, entry.headers.userAgent].filter(part => part !== undefined).join(' · ')}
                    </span>
                  </div>
                )}
                <div className={css.detailItem}>
                  <span className={css.detailLabel}>{t('requestLogDetailShape')}</span>
                  <span className={css.detailValue}>
                    {`${entry.shape?.messages ?? 0} ${t('requestLogDetailMessages')}`}
                    {entry.shape !== undefined && entry.shape.tools > 0 && ` · ${entry.shape.tools} ${t('requestLogDetailTools')}`}
                    {entry.shape?.hasImage === true && ` · ${t('requestLogDetailHasImage')}`}
                  </span>
                </div>
                <div className={css.detailItem}>
                  <span className={css.detailLabel}>{t('requestLogDetailTokens')}</span>
                  <span className={css.detailValue}>
                    {`${count(entry.inputTokens)} / ${count(entry.outputTokens)} / ${count(entry.cacheReadTokens)}`}
                    {entry.cacheWriteTokens !== undefined && ` · ${t('requestLogDetailCacheWrite')} ${count(entry.cacheWriteTokens)}`}
                    {entry.reasoningTokens !== undefined && ` · ${t('requestLogDetailReasoning')} ${count(entry.reasoningTokens)}`}
                  </span>
                </div>
                {entry.costUsd !== undefined && (
                  <div className={css.detailItem}>
                    <span className={css.detailLabel}>{t('requestLogDetailCost')}</span>
                    <span className={css.detailValue}>{cost(entry.costUsd)}</span>
                  </div>
                )}
                <div className={css.detailItem}>
                  <span className={css.detailLabel}>{t('requestLogColCacheRate')}</span>
                  <span className={css.detailValue}>{percent(cacheRate(entry))}</span>
                </div>
                <div className={css.detailItem}>
                  <span className={css.detailLabel}>{t('requestLogColTps')}</span>
                  <span className={css.detailValue}>{rate(entry.tps)}</span>
                </div>
                {entry.streamMs !== undefined && entry.tps === undefined && (
                  <div className={css.detailItem}>
                    <span className={css.detailLabel}>{t('requestLogColStream')}</span>
                    <span className={css.detailValue}>{duration(entry.streamMs)}</span>
                  </div>
                )}
                {!entry.ok && entry.code !== undefined && (
                  <div className={css.detailItem}>
                    <span className={css.detailLabel}>{t('requestLogDetailError')}</span>
                    <span className={css.detailValue}>{entry.code}</span>
                  </div>
                )}
              </div>
            </td>
          </tr>,
        )
      }
    }
    return out
  }

  return (
    <div
      className={sessionId === undefined ? css.page : `${css.page} ${css.pageLoose}`}
      style={{ '--request-log-stuck': `${stuckTop}px` } as CSSProperties}
    >
      <div className={css.stuck} ref={stuckRef}>
        <div className={css.head}>
          <div className={css.headText}>
            <h1 className={css.title}>{t('requestLogTitle')}</h1>
            <p className={css.subtitle}>{t('requestLogPageHint')}</p>
          </div>
          <div className={css.headActions}>
            <button type="button" className={css.button} onClick={() => { void load() }} disabled={refreshing}>
              <IconRefreshOutlineRegular size={13} />
              {t('requestLogRefresh')}
            </button>
          </div>
        </div>

        {!enabled() && <p className={css.notice}>{t('requestLogDisabled')}</p>}
        {failure !== undefined && <p className={`${css.notice} ${css.noticeError}`}>{failure}</p>}
        {sessionOpenFailed && <p className={`${css.notice} ${css.noticeError}`}>{t('requestLogOpenSessionFailed')}</p>}

        <div className={css.summary}>
          <div className={css.card}>
            <span className={css.cardLabel}>{t('requestLogStatRequests')}</span>
            <span className={css.cardValue}>{filtered.length.toLocaleString(getLocale())}</span>
          </div>
          <div className={`${css.card} ${failures > 0 ? css.cardError : ''}`}>
            <span className={css.cardLabel}>{t('requestLogStatFailures')}</span>
            <span className={css.cardValue}>{failures.toLocaleString(getLocale())}</span>
          </div>
          <div className={css.card}>
            <span className={css.cardLabel}>{t('requestLogStatLatency')}</span>
            <span className={css.cardValue}>{duration(meanLatency)}</span>
          </div>
          <div className={css.card}>
            <span className={css.cardLabel}>{t('requestLogStatFirstToken')}</span>
            <span className={css.cardValue}>{duration(meanFirstToken)}</span>
          </div>
          <div className={css.card}>
            <span className={css.cardLabel}>{t('requestLogStatTps')}</span>
            <span className={css.cardValue}>{rate(meanTps)}</span>
          </div>
          <div className={css.card}>
            <span className={css.cardLabel}>{t('requestLogStatCacheRate')}</span>
            <span className={css.cardValue}>{percent(meanCacheRate)}</span>
          </div>
          <div className={css.card}>
            <span className={css.cardLabel}>{t('requestLogReuse')}</span>
            <span className={css.cardValue}>{reuse === undefined ? '—' : `${(reuse * 100).toFixed(0)}%`}</span>
          </div>
        </div>

        <div className={css.toolbar}>
          <label className={css.field}>
            {t('requestLogFilterModel')}
            <select
              className={css.select}
              value={model}
              onChange={event => { setModel(event.target.value); setPage(0) }}
            >
              <option value="all">{t('requestLogFilterModelAll')}</option>
              {models.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
          <label className={css.field}>
            {t('requestLogFilterResult')}
            <select
              className={css.select}
              value={result}
              onChange={event => { setResult(event.target.value as ResultFilter); setPage(0) }}
            >
              <option value="all">{t('requestLogResultAll')}</option>
              <option value="ok">{t('requestLogResultOk')}</option>
              <option value="fail">{t('requestLogResultFail')}</option>
            </select>
          </label>
          <label className={css.field}>
            <input
              className={css.checkbox}
              type="checkbox"
              checked={slowOnly}
              onChange={event => { setSlowOnly(event.target.checked); setPage(0) }}
            />
            {t('requestLogSlowOnly')}
            <input
              className={`${css.input} ${css.inputNumber}`}
              type="number"
              min={1}
              value={slowSeconds}
              disabled={!slowOnly}
              aria-label={t('requestLogSlowSeconds')}
              onChange={event => { setSlowSeconds(Number(event.target.value)); setPage(0) }}
            />
            {t('requestLogSlowSeconds')}
          </label>
          <label className={css.field}>
            {t('requestLogFilterSession')}
            {sessionId !== undefined && (
              <>
                <input
                  className={css.checkbox}
                  type="checkbox"
                  checked={onlySession}
                  onChange={event => { setOnlySession(event.target.checked); setPage(0) }}
                />
                {t('requestLogOnlySession')}
              </>
            )}
            <input
              className={css.input}
              type="search"
              value={sessionQuery}
              disabled={onlySession}
              onChange={event => { setSessionQuery(event.target.value); setPage(0) }}
            />
          </label>
          <label className={css.field}>
            {t('requestLogGroupBy')}
            <select
              className={css.select}
              value={groupBy}
              onChange={event => { setGroupBy(event.target.value as GroupBy); setPage(0) }}
            >
              <option value="none">{t('requestLogGroupNone')}</option>
              <option value="session">{t('requestLogGroupSession')}</option>
              <option value="model">{t('requestLogGroupModel')}</option>
              <option value="result">{t('requestLogGroupResult')}</option>
            </select>
          </label>
        </div>
      </div>

      <div className={css.tableWrap}>
        {filtered.length === 0
          ? <p className={css.empty}>{t('requestLogEmpty')}</p>
          : (
            <table className={css.table}>
              <thead>
                <tr>
                  {head('atMs', t('requestLogColTime'))}
                  {head('model', t('requestLogColModel'))}
                  {head('session', t('requestLogColSession'))}
                  {head('inputTokens', t('requestLogColIn'), t('requestLogColInHint'))}
                  {head('outputTokens', t('requestLogColOut'), t('requestLogColOutHint'))}
                  {head('cacheReadTokens', t('requestLogColCache'), t('requestLogColCacheHint'))}
                  {head('cacheRate', t('requestLogColCacheRate'))}
                  {head('tps', t('requestLogColTps'))}
                  {head('prepMs', t('requestLogColPrep'))}
                  {head('waitMs', t('requestLogColWait'))}
                  {head('firstTokenMs', t('requestLogColFirstToken'))}
                  {head('durationMs', t('requestLogColLatency'))}
                  {head('status', t('requestLogColStatus'))}
                </tr>
              </thead>
              <tbody>{rows()}</tbody>
            </table>
          )}
      </div>

      <div className={css.foot}>
        <span>
          {`${t('requestLogStatRequests')}: ${filtered.length.toLocaleString(getLocale())}`}
          {filtered.length !== (snapshot?.totalRecords ?? 0)
            ? ` (${t('requestLogOfTotal')} ${(snapshot?.totalRecords ?? 0).toLocaleString(getLocale())})`
            : ''}
        </span>
        <div className={css.pager}>
          <button type="button" className={css.button} disabled={safePage <= 0} onClick={() => { setPage(safePage - 1) }}>
            {t('requestLogPagePrev')}
          </button>
          <span>{`${safePage + 1} ${t('requestLogPageOf')} ${pages}`}</span>
          <button type="button" className={css.button} disabled={safePage >= pages - 1} onClick={() => { setPage(safePage + 1) }}>
            {t('requestLogPageNext')}
          </button>
        </div>
      </div>
    </div>
  )
}
