/**
 * The request-log page: a full-height column in the main panel.
 *
 * It is a page, not a dialog: the sidebar carries an entry for it, the main
 * column shows it, and the column's own height is the page's height. The
 * table scrolls inside the page; the head, the summary and the filters stay
 * where they are.
 *
 * Everything on this page reads one snapshot. The snapshot is read when the
 * page opens and when the reader asks for a refresh — never polled — so a
 * page nobody opens costs nothing.
 *
 * @module @dan-ai-studio/dshopencodego/client/RequestLogPage
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RequestLogEntry, RequestLogSnapshot } from '../request-log/contract.ts'
import css from './request-log.module.css'

/** What the page reads from the Host. */
export interface RequestLogFace {
  /** Read one snapshot; the caller unwraps the Remote result. */
  readonly readLog: () => Promise<RequestLogSnapshot>
  /** Whether the profile records at all. */
  readonly enabled: () => boolean
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
  | 'tps' | 'firstTokenMs' | 'durationMs' | 'status'

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
    case 'firstTokenMs': return entry.firstTokenMs ?? -1
    case 'durationMs': return entry.durationMs ?? -1
    case 'status': return entry.ok ? `ok-${entry.status ?? ''}` : `fail-${entry.code ?? ''}`
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

/** A share as whole percent, or a dash when it is unknown. */
function percent(value: number | undefined): string {
  return value === undefined ? '—' : `${(value * 100).toFixed(0)}%`
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
    case 'result': return entry.ok ? 'ok' : (entry.code ?? 'fail')
    case 'none': return undefined
  }
}

/**
 * The request-log page.
 * @param props - the page's own face, and the session it is scoped to.
 * @returns the page.
 */
export function RequestLogPage({ readLog, enabled, t, getLocale, sessionId, useSessions }: RequestLogProps): React.JSX.Element {
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
      if (result === 'fail' && entry.ok) return false
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

  const failures = filtered.filter(entry => !entry.ok).length
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
   * @returns the head cell.
   */
  const head = (key: SortKey, label: string): React.JSX.Element => (
    <th className={css.thSortable} onClick={() => { toggleSort(key) }}>
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
            <td colSpan={11}>{groupBy === 'session' ? sessionLabel(group).text : group}</td>
          </tr>,
        )
      }
      const state = !entry.ok ? 'rowFail' : (entry.tps !== undefined && entry.tps < 5 ? 'rowSlow' : 'rowOk')
      const session = sessionLabel(entry.session)
      out.push(
        <tr
          key={entry.seq}
          className={`${css.row} ${css[state]}`}
          onClick={() => { setExpanded(expanded === entry.seq ? null : entry.seq) }}
        >
          <td>{new Date(entry.atMs).toLocaleTimeString(getLocale(), { hour12: false })}</td>
          <td className={css.mono}>{entry.model}</td>
          <td title={session.titled ? entry.session : undefined} className={session.titled ? undefined : css.mono}>
            {session.text}
          </td>
          <td>{count(entry.inputTokens)}</td>
          <td>{count(entry.outputTokens)}</td>
          <td>{count(entry.cacheReadTokens)}</td>
          <td>{percent(cacheRate(entry))}</td>
          <td>{rate(entry.tps)}</td>
          <td>{duration(entry.firstTokenMs)}</td>
          <td>{duration(entry.durationMs)}</td>
          <td>{entry.ok ? (entry.status === undefined ? '✓' : String(entry.status)) : (entry.code ?? '✗')}</td>
        </tr>,
      )
      if (expanded === entry.seq) {
        out.push(
          <tr key={`detail-${entry.seq}`} className={css.detail}>
            <td colSpan={11}>
              <div className={css.detailGrid}>
                <div className={css.detailItem}>
                  <span className={css.detailLabel}>{t('requestLogDetailMethod')}</span>
                  <span className={`${css.detailValue} ${css.mono}`}>{entry.method}</span>
                </div>
                <div className={css.detailItem}>
                  <span className={css.detailLabel}>{t('requestLogDetailUrl')}</span>
                  <span className={`${css.detailValue} ${css.mono}`}>{entry.url}</span>
                </div>
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
                  </span>
                </div>
                <div className={css.detailItem}>
                  <span className={css.detailLabel}>{t('requestLogColCacheRate')}</span>
                  <span className={css.detailValue}>{percent(cacheRate(entry))}</span>
                </div>
                <div className={css.detailItem}>
                  <span className={css.detailLabel}>{t('requestLogColTps')}</span>
                  <span className={css.detailValue}>{rate(entry.tps)}</span>
                </div>
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
                  {head('inputTokens', t('requestLogColIn'))}
                  {head('outputTokens', t('requestLogColOut'))}
                  {head('cacheReadTokens', t('requestLogColCache'))}
                  {head('cacheRate', t('requestLogColCacheRate'))}
                  {head('tps', t('requestLogColTps'))}
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
