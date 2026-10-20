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
import type { NetworkReading } from '../network/contract.ts'
import type { UpdateStatus } from '../update/contract.ts'
import { PACKAGE_NAME, REPOSITORY } from '../update/check.ts'
import { SEED_TRANSCRIBED } from '../go-limits.ts'
import { isModelEnabled } from '../models.ts'
import { isAddress } from './address.ts'
import { compactCount, INITIAL_FILTER, inputModalityLabels, visibleModels } from './model-view.ts'
import type { ModelFilter, ModelSort } from './model-view.ts'
import css from './section.module.css'

/** Credential reference the route resolves. */
export const API_KEY_REF = 'OPENCODE_GO_API_KEY'

/** The settings fields this page owns. */
interface SectionSettings {
  readonly modelVisibility: Record<string, boolean>
  readonly refreshMinutes: number
  /** Addresses the gateway may be pinned to, by host name. */
  readonly pinnedAddresses: Record<string, string>
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

/** One host package-manager namespace, as this page uses it. */
interface PluginManagerLike {
  /** Two business arguments: the spec and its options (both declared in the descriptor). */
  inspect(spec: string, options?: { registry?: unknown }): Promise<unknown>
  removeBundle(name: string): Promise<RemoteResult<PluginManagerChange>>
  installBundle(spec: string, options?: { saveExact?: boolean; enabled?: boolean }): Promise<RemoteResult<PluginManagerChange>>
}

/**
 * Live holder for that namespace.
 *
 * It is a holder rather than a value because the namespace mounts after this
 * page is built: the client entry fills it through `ctx.inject`, which fires
 * once the providing fiber is actually usable. A one-shot `ctx.get()` is
 * strict and answers `undefined` while that fiber is still inactive — taking
 * it once during apply made this page report "no plugin manager" forever on a
 * composition that plainly has one.
 */
export interface PluginManagerHolder {
  /** Explicitly `undefined`-able: the holder is cleared when the fiber goes away. */
  current?: PluginManagerLike | undefined
}

/** The subset of the client context this page uses. */
export interface SectionServices {
  readonly remote: {
    readonly opencodeGoCatalog: {
      read(): Promise<RemoteResult<CatalogReading>>
      refresh(): Promise<RemoteResult<CatalogReading>>
    }
    /**
     * The update Remote. Optional because the section is built as soon as the
     * catalog and credentials are visible, which can precede the rest of this
     * package's own Remote contribution — the mount is asynchronous and
     * registers namespace by namespace.
     */
    readonly opencodeGoUpdate?: {
      readUpdate(): Promise<RemoteResult<UpdateStatus>>
      refreshUpdate(): Promise<RemoteResult<UpdateStatus>>
    }
    /**
     * The gateway's pin.
     *
     * Optional because the mount is asynchronous and registers namespace by
     * namespace: the page is built as soon as the catalog and credentials are
     * visible, which can precede the rest of this package's own Remote
     * contribution. Without it the page shows no pin at all rather than
     * failing to render.
     */
    readonly opencodeGoNetwork?: {
      readNetwork(): Promise<RemoteResult<NetworkReading>>
    }
    readonly credentials: {
      describe(refs: string[]): Promise<RemoteResult<Record<string, { configured: boolean }>>>
      set(ref: string, value: string): Promise<RemoteResult<unknown>>
      unset(ref: string): Promise<RemoteResult<unknown>>
    }
  }
  /**
   * The host's own package manager, used only to apply an update.
   *
   * Optional on purpose: the plugin manager is a separate host plugin a
   * composition may omit, and requiring it would withdraw this whole settings
   * section when it is absent. Without it the page still reports update
   * availability; only the one-click apply says why it cannot run.
   */
  readonly pluginManager?: PluginManagerHolder
  /** Absent in a composition without a settings surface: the page turns read-only. */
  readonly scope: SettingsScopeLike | undefined
}

/** The host package-manager outcome fields this page reads; anything else rides along untouched. */
interface PluginManagerChange {
  readonly application?: string
  readonly version?: string
  readonly pendingBuilds?: unknown
  readonly error?: { readonly code?: string; readonly message?: string }
}

/** Where the one-click update stands. `idle` hides the panel entirely. */
type UpdatePhase = 'idle' | 'checking' | 'current' | 'ready' | 'confirming' | 'updating' | 'done' | 'failed'

/** Update panel state; absence-shaped so a partial update can clear it. */
interface UpdatePanel {
  readonly phase: UpdatePhase
  readonly status: UpdateStatus | undefined
  /** Raw host detail; the page prefixes a translated label at render. */
  readonly message: string | undefined
}

/** Why a settings write did not land, in a form the page can translate. */
type WriteFailure =
  | { readonly kind: 'rejected' }
  | { readonly kind: 'failed'; readonly message: string }

/** What the page renders. Fields are explicit about absence so a partial
 * update can clear one under `exactOptionalPropertyTypes`. */
interface SectionState {
  readonly loading: boolean
  readonly reading: CatalogReading | undefined
  readonly keyConfigured: boolean | undefined
  /** Catalog-side trouble (read or refresh). */
  readonly failure: string | undefined
  /** Settings-write trouble, kept apart from the catalog's own status line. */
  readonly writeFailure: WriteFailure | undefined
  /** The gateway's pin, as the Host reports it. */
  readonly network: NetworkReading | undefined
  /** The pin could not be read; the page says so instead of guessing. */
  readonly networkFailure: string | undefined
  /** The address in the field is not one a socket can be sent to. */
  readonly pinInvalid: boolean
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
  network: undefined,
  networkFailure: undefined,
  pinInvalid: false,
  saved: undefined,
  settings: undefined,
  writable: false,
  saving: false,
  filter: INITIAL_FILTER,
  update: { phase: 'idle', status: undefined, message: undefined },
}

/** Read the three fields this page owns out of a settings snapshot value. */
function settingsOf(value: unknown): SectionSettings | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const visibility = record['modelVisibility']
  const minutes = record['refreshMinutes']
  if (visibility === null || typeof visibility !== 'object' || typeof minutes !== 'number') return undefined
  const entries = Object.entries(visibility as Record<string, unknown>)
    .filter(([, enabled]) => typeof enabled === 'boolean')
  const pins = record['pinnedAddresses']
  const pinEntries = pins !== null && typeof pins === 'object'
    ? Object.entries(pins as Record<string, unknown>)
      .filter(([, address]) => typeof address === 'string')
    : []
  return {
    modelVisibility: Object.fromEntries(entries) as Record<string, boolean>,
    refreshMinutes: minutes,
    pinnedAddresses: Object.fromEntries(pinEntries) as Record<string, string>,
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
    void this.loadNetwork()
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
   * Read the gateway's pin.
   *
   * The Host owns the answer: the address in force is not always the one in
   * the configuration, because an address that was found to be gone leaves
   * the requests on the system's own resolution.
   */
  async loadNetwork(): Promise<void> {
    const remote = this.services.remote.opencodeGoNetwork
    if (remote === undefined) return
    try {
      const result = await remote.readNetwork()
      if (!result.ok) throw result.error
      this.set({ network: result.value, networkFailure: undefined })
    } catch (error: unknown) {
      this.set({
        network: undefined,
        networkFailure: error instanceof Error ? error.message : 'the gateway pin could not be read',
      })
    }
  }

  /**
   * Pin the gateway to one address.
   *
   * The address is checked before it is written: a typo that reached the
   * Host would be ignored there, so the page would claim a pin that is not
   * in force while the request quietly used the system's resolution.
   * @param address - the address as typed.
   */
  async savePin(address: string): Promise<void> {
    const scope = this.services.scope
    const current = this.state.settings
    const host = this.state.network?.host ?? ''
    if (scope === undefined || current === undefined || !this.state.writable) return
    if (host.length === 0) return
    const trimmed = address.trim()
    if (!isAddress(trimmed)) {
      this.set({ pinInvalid: true })
      return
    }
    await this.write(
      () => scope.set('pinnedAddresses', { ...current.pinnedAddresses, [host]: trimmed }),
      () => {
        this.set({ pinInvalid: false })
        void this.loadNetwork()
      },
    )
  }

  /** Unpin the gateway; its name goes back to the system's own resolution. */
  async clearPin(): Promise<void> {
    const scope = this.services.scope
    const current = this.state.settings
    const host = this.state.network?.host ?? ''
    if (scope === undefined || current === undefined || !this.state.writable) return
    if (host.length === 0) return
    const rest = { ...current.pinnedAddresses }
    delete rest[host]
    await this.write(
      () => scope.set('pinnedAddresses', rest),
      () => { void this.loadNetwork() },
    )
  }

  /**
   * The update Remote.
   *
   * `client/index.ts` declares `remote.opencodeGoUpdate` in its inject list,
   * so by the time this controller exists the namespace is mounted. The guard
   * below is therefore a defensive assertion, not a wait: Cordis throws
   * `cannot get property "…" without inject` on an undeclared read rather
   * than returning undefined, which is how an omitted dependency once turned
   * this panel into a permanently blank row.
   * @returns the mounted update Remote.
   * @throws {Error} `remote-not-mounted` when the namespace is absent.
   */
  private updateRemote(): {
    readUpdate(): Promise<RemoteResult<UpdateStatus>>
    refreshUpdate(): Promise<RemoteResult<UpdateStatus>>
  } {
    const remote = this.services.remote.opencodeGoUpdate
    if (remote === undefined) throw new Error('remote-not-mounted')
    return remote
  }

  /**
   * Ask the Host whether a newer release is published.
   *
   * The Host answers from a cached registry reading and fails silent, so an
   * unreachable registry still answers "no update known" rather than erroring
   * the page. Runs once with the page and again only on explicit refresh.
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
      const remote = this.updateRemote()
      const result = force ? await remote.refreshUpdate() : await remote.readUpdate()
      if (!result.ok) throw result.error
      const status = result.value
      this.set({
        update: {
          // An unanswered lookup is not "up to date": rendering the two alike
          // would report an unreachable registry as a current version, which
          // is the same silent lie that once hid this panel entirely.
          phase: !status.checked
            ? 'failed'
            : status.available && status.latest !== undefined ? 'ready' : 'current',
          status,
          message: status.checked ? undefined : 'registry-unreachable',
        },
      })
    } catch (error: unknown) {
      // A failed check stays visible with its own retry. Returning to `idle`
      // renders nothing at all, which once hid every failure — including the
      // mount race above — behind a blank panel.
      this.set({
        update: {
          phase: 'failed',
          status: previous.status,
          message: error instanceof Error ? error.message : 'the update check failed',
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
    const manager = this.services.pluginManager?.current
    if (manager === undefined) {
      this.set({ update: { phase: 'failed', status, message: 'no-plugin-manager' } })
      return
    }
    const spec = `${PACKAGE_NAME}@${latest}`
    this.set({ update: { phase: 'updating', status, message: undefined } })
    const fail = (message: string): void => {
      this.set({ update: { phase: 'failed', status, message } })
    }
    // Pre-flight the target before touching the installed version.
    //
    // `inspect` declares two business arguments (spec and options) in its
    // descriptor, and the gateway client rejects a call whose positional
    // arity differs — even though `options` is optional in TypeScript. The
    // inspection result is also a union: a refused target has no `bundle`
    // field at all, so only an explicit `false` or `refused` status may stop
    // the update. Treating "no answer" as "fine" once meant a failed check
    // would proceed to uninstall the running version, which is why a refusal
    // now aborts before anything is removed.
    try {
      const inspected = await manager.inspect(spec, {})
      if (SectionController.field(inspected, 'status') === 'refused') {
        const reason = SectionController.field(inspected, 'reason')
        fail(typeof reason === 'string' && reason.length > 0
          ? `inspect-refused: ${reason}`
          : 'inspect-refused')
        return
      }
      if (SectionController.field(inspected, 'bundle') === false) {
        fail('not-a-bundle')
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
interface SectionInjected {
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
  // Point at the release itself, not the package page: npm renders the README,
  // which carries no changelog, so the old link could not answer the only
  // question this link exists for — what changed in that version. Fall back to
  // the releases index when the check has not told us a version yet.
  const notes = status?.latest === undefined
    ? `https://github.com/${REPOSITORY}/releases`
    : `https://github.com/${REPOSITORY}/releases/tag/v${status.latest}`
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
  if (message === 'remote-not-mounted') return t('updateRemoteMissing')
  if (message === 'no-plugin-manager') return t('updateNoManager')
  if (message === 'registry-unreachable') return t('updateUnreachable')
  if (message === 'not-a-bundle') return t('updateNotBundle')
  if (message === 'inspect-refused' || message.startsWith('inspect-refused: ')) {
    const detail = message.slice('inspect-refused: '.length)
    return detail.length > 0 && detail !== 'inspect-refused'
      ? `${t('updateInspectRefused')} ${detail}`
      : t('updateInspectRefused')
  }
  if (message === 'stop-profile') return t('updateStopProfile')
  if (message === 'incompatible-version') return t('updateIncompatible')
  if (message === 'pending-builds') return t('updatePendingBuilds')
  return message
}

/** The settings page. */
export function Section({ controller, t, getLocale }: SectionInjected): React.JSX.Element {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const [keyDraft, setKeyDraft] = useState('')
  const [pinDraft, setPinDraft] = useState('')
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
  // The field follows the Host: a pin that was written, removed, or found to
  // be gone is shown as the Host reports it, not as the page last typed.
  useEffect(() => { setPinDraft(state.network?.address ?? '') }, [state.network?.address])

  const reading = state.reading
  const network = state.network
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
        <strong>{t('pinTitle')}</strong>
        <span className={css.mono}>{network?.host ?? '—'}</span>
        <span className={network?.failed === true ? css.warn : css.hint}>
          {network === undefined
            ? '—'
            : network.failed === true
              ? t('pinFailed')
              : network.address === undefined ? t('pinNone') : network.address}
        </span>
      </div>
      <p className={css.hint}>{t('pinHint')}</p>
      {state.networkFailure !== undefined && (
        <p className={css.warn}>{`${t('pinUnavailable')}: ${state.networkFailure}`}</p>
      )}
      <div className={css.row}>
        <input
          className={css.input}
          type="text"
          aria-label={t('pinTitle')}
          placeholder={t('pinPlaceholder')}
          value={pinDraft}
          onChange={event => { setPinDraft(event.target.value) }}
        />
        <button type="button" className={css.button}
          disabled={!editable || busy || pinDraft.trim().length === 0}
          onClick={() => { void act(async () => { await controller.savePin(pinDraft) }) }}>
          {t('pinSave')}
        </button>
        <button type="button" className={css.button}
          disabled={!editable || busy || network?.address === undefined}
          onClick={() => { void act(async () => { await controller.clearPin() }) }}>
          {t('pinClear')}
        </button>
      </div>
      {state.pinInvalid && <p className={css.warn}>{t('pinInvalid')}</p>}
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
      {reading !== undefined && reading.degradations.length > 0 && (
        <p className={css.warn}>
          {t('catalogDegraded')}: {reading.degradations.map(degradation => `${t(degradation.source === 'metadata' ? 'catalogDegradedMetadata' : 'catalogDegradedDocument')} — ${degradation.reason}`).join('; ')}
        </p>
      )}
      {reading !== undefined && reading.quotaSource === 'seed' && (
        <p className={css.hint}>{t('quotaSeed')} {SEED_TRANSCRIBED}</p>
      )}
      {reading !== undefined && reading.factsCachedAt !== undefined && (
        <p className={css.hint}>
          {t('factsCached')} {new Date(reading.factsCachedAt).toISOString().slice(0, 10)}
        </p>
      )}
      {reading !== undefined && reading.cached === true && (
        <p className={css.hint}>{t('catalogRefreshing')}</p>
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
