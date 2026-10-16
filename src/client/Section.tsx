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
import type { UpdateStatus } from '../update/contract.ts'
import { PACKAGE_NAME } from '../update/check.ts'
import { SEED_TRANSCRIBED } from '../go-limits.ts'
import { isModelEnabled } from '../models.ts'
import { compactCount, INITIAL_FILTER, inputModalityLabels, visibleModels } from './model-view.ts'
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
    readonly opencodeGoUpdate: {
      readUpdate(): Promise<RemoteResult<UpdateStatus>>
      refreshUpdate(): Promise<RemoteResult<UpdateStatus>>
    }
    /**
     * The host's own package manager. The page drives the same two steps the
     * official plugin-update button drives — `removeBundle` then
     * `installBundle` — so the manifest lock, peer checks, build approvals,
     * and HMR lifecycle all stay with the host. The plugin never replaces its
     * own files.
     */
    readonly pluginManager: {
      inspect(spec: string): Promise<unknown>
      removeBundle(name: string): Promise<RemoteResult<PluginManagerChange>>
      installBundle(spec: string, options?: { saveExact?: boolean; enabled?: boolean }): Promise<RemoteResult<PluginManagerChange>>
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

/** The host package-manager outcome fields this page reads; anything else rides along untouched. */
export interface PluginManagerChange {
  readonly application?: string
  readonly version?: string
  readonly pendingBuilds?: unknown
  readonly error?: { readonly code?: string; readonly message?: string }
}

/** Where the one-click update stands. `idle` hides the panel entirely. */
export type UpdatePhase = 'idle' | 'checking' | 'current' | 'ready' | 'confirming' | 'updating' | 'done' | 'failed'

/** Update panel state; absence-shaped so a partial update can clear it. */
export interface UpdatePanel {
  readonly phase: UpdatePhase
  readonly status: UpdateStatus | undefined
  /** Raw host detail; the page prefixes a translated label at render. */
  readonly message: string | undefined
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
  /** The human's narrowing of the model list; never written to the Host. */
  readonly filter: ModelFilter
  /** One-click update panel; `idle` renders nothing. */
  readonly update: UpdatePanel
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
  update: { phase: 'idle', status: undefined, message: undefined },
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
    void this.checkUpdate(false)
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

  /**
   * Ask the Host whether a newer release is published.
   *
   * The Host answers from a cached registry reading and fails silent, so an
   * unreachable registry hides the panel instead of erroring the page. Runs
   * once with the page and again only on explicit refresh.
   *
   * Both wire methods take zero arguments: the gateway client rejects any
   * call whose positional arity differs from the descriptor's `parameters`,
   * so the cached read and the forced refresh are two methods (`readUpdate`
   * / `refreshUpdate`), never one method with a flag.
   */
  async checkUpdate(force: boolean): Promise<void> {
    const previous = this.state.update
    this.set({ update: { ...previous, phase: 'checking', message: undefined } })
    try {
      const remote = this.services.remote.opencodeGoUpdate
      const result = force ? await remote.refreshUpdate() : await remote.readUpdate()
      if (!result.ok) throw result.error
      const status = result.value
      this.set({
        update: {
          phase: status.available && status.latest !== undefined ? 'ready' : 'current',
          status,
          message: undefined,
        },
      })
    } catch (error: unknown) {
      // Fail silent like the Host: keep whatever the panel showed, if anything.
      this.set({
        update: {
          ...previous,
          phase: previous.phase === 'checking' ? 'idle' : previous.phase,
          message: error instanceof Error ? error.message : undefined,
        },
      })
    }
  }

  /** Arm the confirm step; the destructive two-step runs only from `applyUpdate`. */
  armUpdate(): void {
    if (this.state.update.phase === 'ready') {
      this.set({ update: { ...this.state.update, phase: 'confirming' } })
    }
  }

  /** Stand down from the confirm step without doing anything. */
  disarmUpdate(): void {
    if (this.state.update.phase === 'confirming') {
      this.set({ update: { ...this.state.update, phase: 'ready' } })
    }
  }

  /** Read one field off an unknown host answer without guessing its shape. */
  private static field(value: unknown, key: string): unknown {
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  }

  /**
   * One-click update: inspect, then the host's own remove + install.
   *
   * This mirrors the official plugin-update button exactly — the plugin never
   * touches its own files. `removeBundle` stops the running build first, so
   * the install call that follows is issued by this page (which survives),
   * not by the Host code being removed. Outcomes that need a human —
   * incompatibility (never auto-exempted), pending build approvals, a removal
   * that needs a restart first — surface as guidance, never as silent retries.
   */
  async applyUpdate(): Promise<void> {
    const status = this.state.update.status
    const latest = status?.latest
    if (this.state.update.phase !== 'confirming' || latest === undefined) return
    const manager = this.services.remote.pluginManager
    const spec = `${PACKAGE_NAME}@${latest}`
    this.set({ update: { phase: 'updating', status, message: undefined } })
    const fail = (message: string): void => {
      this.set({ update: { phase: 'failed', status, message } })
    }
    try {
      const inspected = await manager.inspect(spec)
      if (SectionController.field(inspected, 'bundle') === false) {
        fail(`the registry target is not a DSH bundle: ${spec}`)
        return
      }
    } catch (error: unknown) {
      fail(error instanceof Error ? error.message : `could not inspect ${spec}`)
      return
    }
    try {
      const removed = await manager.removeBundle(PACKAGE_NAME)
      if (!removed.ok) throw removed.error
      const stopCode = SectionController.field(removed.value, 'error')
      const code = typeof stopCode === 'object' && stopCode !== null
        ? SectionController.field(stopCode, 'code')
        : undefined
      if (code === 'stop-profile') {
        fail('stop-profile')
        return
      }
    } catch (error: unknown) {
      fail(error instanceof Error ? error.message : `could not remove ${PACKAGE_NAME}`)
      return
    }
    try {
      const installed = await manager.installBundle(spec, { saveExact: true })
      if (!installed.ok) throw installed.error
      const value = (installed.value ?? {}) as PluginManagerChange
      if (value.error?.code === 'incompatible-version') {
        fail('incompatible-version')
        return
      }
      if (value.pendingBuilds !== undefined) {
        fail('pending-builds')
        return
      }
      if (value.application === 'restart-required') {
        this.set({ update: { phase: 'done', status, message: 'restart-required' } })
        return
      }
      this.set({ update: { phase: 'done', status, message: undefined } })
    } catch (error: unknown) {
      fail(error instanceof Error ? error.message : `could not install ${spec}`)
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

  /** Narrow or reorder the model list; a view preference, never a write. */
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

/** Whether one model is offered right now; one rule, shared with the Host. */
function isOffered(model: CatalogReading['models'][number], visibility: Record<string, boolean>): boolean {
  return isModelEnabled(model, visibility)
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

/** One-click update banner; renders nothing while the panel is idle. */
function UpdateBanner({ controller, t, busy, act, update }: {
  controller: SectionController
  t: (key: string) => string
  busy: boolean
  act: (operation: () => Promise<void>) => void
  update: UpdatePanel
}): React.JSX.Element | null {
  if (update.phase === 'idle') return null
  const status = update.status
  const notes = `https://www.npmjs.com/package/${encodeURIComponent(PACKAGE_NAME)}`
  return <div className={css.block}>
    <div className={css.row}>
      <strong>{t('updateTitle')}</strong>
      {update.phase === 'checking' && <span className={css.hint}>{t('updateChecking')}</span>}
      {update.phase === 'current' && <>
        <span className={css.hint}>{`${t('updateLatest')} ${status?.current ?? ''}`.trim()}</span>
        <button type="button" className={css.button} disabled={busy}
          onClick={() => { void act(async () => { await controller.checkUpdate(true) }) }}>
          {t('updateRecheck')}
        </button>
      </>}
      {update.phase === 'ready' && status?.latest !== undefined && <>
        <span className={css.hint}>
          {`${t('updateAvailable')} ${status.latest} (${t('updateCurrent')} ${status.current})`}
        </span>
        <button type="button" className={css.button} disabled={busy}
          onClick={() => { controller.armUpdate() }}>
          {t('updateNow')}
        </button>
        <a className={css.hint} href={notes} target="_blank" rel="noreferrer">{t('updateNotes')}</a>
        <button type="button" className={css.button} disabled={busy}
          onClick={() => { void act(async () => { await controller.checkUpdate(true) }) }}>
          {t('updateRecheck')}
        </button>
      </>}
      {update.phase === 'confirming' && status?.latest !== undefined && <>
        <span className={css.hint}>{`${t('updateConfirmHint')} ${status.latest}`}</span>
        <button type="button" className={css.button} disabled={busy}
          onClick={() => { void act(async () => { await controller.applyUpdate() }) }}>
          {t('updateConfirm')}
        </button>
        <button type="button" className={css.button} disabled={busy}
          onClick={() => { controller.disarmUpdate() }}>
          {t('updateCancel')}
        </button>
      </>}
      {update.phase === 'updating' && <span className={css.hint}>{t('updateApplying')}</span>}
      {update.phase === 'done' && <>
        <span className={css.ok}>{`${t('updateDone')} ${status?.latest ?? ''}`.trim()}</span>
        {update.message === 'restart-required' && <span className={css.warn}>{t('updateRestart')}</span>}
      </>}
      {update.phase === 'failed' && <>
        <span className={css.warn}>{t('updateFailed')}</span>
        <span className={css.hint}>{updateFailureText(update.message, t)}</span>
        <button type="button" className={css.button} disabled={busy}
          onClick={() => { void act(async () => { await controller.checkUpdate(true) }) }}>
          {t('updateRecheck')}
        </button>
      </>}
    </div>
  </div>
}

/** Translate the controller's sentinel failure notes; raw host detail passes through. */
function updateFailureText(message: string | undefined, t: (key: string) => string): string {
  if (message === undefined || message.length === 0) return ''
  if (message === 'stop-profile') return t('updateStopProfile')
  if (message === 'incompatible-version') return t('updateIncompatible')
  if (message === 'pending-builds') return t('updatePendingBuilds')
  return message
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
    <UpdateBanner controller={controller} t={t} busy={busy} act={act} update={state.update} />

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
      {reading !== undefined && reading.quotaSource === 'seed' && (
        <p className={css.hint}>{t('quotaSeed')} {SEED_TRANSCRIBED}</p>
      )}
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
          const modalities = inputModalityLabels(model, t).join(' · ')
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
              {modalities.length > 0 && <div className={css.itemModalities}>
                {`${t('inputLabel')} ${modalities}`}
              </div>}
            </div>
          </div>
        })}
      </div>}
    </div>
  </section>
}
