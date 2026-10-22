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

import { useCallback, useEffect, useMemo, useState } from 'react'
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
 * and shows everything.
 */
export type RequestLogProps = RequestLogFace & {
  /** The session this window belongs to, when it belongs to one. */
  readonly sessionId?: string
}

type ResultFilter = 'all' | 'ok' | 'fail'
type GroupBy = 'none' | 'session' | 'model' | 'result'

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
export function RequestLogPage({ readLog, enabled, t, getLocale, sessionId }: RequestLogProps): React.JSX.Element {
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
  // The in-conversation window shows one session by default. The common log
  // keeps only the first eight characters of a session id, and the debug log
  // keeps all of it, so a prefix matches either.
  const sessionPrefix = sessionId === undefined ? '' : sessionId.slice(0, 8)
  const [onlySession, setOnlySession] = useState(sessionPrefix !== '')

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
      if (onlySession && sessionPrefix !== '' && !entry.session.startsWith(sessionPrefix)) return false
      if (query !== '' && !entry.session.includes(query)) return false
      return true
    })
  }, [snapshot, model, result, slowOnly, slowSeconds, sessionQuery, onlySession, sessionPrefix])

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pages - 1)
  const pageEntries = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  const failures = filtered.filter(entry => !entry.ok).length
  const meanLatency = average(filtered.flatMap(entry => entry.durationMs === undefined ? [] : [entry.durationMs]))
  const meanFirstToken = average(filtered.flatMap(entry => entry.firstTokenMs === undefined ? [] : [entry.firstTokenMs]))
  const meanTps = average(filtered.flatMap(entry => entry.tps === undefined ? [] : [entry.tps]))
  // The reuse share is a property of the process, not of the filter: it counts
  // sockets against every request the Host has served.
  const reuse = snapshot !== undefined && snapshot.totalRecords > 0
    ? Math.max(0, Math.min(1, 1 - snapshot.newConnections / snapshot.totalRecords))
    : undefined

  const rows = (): React.JSX.Element[] => {
    const out: React.JSX.Element[] = []
    let lastGroup: string | undefined
    for (const entry of pageEntries) {
      const group = groupKey(entry, groupBy)
      if (group !== undefined && group !== lastGroup) {
        lastGroup = group
        out.push(
          <tr key={`group-${group}-${entry.seq}`} className={css.group}>
            <td colSpan={10}>{group}</td>
          </tr>,
        )
      }
      const state = !entry.ok ? 'rowFail' : (entry.tps !== undefined && entry.tps < 5 ? 'rowSlow' : 'rowOk')
      out.push(
        <tr
          key={entry.seq}
          className={`${css.row} ${css[state]}`}
          onClick={() => { setExpanded(expanded === entry.seq ? null : entry.seq) }}
        >
          <td>{new Date(entry.atMs).toLocaleTimeString(getLocale(), { hour12: false })}</td>
          <td className={css.mono}>{entry.model}</td>
          <td className={css.mono}>{entry.session === '' ? '—' : entry.session}</td>
          <td>{count(entry.inputTokens)}</td>
          <td>{count(entry.outputTokens)}</td>
          <td>{count(entry.cacheReadTokens)}</td>
          <td>{rate(entry.tps)}</td>
          <td>{duration(entry.firstTokenMs)}</td>
          <td>{duration(entry.durationMs)}</td>
          <td>{entry.ok ? (entry.status === undefined ? '✓' : String(entry.status)) : (entry.code ?? '✗')}</td>
        </tr>,
      )
      if (expanded === entry.seq) {
        out.push(
          <tr key={`detail-${entry.seq}`} className={css.detail}>
            <td colSpan={10}>
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
                  <span className={`${css.detailValue} ${css.mono}`}>{entry.session === '' ? '—' : entry.session}</span>
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
    <div className={css.page}>
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
          {sessionPrefix !== '' && (
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

      <div className={css.tableWrap}>
        {filtered.length === 0
          ? <p className={css.empty}>{t('requestLogEmpty')}</p>
          : (
            <table className={css.table}>
              <thead>
                <tr>
                  <th>{t('requestLogColTime')}</th>
                  <th>{t('requestLogColModel')}</th>
                  <th>{t('requestLogColSession')}</th>
                  <th>{t('requestLogColIn')}</th>
                  <th>{t('requestLogColOut')}</th>
                  <th>{t('requestLogColCache')}</th>
                  <th>{t('requestLogColTps')}</th>
                  <th>{t('requestLogColFirstToken')}</th>
                  <th>{t('requestLogColLatency')}</th>
                  <th>{t('requestLogColStatus')}</th>
                </tr>
              </thead>
              <tbody>{rows()}</tbody>
            </table>
          )}
      </div>

      <div className={css.foot}>
        <span>{`${filtered.length.toLocaleString(getLocale())} / ${(snapshot?.totalRecords ?? 0).toLocaleString(getLocale())} ${t('requestLogStatRequests')}`}</span>
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
