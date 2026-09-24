/**
 * The "OpenCode Go" settings page.
 *
 * It answers three questions in one place: is the route usable (credential
 * state), what does the gateway serve right now (the catalog reading, with the
 * refresh that bypasses the runtime cache), and how is each model called (the
 * protocol source, so an inferred guess is visible rather than silent).
 *
 * @module @dan-ai-studio/dshopencodego/client/Section
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CatalogReading } from '../catalog/contract.ts'
import css from './section.module.css'

/** Credential reference the route resolves. */
export const API_KEY_REF = 'OPENCODE_GO_API_KEY'

/** The subset of the client context this page uses. */
export interface SectionServices {
  readonly remote: {
    readonly opencodeGoCatalog: {
      read(): Promise<RemoteResult<CatalogReading>>
      refresh(): Promise<RemoteResult<CatalogReading>>
    }
    readonly credentials: {
      describe(refs: string[]): Promise<Record<string, { configured: boolean }>>
      set(ref: string, value: string): Promise<void>
      unset(ref: string): Promise<void>
    }
  }
}

/** What the page renders. Fields are explicit about absence so a partial
 * update can clear one under `exactOptionalPropertyTypes`. */
export interface SectionState {
  readonly loading: boolean
  readonly reading: CatalogReading | undefined
  readonly keyConfigured: boolean | undefined
  readonly failure: string | undefined
  /** Set after a successful key write, so the button can confirm. */
  readonly saved: boolean | undefined
}

const INITIAL: SectionState = {
  loading: true,
  reading: undefined,
  keyConfigured: undefined,
  failure: undefined,
  saved: undefined,
}

/** Owns the page's state and talks to the Host Remotes. */
export class SectionController {
  private state: SectionState = INITIAL
  private readonly listeners = new Set<() => void>()
  private readonly services: SectionServices

  constructor(services: SectionServices) {
    this.services = services
    void this.load(false)
    void this.loadKey()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot = (): SectionState => this.state

  /** Drop every listener; the slot's effect calls this on teardown. */
  dispose(): void {
    this.listeners.clear()
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
      this.set({ keyConfigured: described[API_KEY_REF]?.configured === true })
    } catch {
      // An undescribed credential is reported as unknown, never as absent.
      this.set({ keyConfigured: undefined })
    }
  }

  async saveKey(value: string): Promise<void> {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    await this.services.remote.credentials.set(API_KEY_REF, trimmed)
    this.set({ saved: true })
    await this.loadKey()
  }

  async clearKey(): Promise<void> {
    await this.services.remote.credentials.unset(API_KEY_REF)
    this.set({ saved: false })
    await this.loadKey()
  }
}

/** Everything the slot injects into the page. */
export interface SectionInjected {
  readonly controller: SectionController
  readonly t: (key: string) => string
  readonly getLocale?: () => string
}

/** How a protocol decision is labelled for a human. */
function protocolLabel(reading: CatalogReading, id: string, t: (key: string) => string): string | undefined {
  const model = reading.models.find(entry => entry.id === id)
  if (model?.configurationMissing !== undefined) return t('catalogUnconfigured')
  if (model?.protocolSource === 'inferred') return t('catalogInferred')
  if (model?.assumedLimits === true) return t('catalogAssumed')
  return undefined
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
          {state.saved ? t('keySaved') : t('keySave')}
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
          {reading === undefined ? '—' : `${reading.counts.total} ${t('catalogCountUnit')}`}
          {reading === undefined ? '' : ` · ${reading.counts.enabled} ✓`}
          {reading === undefined || reading.counts.inferred === 0 ? '' : ` · ${reading.counts.inferred} ${t('catalogInferred')}`}
          {reading === undefined || reading.counts.unconfigured === 0 ? '' : ` · ${reading.counts.unconfigured} ${t('catalogUnconfigured')}`}
        </span>
        <button type="button" className={css.button} disabled={busy || state.loading}
          onClick={() => { void act(async () => { await controller.load(true) }) }}>
          {state.loading ? t('usageRefreshing') : t('catalogRefresh')}
        </button>
      </div>
      {state.failure !== undefined && <p className={css.warn}>{t('catalogStale')}: {state.failure}</p>}
      {reading !== undefined && reading.stale && state.failure === undefined && <p className={css.warn}>{t('catalogStale')}</p>}
      {reading !== undefined && <table className={css.table}>
        <tbody>
          {reading.models.map(model => {
            const badge = protocolLabel(reading, model.id, t)
            return <tr key={model.id}>
              <td className={css.name}>{model.name}</td>
              <td className={css.mono}>{model.id}</td>
              <td className={css.hint}>{model.contextWindow === undefined ? '—' : model.contextWindow.toLocaleString(getLocale?.())}</td>
              <td className={badge === undefined ? css.hint : css.badge}>
                {badge === undefined
                  ? model.deprecated === true ? t('catalogDeprecated') : ''
                  : `${badge}${model.configurationMissing === undefined ? '' : `: ${model.configurationMissing}`}`}
              </td>
            </tr>
          })}
        </tbody>
      </table>}
    </div>
  </section>
}
