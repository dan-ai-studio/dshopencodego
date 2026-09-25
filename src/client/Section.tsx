/**
 * The "OpenCode Go" settings page.
 *
 * It answers three questions in one place: is the route usable (credential
 * state), what does the gateway serve right now (the catalog reading, with the
 * refresh that bypasses the runtime cache), and how is each model called (the
 * protocol source, so an inferred guess is visible rather than silent). The
 * per-model switches and the refresh interval are written back through the
 * settings scope, which the page degrades out of when a composition has none.
 *
 * @module @dan-ai-studio/dshopencodego/client/Section
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CatalogReading } from '../catalog/contract.ts'
import { compactCount, INITIAL_FILTER, visibleModels } from './model-view.ts'
import type { ModelFilter, ModelSort } from './model-view.ts'
import css from './section.module.css'

/** Credential reference the route resolves. */
export const API_KEY_REF = 'OPENCODE_GO_API_KEY'

/** The settings fields this page owns. */
export interface SectionSettings {
  readonly modelVisibility: Record<string, boolean>
  readonly refreshMinutes: number
}

/** The read/write contract of the settings scope, structurally typed. */
export interface SettingsScopeLike {
  getSnapshot(): {
    readonly status: 'loading' | 'ready' | 'unavailable'
    readonly value: unknown
    readonly revision: number | undefined
    readonly writable: boolean
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void | boolean>
}

/** The subset of the client context this page uses. */
export interface SectionServices {
  readonly remote: {
    readonly opencodeGoCatalog: {
      read(): Promise<RemoteResult<CatalogReading>>
      refresh(): Promise<RemoteResult<CatalogReading>>
    }
    readonly credentials: {
      describe(refs: string[]): Promise<RemoteResult<Record<string, { configured: boolean }>>>
      set(ref: string, value: string): Promise<RemoteResult<unknown>>
      unset(ref: string): Promise<RemoteResult<unknown>>
    }
  }
  /** Absent in a composition without a settings surface: the page turns read-only. */
  readonly scope: SettingsScopeLike | undefined
}

/** Why a settings write did not land, in a form the page can translate. */
export type WriteFailure =
  | { readonly kind: 'rejected' }
  | { readonly kind: 'failed'; readonly message: string }

/** What the page renders. Fields are explicit about absence so a partial
 * update can clear one under `exactOptionalPropertyTypes`. */
export interface SectionState {
  readonly loading: boolean
  readonly reading: CatalogReading | undefined
  readonly keyConfigured: boolean | undefined
  /** Catalog-side trouble (read or refresh). */
  readonly failure: string | undefined
  /** Settings-write trouble, kept apart from the catalog's own status line. */
  readonly writeFailure: WriteFailure | undefined
  /** Set after a successful key write, so the button can confirm. */
  readonly saved: boolean | undefined
  readonly settings: SectionSettings | undefined
  readonly writable: boolean
  readonly saving: boolean
  /** The human's narrowing of the model table; never written to the Host. */
  readonly filter: ModelFilter
}

/** How long a burst of switch flips is coalesced before one settings write. */
export const VISIBILITY_WRITE_DELAY_MS = 250

const INITIAL: SectionState = {
  loading: true,
  reading: undefined,
  keyConfigured: undefined,
  failure: undefined,
  writeFailure: undefined,
  saved: undefined,
  settings: undefined,
  writable: false,
  saving: false,
  filter: INITIAL_FILTER,
}

/** Read the two fields this page owns out of a settings snapshot value. */
function settingsOf(value: unknown): SectionSettings | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const visibility = record['modelVisibility']
  const minutes = record['refreshMinutes']
  if (visibility === null || typeof visibility !== 'object' || typeof minutes !== 'number') return undefined
  const entries = Object.entries(visibility as Record<string, unknown>)
    .filter(([, enabled]) => typeof enabled === 'boolean')
  return {
    modelVisibility: Object.fromEntries(entries) as Record<string, boolean>,
    refreshMinutes: minutes,
  }
}

/** Owns the page's state and talks to the Host Remotes and the settings scope. */
export class SectionController {
  private state: SectionState = INITIAL
  private readonly listeners = new Set<() => void>()
  private readonly services: SectionServices
  private readonly disposers: Array<() => void> = []
  /** Latest visibility dict awaiting its coalesced write. */
  private pendingVisibility: Record<string, boolean> | undefined
  /** Timer of the coalescing window, when one is armed. */
  private visibilityTimer: ReturnType<typeof setTimeout> | undefined

  constructor(services: SectionServices) {
    this.services = services
    const scope = services.scope
    if (scope !== undefined) {
      const sync = (): void => {
        const snapshot = scope.getSnapshot()
        this.set({ settings: settingsOf(snapshot.value), writable: snapshot.writable })
      }
      sync()
      this.disposers.push(scope.subscribe(sync))
    }
    void this.load(false)
    void this.loadKey()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot = (): SectionState => this.state

  /** Drop every listener and scope subscription; the slot's effect calls this. */
  dispose(): void {
    this.listeners.clear()
    for (const dispose of this.disposers.splice(0)) dispose()
    // A coalesced write that is still waiting must reach the Host.
    const scope = this.services.scope
    if (this.visibilityTimer !== undefined && scope !== undefined) void this.flushVisibility(scope)
  }

  private set(next: Partial<SectionState>): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener()
  }

  /** Read the catalog, or revalidate it when `refresh` is set. */
  async load(refresh: boolean): Promise<void> {
    this.set({ loading: true, failure: undefined })
    try {
      const result = refresh
        ? await this.services.remote.opencodeGoCatalog.refresh()
        : await this.services.remote.opencodeGoCatalog.read()
      if (!result.ok) throw result.error
      this.set({ loading: false, reading: result.value, failure: undefined })
    } catch (error: unknown) {
      // A failed refresh keeps the previous reading visible and says why.
      this.set({
        loading: false,
        failure: error instanceof Error ? error.message : 'the catalog is unavailable',
      })
    }
  }

  async loadKey(): Promise<void> {
    try {
      const described = await this.services.remote.credentials.describe([API_KEY_REF])
      if (!described.ok) throw described.error
      this.set({ keyConfigured: described.value[API_KEY_REF]?.configured === true })
    } catch {
      // An undescribed credential is reported as unknown, never as absent.
      this.set({ keyConfigured: undefined })
    }
  }

  async saveKey(value: string): Promise<void> {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    const result = await this.services.remote.credentials.set(API_KEY_REF, trimmed)
    if (!result.ok) throw result.error
    this.set({ saved: true })
    await this.loadKey()
  }

  async clearKey(): Promise<void> {
    const result = await this.services.remote.credentials.unset(API_KEY_REF)
    if (!result.ok) throw result.error
    this.set({ saved: false })
    await this.loadKey()
  }

  /**
   * Flip one model's switch.
   *
   * The switch is published immediately and the write itself is coalesced, so
   * the UI never waits on the Host round trip and a burst of clicks becomes a
   * single write of the final dict.
   */
  setVisibility(id: string, enabled: boolean): void {
    this.mergeVisibility({ [id]: enabled })
  }

  /**
   * Set every configurable model at once (select-all / select-none).
   *
   * Select-all leaves deprecated models alone — they arrive switched off, and
   * a bulk action must not quietly re-enable a discontinued model. Select-none
   * clears everything, deprecated included.
   * @param enabled - the state the affected models should take.
   */
  setAllVisibility(enabled: boolean): void {
    const reading = this.state.reading
    if (reading === undefined) return
    const patch: Record<string, boolean> = {}
    for (const model of reading.models) {
      if (model.configurationMissing !== undefined) continue
      if (enabled && model.deprecated === true) continue
      patch[model.id] = enabled
    }
    this.mergeVisibility(patch)
  }

  /** Publish the merged dict locally, then schedule one coalesced write. */
  private mergeVisibility(patch: Record<string, boolean>): void {
    const scope = this.services.scope
    const current = this.state.settings
    if (scope === undefined || current === undefined || !this.state.writable) return
    const modelVisibility = { ...current.modelVisibility, ...patch }
    this.set({ settings: { ...current, modelVisibility }, writeFailure: undefined })
    this.pendingVisibility = modelVisibility
    if (this.visibilityTimer !== undefined) clearTimeout(this.visibilityTimer)
    this.visibilityTimer = setTimeout(() => { void this.flushVisibility(scope) }, VISIBILITY_WRITE_DELAY_MS)
  }

  /**
   * Write the pending dict once.
   *
   * A refusal is usually a revision conflict with another client — the form
   * has already reloaded the namespace by then — so one immediate retry
   * settles a lost race before the page tells a human something went wrong.
   * A persistent refusal, or a thrown call, surfaces as a failure and rolls
   * the optimistic dict back to what the Host reports.
   */
  private async flushVisibility(scope: SettingsScopeLike): Promise<void> {
    if (this.visibilityTimer !== undefined) {
      clearTimeout(this.visibilityTimer)
      this.visibilityTimer = undefined
    }
    const value = this.pendingVisibility
    this.pendingVisibility = undefined
    if (value === undefined) return
    this.set({ saving: true })
    try {
      let result = await scope.set('modelVisibility', value)
      if (result === false) result = await scope.set('modelVisibility', value)
      if (result === false) this.set({ writeFailure: { kind: 'rejected' } })
    } catch (error: unknown) {
      this.set({
        writeFailure: { kind: 'failed', message: error instanceof Error ? error.message : '' },
      })
      // The optimistic dict was never saved; go back to what the Host reports.
      this.set({ settings: settingsOf(scope.getSnapshot().value) })
    } finally {
      this.set({ saving: false })
    }
  }

  /** Narrow or reorder the model table; a view preference, never a write. */
  setFilter(patch: Partial<ModelFilter>): void {
    this.set({ filter: { ...this.state.filter, ...patch } })
  }

  /** Set the catalog cache lifetime, clamped to the schema's own bounds. */
  async setRefreshMinutes(minutes: number): Promise<void> {
    const scope = this.services.scope
    const current = this.state.settings
    if (scope === undefined || current === undefined || !this.state.writable) return
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) return
    await this.write(
      () => scope.set('refreshMinutes', minutes),
      () => this.set({ settings: { ...current, refreshMinutes: minutes } }),
    )
  }

  private async write(operation: () => Promise<void | boolean>, onAccepted?: () => void): Promise<void> {
    this.set({ saving: true })
    try {
      const result = await operation()
      // A `false` answer is a rejected write, not a saved one.
      if (result === false) this.set({ failure: 'the settings write was rejected' })
      else onAccepted?.()
    } finally {
      this.set({ saving: false })
    }
  }
}

/** Everything the slot injects into the page. */
export interface SectionInjected {
  readonly controller: SectionController
  readonly t: (key: string) => string
  readonly getLocale?: () => string
}

/** How a protocol decision is labelled for a human. */
function badgeFor(model: CatalogReading['models'][number], t: (key: string) => string): string {
  if (model.configurationMissing !== undefined) return `${t('catalogUnconfigured')}: ${model.configurationMissing}`
  if (model.protocolSource === 'inferred') return t('catalogInferred')
  if (model.assumedLimits === true) return t('catalogAssumed')
  if (model.deprecated === true) return t('catalogDeprecated')
  return ''
}

/** Whether one model is offered right now, under the switches in force. */
function isOffered(model: CatalogReading['models'][number], visibility: Record<string, boolean>): boolean {
  if (model.configurationMissing !== undefined) return false
  const explicit = Object.hasOwn(visibility, model.id) ? visibility[model.id] : undefined
  return typeof explicit === 'boolean' ? explicit : model.deprecated !== true
}

/** "in 922K · out 128K" — only the halves the sources state. */
function ioLabel(model: CatalogReading['models'][number], t: (key: string) => string): string {
  const parts: string[] = []
  if (model.maxInputTokens !== undefined) parts.push(`${t('iosInput')} ${compactCount(model.maxInputTokens)}`)
  if (model.maxTokens !== undefined) parts.push(`${t('iosOutput')} ${compactCount(model.maxTokens)}`)
  return parts.length === 0 ? '—' : parts.join(' · ')
}

/** "$0.15 / $0.60" per million tokens, when a rate is published. */
function priceLabel(model: CatalogReading['models'][number]): string {
  if (model.cost === undefined) return '—'
  return `$${model.cost.input} / $${model.cost.output}`
}

/** "$60 · 130K req/mo", or "unlimited" for the free model. */
function quotaLabel(model: CatalogReading['models'][number], t: (key: string) => string): string {
  const quota = model.goQuota
  if (quota === undefined) return '—'
  const usd = quota.monthlyUsd === 'unlimited' ? t('quotaUnlimited') : `$${quota.monthlyUsd}`
  if (quota.monthlyRequests === undefined) return usd
  const requests = quota.monthlyRequests === 'unlimited'
    ? t('quotaUnlimited')
    : `${compactCount(quota.monthlyRequests)} ${t('quotaPerMonth')}`
  return `${usd} · ${requests}`
}

/** The settings page. */
export function Section({ controller, t, getLocale }: SectionInjected): React.JSX.Element {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const act = useCallback(async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await operation()
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { setKeyDraft('') }, [state.saved])

  const reading = state.reading
  const visibility = state.settings?.modelVisibility ?? {}
  const editable = state.writable && state.settings !== undefined
  const rows = reading === undefined
    ? []
    : visibleModels(reading.models, state.filter, visibility, getLocale?.())
  const hidden = reading === undefined ? 0 : reading.models.length - rows.length
  return <section className={css.root}>
    <h2 className={css.title}>{t('nav')}</h2>
    <p className={css.hint}>{t('intro')}</p>

    <div className={css.block}>
      <div className={css.row}>
        <strong>{t('keyTitle')}</strong>
        <span className={state.keyConfigured === true ? css.ok : state.keyConfigured === false ? css.warn : css.hint}>
          {state.keyConfigured === true ? t('keyConfigured') : state.keyConfigured === false ? t('keyMissing') : '—'}
        </span>
      </div>
      <p className={css.hint}>{t('keyHint')}</p>
      <div className={css.row}>
        <input
          className={css.input}
          type="password"
          aria-label={t('keyTitle')}
          placeholder={t('keyPlaceholder')}
          value={keyDraft}
          onChange={event => { setKeyDraft(event.target.value) }}
        />
        <button type="button" className={css.button} disabled={busy || keyDraft.trim().length === 0}
          onClick={() => { void act(async () => { await controller.saveKey(keyDraft) }) }}>
          {state.saved === true ? t('keySaved') : t('keySave')}
        </button>
        <button type="button" className={css.button} disabled={busy || state.keyConfigured !== true}
          onClick={() => { void act(async () => { await controller.clearKey() }) }}>
          {t('keyClear')}
        </button>
      </div>
    </div>

    <div className={css.block}>
      <div className={css.row}>
        <strong>{t('catalogTitle')}</strong>
        <span className={css.hint}>
          {reading === undefined ? '—' : `${reading.counts.total} ${t('catalogCountUnit')} · ${reading.counts.enabled} ✓`
            + (reading.counts.inferred === 0 ? '' : ` · ${reading.counts.inferred} ${t('catalogInferred')}`)
            + (reading.counts.unconfigured === 0 ? '' : ` · ${reading.counts.unconfigured} ${t('catalogUnconfigured')}`)}
        </span>
        <button type="button" className={css.button} disabled={!editable || reading === undefined}
          onClick={() => { controller.setAllVisibility(true) }}>
          {t('catalogSelectAll')}
        </button>
        <button type="button" className={css.button} disabled={!editable || reading === undefined}
          onClick={() => { controller.setAllVisibility(false) }}>
          {t('catalogSelectNone')}
        </button>
        <button type="button" className={css.button} disabled={busy || state.loading}
          onClick={() => { void act(async () => { await controller.load(true) }) }}>
          {state.loading ? t('usageRefreshing') : t('catalogRefresh')}
        </button>
      </div>
      {state.failure !== undefined && <p className={css.warn}>{t('catalogStale')}: {state.failure}</p>}
      {reading !== undefined && reading.stale && state.failure === undefined && <p className={css.warn}>{t('catalogStale')}</p>}
      <div className={css.row}>
        <label className={css.hint} htmlFor="dshopencodego-refresh">{t('refreshLabel')}</label>
        <input
          id="dshopencodego-refresh"
          className={css.number}
          type="number"
          min={1}
          max={7 * 24 * 60}
          disabled={!editable || state.saving}
          value={state.settings?.refreshMinutes ?? ''}
          onChange={event => { void controller.setRefreshMinutes(Number(event.target.value)) }}
        />
        <span className={css.hint}>{t('refreshHint')}</span>
      </div>
      {state.writeFailure !== undefined && <p className={css.warn}>
        {state.writeFailure.kind === 'rejected'
          ? t('writeRejected')
          : state.writeFailure.message.length === 0
            ? t('writeFailed')
            : `${t('writeFailed')}: ${state.writeFailure.message}`}
      </p>}
      {reading !== undefined && <div className={css.row}>
        <input
          className={css.input}
          type="search"
          aria-label={t('filterPlaceholder')}
          placeholder={t('filterPlaceholder')}
          value={state.filter.query}
          onChange={event => { controller.setFilter({ query: event.target.value }) }}
        />
        <label className={css.hint}>
          <input
            type="checkbox"
            checked={state.filter.onlyEnabled}
            onChange={event => { controller.setFilter({ onlyEnabled: event.target.checked }) }}
          />
          {` ${t('filterOnlyEnabled')}`}
        </label>
        <label className={css.hint}>
          <input
            type="checkbox"
            checked={state.filter.showDeprecated}
            onChange={event => { controller.setFilter({ showDeprecated: event.target.checked }) }}
          />
          {` ${t('filterShowDeprecated')}`}
        </label>
        <label className={css.hint}>
          {`${t('sortLabel')} `}
          <select
            className={css.select}
            aria-label={t('sortLabel')}
            value={state.filter.sort}
            onChange={event => { controller.setFilter({ sort: event.target.value as ModelSort }) }}
          >
            <option value="default">{t('sortDefault')}</option>
            <option value="released">{t('sortReleased')}</option>
            <option value="name">{t('sortName')}</option>
            <option value="context">{t('sortContext')}</option>
            <option value="quota">{t('sortQuota')}</option>
            <option value="price">{t('sortPrice')}</option>
            <option value="enabled">{t('sortEnabled')}</option>
          </select>
        </label>
        {hidden > 0 && <span className={css.hint}>{hidden} {t('filterHidden')}</span>}
      </div>}
      {reading !== undefined && <div className={css.list}>
        {rows.map(model => {
          const badge = badgeFor(model, t)
          const offered = isOffered(model, visibility)
          return <div className={css.item} key={model.id}>
            <input
              type="checkbox"
              aria-label={`${t('catalogTitle')}: ${model.name}`}
              checked={offered}
              disabled={!editable || model.configurationMissing !== undefined}
              onChange={event => { controller.setVisibility(model.id, event.target.checked) }}
            />
            <div className={css.itemBody}>
              <div className={css.itemMain}>
                <span className={css.name}>{model.name}</span>
                <span className={css.mono}>{model.id}</span>
                {model.releaseDate !== undefined && <span className={css.hint}>{model.releaseDate}</span>}
                {badge.length > 0 && <span className={css.badge}>{badge}</span>}
              </div>
              <div className={css.itemMeta}>
                {model.contextWindow !== undefined
                  && <span>{`${t('iosContext')} ${model.contextWindow.toLocaleString(getLocale?.())}`}</span>}
                <span>{ioLabel(model, t)}</span>
                <span>{priceLabel(model)}</span>
                <span>{quotaLabel(model, t)}</span>
              </div>
            </div>
          </div>
        })}
      </div>}
    </div>
  </section>
}
