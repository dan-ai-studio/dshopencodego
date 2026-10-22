/**
 * Request-log viewer: a fullscreen dialog over the settings page.
 *
 * Everything here reads an already-fetched snapshot: filtering, grouping,
 * and pagination are memory operations over at most the configured bound
 * (default 200), so the viewer adds no request-path or wire cost beyond the
 * one snapshot read that opened it. Refresh is manual for the same reason.
 *
 * @module @dan-ai-studio/dshopencodego/client/RequestLogDialog
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RequestLogEntry, RequestLogSnapshot } from '../request-log/contract.ts'
import css from './request-log.module.css'

/** Everything the slot injects into one viewer instance. */
export interface RequestLogDialogInjected {
  /** Read one snapshot; the caller unwraps the Remote result. */
  readonly readLog: () => Promise<RequestLogSnapshot>
  /** Whether the profile records at all; false renders the off state. */
  readonly enabled: boolean
  readonly t: (key: string) => string
  readonly getLocale: (() => string) | undefined
  readonly onClose: () => void
}

type ResultFilter = 'all' | 'ok' | 'fail'
type GroupBy = 'none' | 'session' | 'model' | 'result'

/** Rows per page; the ring bound caps the whole viewer, this caps the DOM. */
const PAGE_SIZE = 50

function formatCount(value: number | undefined): string {
  if (value === undefined) return '—'
  return value.toLocaleString()
}

function formatMs(value: number | undefined): string {
  if (value === undefined) return '—'
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`
}

function formatTime(atMs: number, getLocale: (() => string) | undefined): string {
  return new Date(atMs).toLocaleTimeString(getLocale?.(), { hour12: false })
}

function statusOf(entry: RequestLogEntry): 'ok' | 'slow' | 'fail' | 'timeout' {
  if (!entry.ok) return entry.code === 'TIMEOUT' || entry.code === 'ABORTED' ? 'timeout' : 'fail'
  return 'ok'
}

function groupKey(entry: RequestLogEntry, groupBy: GroupBy): string | null {
  switch (groupBy) {
    case 'session': return entry.session === '' ? '—' : entry.session
    case 'model': return entry.model
    case 'result': return entry.ok ? 'ok' : (entry.code ?? 'fail')
    case 'none': return null
  }
}

export function RequestLogDialog({ readLog, enabled, t, getLocale, onClose }: RequestLogDialogInjected): React.JSX.Element | null {
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
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      setRefreshing(true)
      try {
        const next = await readLog()
        if (!alive) return
        setSnapshot(next)
        setFailure(undefined)
      } catch (error: unknown) {
        if (!alive) return
        setFailure(error instanceof Error ? error.message : String(error))
      } finally {
        if (alive) setRefreshing(false)
      }
    }
    void load()
    return () => { alive = false }
  }, [readLog])

  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) onClose()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [onClose])

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
      if (query !== '' && !entry.session.includes(query)) return false
      return true
    })
  }, [snapshot, model, result, slowOnly, slowSeconds, sessionQuery])

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pages - 1)
  const pageEntries = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  const reuse = snapshot !== undefined && snapshot.totalRecords > 0
    ? Math.max(0, Math.min(1, 1 - snapshot.newConnections / snapshot.totalRecords))
    : null

  /**
   * Page rows with group headers only where the group changes. Groups are
   * computed over the current page; the header names the group but makes no
   * claim about other pages.
   */
  const rows = (): React.JSX.Element[] => {
    const out: React.JSX.Element[] = []
    let lastGroup: string | null = null
    for (const entry of pageEntries) {
      const state = statusOf(entry)
      const slow = entry.ok && (entry.durationMs ?? 0) >= 5000
      const group = groupKey(entry, groupBy)
      if (group !== null && group !== lastGroup) {
        lastGroup = group
        out.push(
          <tr key={`group-${group}-${entry.seq}`} className={css.group}>
            <td colSpan={9}>{group}</td>
          </tr>,
        )
      }
      out.push(
        <tr
          key={entry.seq}
          className={`${css.row} ${state === 'ok' ? (slow ? css.rowSlow : css.rowOk) : state === 'timeout' ? css.rowSlow : css.rowFail}`}
          onClick={() => { setExpanded(expanded === entry.seq ? null : entry.seq) }}
        >
          <td>{formatTime(entry.atMs, getLocale)}</td>
          <td className={css.mono}>{entry.model}</td>
          <td className={css.mono}>{entry.session === '' ? '—' : entry.session}</td>
          <td>{formatCount(entry.inputTokens)}</td>
          <td>{formatCount(entry.outputTokens)}</td>
          <td>{formatCount(entry.cacheReadTokens)}</td>
          <td>{formatMs(entry.durationMs)}</td>
          <td>{formatMs(entry.firstTokenMs)}</td>
          <td>{entry.ok ? `${entry.status ?? ''}`.trim() || '✓' : (entry.code ?? '✗')}</td>
        </tr>,
      )
      if (expanded === entry.seq) {
        out.push(
          <tr key={`detail-${entry.seq}`} className={css.detail}>
            <td colSpan={9}>
              <div><strong>{t('requestLogDetailRequest')}</strong></div>
              <div>{`${t('requestLogDetailMethod')}: `}<span className={css.mono}>{entry.method}</span></div>
              <div>{`${t('requestLogDetailUrl')}: `}<span className={css.mono}>{entry.url}</span></div>
              <div>{`${t('requestLogDetailSession')}: `}<span className={css.mono}>{entry.session === '' ? '—' : entry.session}</span></div>
              {entry.poolKey !== undefined && <div>{`${t('requestLogDetailPool')}: `}<span className={css.mono}>{entry.poolKey}</span></div>}
              {entry.headers !== undefined && (entry.headers.session !== undefined || entry.headers.userAgent !== undefined) && (
                <div>{`${t('requestLogDetailHeaders')}: `}
                  <span className={css.mono}>
                    {[entry.headers.session, entry.headers.userAgent].filter(part => part !== undefined).join(' · ')}
                  </span>
                </div>
              )}
              <div>{`${t('requestLogDetailShape')}: `}{`${entry.shape?.messages ?? 0} ${t('requestLogDetailMessages')}`}
                {entry.shape !== undefined && entry.shape.tools > 0 && ` · ${entry.shape.tools} ${t('requestLogDetailTools')}`}
                {entry.shape?.hasImage === true && ` · ${t('requestLogDetailHasImage')}`}</div>
              <div><strong>{t('requestLogDetailTiming')}</strong></div>
              <div>{`${t('requestLogColLatency')}: ${formatMs(entry.durationMs)} · ${t('requestLogColFirstToken')}: ${formatMs(entry.firstTokenMs)}`}</div>
              <div><strong>{t('requestLogDetailResult')}</strong></div>
              <div>{`${t('requestLogColStatus')}: ${entry.status ?? '—'}`}
                {` · ${t('requestLogDetailTokens')}: ${formatCount(entry.inputTokens)} / ${formatCount(entry.outputTokens)} / ${formatCount(entry.cacheReadTokens)}`}
                {!entry.ok && entry.code !== undefined && ` · ${t('requestLogDetailError')}: ${entry.code}`}</div>
            </td>
          </tr>,
        )
      }
    }
    return out
  }

  return createPortal(
    <div className={css.overlay}>
      <div className={css.panel} ref={root} role="dialog" aria-label={t('requestLogTitle')} aria-busy={refreshing}>
        <div className={css.title}>
          <strong>{t('requestLogTitle')}</strong>
          {snapshot !== undefined && <span className={css.titleValue}>
            {`${snapshot.totalRecords.toLocaleString(getLocale?.())} · ${t('requestLogDropped')} ${snapshot.droppedRecords.toLocaleString(getLocale?.())}`}
          </span>}
          <button type="button" onClick={() => { setPage(0); setExpanded(null); void refresh() }} disabled={refreshing}>
            {t('requestLogRefresh')}
          </button>
          <button type="button" onClick={onClose}>{t('requestLogClose')}</button>
        </div>
        {!enabled && <p>{t('requestLogDisabled')}</p>}
        {enabled && failure !== undefined && <p role="alert">{failure}</p>}
        {enabled && snapshot !== undefined && reuse !== null && (
          <p title={t('requestLogReuseHint')}>
            {`${t('requestLogReuse')} ${(reuse * 100).toFixed(0)}%`}
            {snapshot.poolKey !== undefined && <span className={css.mono}> · {snapshot.poolKey}</span>}
          </p>
        )}
        {enabled && snapshot !== undefined && snapshot.poolEvents.length > 0 && (
          <p className={css.mono}>
            {snapshot.poolEvents.map(event =>
              `${new Date(event.atMs).toLocaleTimeString(getLocale?.(), { hour12: false })} ${event.type} ${event.key}`,
            ).join(' · ')}
          </p>
        )}
        <div className={css.controls}>
          <label>{`${t('requestLogFilterModel')} `}
            <select value={model} onChange={event => { setModel(event.target.value); setPage(0) }}>
              <option value="all">{t('requestLogFilterModelAll')}</option>
              {models.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
          <label>{`${t('requestLogFilterResult')} `}
            <select
              value={result}
              onChange={event => { setResult(event.target.value as ResultFilter); setPage(0) }}
            >
              <option value="all">{t('requestLogResultAll')}</option>
              <option value="ok">{t('requestLogResultOk')}</option>
              <option value="fail">{t('requestLogResultFail')}</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={slowOnly}
              onChange={event => { setSlowOnly(event.target.checked); setPage(0) }}
            />
            {` ${t('requestLogSlowOnly')} `}
            <input
              type="number"
              min={1}
              value={slowSeconds}
              disabled={!slowOnly}
              aria-label={t('requestLogSlowSeconds')}
              onChange={event => { setSlowSeconds(Number(event.target.value)); setPage(0) }}
            />
            {` ${t('requestLogSlowSeconds')}`}
          </label>
          <label>{`${t('requestLogFilterSession')} `}
            <input
              type="search"
              value={sessionQuery}
              onChange={event => { setSessionQuery(event.target.value); setPage(0) }}
            />
          </label>
          <label>{`${t('requestLogGroupBy')} `}
            <select value={groupBy} onChange={event => { setGroupBy(event.target.value as GroupBy); setPage(0) }}>
              <option value="none">{t('requestLogGroupNone')}</option>
              <option value="session">{t('requestLogGroupSession')}</option>
              <option value="model">{t('requestLogGroupModel')}</option>
              <option value="result">{t('requestLogGroupResult')}</option>
            </select>
          </label>
        </div>
        <div className={css.tableWrap}>
          {filtered.length === 0 ? <p>{t('requestLogEmpty')}</p> : (
            <table className={css.table}>
              <thead>
                <tr>
                  <th>{t('requestLogColTime')}</th>
                  <th>{t('requestLogColModel')}</th>
                  <th>{t('requestLogColSession')}</th>
                  <th>{t('requestLogColIn')}</th>
                  <th>{t('requestLogColOut')}</th>
                  <th>{t('requestLogColCache')}</th>
                  <th>{t('requestLogColLatency')}</th>
                  <th>{t('requestLogColFirstToken')}</th>
                  <th>{t('requestLogColStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {rows()}
              </tbody>
            </table>
          )}
        </div>
        <div className={css.footer}>
          <div className={css.pager}>
            <button type="button" disabled={safePage <= 0} onClick={() => { setPage(safePage - 1) }}>{t('requestLogPagePrev')}</button>
            <span>{`${safePage + 1} ${t('requestLogPageOf')} ${pages}`}</span>
            <button type="button" disabled={safePage >= pages - 1} onClick={() => { setPage(safePage + 1) }}>{t('requestLogPageNext')}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )

  async function refresh(): Promise<void> {
    setRefreshing(true)
    try {
      setSnapshot(await readLog())
      setFailure(undefined)
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setRefreshing(false)
    }
  }
}
