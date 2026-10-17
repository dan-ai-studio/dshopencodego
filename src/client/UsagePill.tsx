/**
 * The in-conversation usage button.
 *
 * It shows two different truths side by side, and never blends them: the
 * gateway's quota windows (percentages it publishes) and the token counts this
 * process actually spent (which the gateway does not publish). A failed refresh
 * keeps the last reading and says it is stale, unless the Host reports that the
 * account changed — then the old numbers describe someone else's account and
 * are dropped.
 *
 * @module @dan-ai-studio/dshopencodego/client/UsagePill
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { GoMeter, GoUsageWindows } from '../usage/contract.ts'
import css from './pill.module.css'

/** Everything the slot injects into one pill instance. */
export interface UsagePillInjected {
  /** Live model directory, used to mount only for the OpenCode Go route. */
  readonly directory: SnapshotStore<ModelDirectoryState>
  readonly readWindows: () => Promise<GoUsageWindows>
  readonly readMeter: () => Promise<GoMeter>
  readonly t: (key: string) => string
  readonly getLocale?: () => string
}

interface Failure {
  readonly message: string
  readonly retainPrevious: boolean
  readonly source?: string
}

/** Only the Host's domain failure is approved for display. */
function failureOf(error: unknown): Failure {
  if (error !== null && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'dshopencodego/usage-unavailable') {
    const details = (error as { details?: unknown }).details
    const record = details !== null && typeof details === 'object' ? details as Record<string, unknown> : {}
    return {
      message: typeof (error as unknown as { message?: unknown }).message === 'string'
        ? (error as unknown as { message: string }).message
        : '',
      retainPrevious: record['retryable'] === true && record['retainPrevious'] === true,
      ...typeof record['source'] === 'string' ? { source: record['source'] } : {},
    }
  }
  return { message: '', retainPrevious: false }
}

/** Poll interval for the account reading; the meter is local and free. */
const POLL_MS = 60_000

/**
 * How many unpriced model ids the panel names before it stops listing them.
 * The count is the fact that matters; the ids are the way to act on it.
 */
const MAX_UNPRICED_IDS = 3

/**
 * Render an estimate without ever rounding it into "free".
 *
 * `$0.00` is reserved for a real zero — a priced model that spent nothing —
 * while anything too small to show at four decimals says so instead of
 * collapsing to a zero that reads as "this cost nothing".
 * @param value - the estimate in USD.
 * @returns the display string.
 */
function formatUSD(value: number): string {
  if (value === 0) return '$0.0000'
  if (value < 0.0001) return '<$0.0001'
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

/**
 * Mount the pill only while the conversation's selected provider is this route.
 */
export function UsagePill({ directory, ...rest }: UsagePillInjected): React.JSX.Element | null {
  const state = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot)
  return state.current?.provider === 'opencode-go' ? <ActiveUsage {...rest} /> : null
}

function ActiveUsage({
  readWindows,
  readMeter,
  t,
  getLocale,
}: Omit<UsagePillInjected, 'directory'>): React.JSX.Element {
  const [windows, setWindows] = useState<GoUsageWindows | undefined>(undefined)
  const [meter, setMeter] = useState<GoMeter | undefined>(undefined)
  const [failure, setFailure] = useState<Failure | undefined>(undefined)
  const [updatedAt, setUpdatedAt] = useState<number | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      const [nextWindows, nextMeter] = await Promise.all([readWindows(), readMeter()])
      setWindows(nextWindows)
      setMeter(nextMeter)
      setFailure(undefined)
      setUpdatedAt(Date.now())
    } catch (error: unknown) {
      const failure = failureOf(error)
      setFailure(failure)
      // A reading from a different account must not be shown as this one's.
      if (!failure.retainPrevious) {
        setWindows(undefined)
        setUpdatedAt(undefined)
      }
    } finally {
      setRefreshing(false)
    }
  }, [readWindows, readMeter])

  useEffect(() => {
    let alive = true
    const run = (): void => {
      if (!alive || document.visibilityState === 'hidden') return
      void refresh()
    }
    run()
    const timer = setInterval(run, POLL_MS)
    document.addEventListener('visibilitychange', run)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', run)
    }
  }, [refresh])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const label = windows === undefined
    ? `Go · ${failure === undefined ? '…' : t('usageUnavailable')}`
    : `Go · ${t('usageRolling')} ${windows.rolling.percent}% · ${t('usageWeekly')} ${windows.weekly.percent}%`
      + (failure === undefined ? '' : ` · ${t('usageStale')}`)

  // A model the catalog priced nothing for is named rather than folded into the
  // estimate: the spend line covers the priced tokens only, and this is how the
  // panel says which ones those are.
  const unpriced = (meter?.models ?? []).filter(entry => entry.estimatedUSD === undefined)
  const unpricedModels = unpriced.slice(0, MAX_UNPRICED_IDS).map(entry => entry.model).join(', ')
    + (unpriced.length > MAX_UNPRICED_IDS ? ` +${unpriced.length - MAX_UNPRICED_IDS}` : '')

  return <span className={css.root} ref={root}>
    <button
      type="button"
      className={css.trigger}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={`${t('usageTitle')}: ${label}`}
      onClick={() => { setOpen(!open) }}
    >{label}</button>
    {open && <div className={css.panel} role="dialog" aria-label={t('usageTitle')} aria-busy={refreshing}>
      <strong>{t('usageTitle')}</strong>
      {failure !== undefined && <div className={css.warning} role="alert">
        <div><strong>{t('usageUnavailable')}</strong></div>
        {failure.message.length > 0 && <div>{failure.message}</div>}
        {windows !== undefined && <div>{t('usageStale')}</div>}
      </div>}
      {windows === undefined && failure === undefined && <p className={css.hint}>{t('usageLoading')}</p>}
      {windows !== undefined && ([['rolling', 'usageRolling'], ['weekly', 'usageWeekly'], ['monthly', 'usageMonthly']] as const)
        .map(([key, label]) => <div className={css.window} key={key}>
          <div className={css.row}><span>{t(label)}</span><strong>{windows[key].percent}%</strong></div>
          <progress className={css.progress} max={100} value={Math.min(100, windows[key].percent)} aria-label={t(label)} />
          <div className={css.hint}>{t('usageResets')} {new Date(windows[key].resetsAt).toLocaleString(getLocale?.())}</div>
          {windows[key].status === 'rate-limited' && <div className={css.limited}>{t('usageLimited')}</div>}
        </div>)}
      {meter !== undefined && <div className={css.local}>
        <strong>{t('usageSinceBoot')}</strong>
        <div className={css.row}>
          <span>{t('usageCallsUnit')}</span>
          <strong>{meter.totals.calls}</strong>
        </div>
        <div className={css.row}>
          <span>{t('usageTokensUnit')}</span>
          <strong>{meter.totals.totalTokens.toLocaleString(getLocale?.())}</strong>
        </div>
        <div className={css.row}>
          <span>{t('usageCached')}</span>
          <strong>{meter.totals.cacheReadTokens.toLocaleString(getLocale?.())}</strong>
        </div>
        {meter.totals.reasoningTokens !== undefined && <div className={css.row}>
          <span>{t('usageReasoning')}</span>
          <strong>{meter.totals.reasoningTokens.toLocaleString(getLocale?.())}</strong>
        </div>}
        <div className={css.row}>
          <span>{t('usageSpend')}</span>
          <strong>{meter.totals.estimatedUSD === undefined
            ? t('usageUnpriced')
            : formatUSD(meter.totals.estimatedUSD)}</strong>
        </div>
        {meter.totals.unpricedTokens !== undefined && <div className={css.hint}>
          {t('usageSpendPartial')} {meter.totals.unpricedTokens.toLocaleString(getLocale?.())}
        </div>}
        {unpriced.length > 0 && <div className={css.hint}>
          {t('usageUnpricedModels')} {unpricedModels}
        </div>}
        <p className={css.hint}>{t('usageSpendHint')}</p>
        <p className={css.hint}>{t('usageLocalHint')}</p>
      </div>}
      {updatedAt !== undefined && <p className={css.hint}>{t('usageLastUpdated')} {new Date(updatedAt).toLocaleString(getLocale?.())}</p>}
      <button type="button" className={css.retry} disabled={refreshing} onClick={() => { void refresh() }}>
        {t(refreshing ? 'usageRefreshing' : 'usageRetry')}
      </button>
    </div>}
  </span>
}
