/**
 * Browser half of the plugin.
 *
 * The page owns two things the Host cannot: the copy dictionaries, and the
 * placement of the usage button inside the conversation composer. Everything
 * else — the model catalog, the credential, the usage readings — is read from
 * the Host over the Remote the plugin mounts here.
 *
 * @module @dan-ai-studio/dshopencodego/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the composer slot).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the root `main` keyed slot the request-log page registers into,
// declared by ui-layout with the panel-id brand.
import type { ILayout, MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the `sidebar.panellist` list the entry registers into.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the slot registry Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge and the SessionId brand.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { catalogRemote } from '../catalog/contract.ts'
import { networkRemote } from '../network/contract.ts'
import { requestLogRemote } from '../request-log/contract.ts'
import { updateRemote } from '../update/contract.ts'
import { usageRemote } from '../usage/contract.ts'
import type { TypertDisposer } from '@deepseek-ai/dsh-typert-protocol'
import { en, zh } from './locales.ts'
import type { OpencodeGoKey } from './locales.ts'
import { Section, SectionController } from './Section.tsx'
import type { PluginManagerHolder, SettingsScopeLike } from './Section.tsx'
import { RequestLogPage } from './RequestLogPage.tsx'
import type { RequestLogFace } from './RequestLogPage.tsx'
import { RequestLogPanelIcon } from './RequestLogPanelIcon.tsx'
import { UsagePill } from './UsagePill.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The OpenCode Go settings page copy. */
    'settings.dshopencodego': keyof typeof en
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.dshopencodego'

/**
 * The main panel the request log occupies.
 *
 * The same identity is the sidebar entry's id: the sidebar resolves a row's
 * label from the list registration and selects the panel with the matching
 * key, so the two must be one string.
 */
const REQUEST_LOG_PANEL = 'dshopencodego-request-log' as MainPanelId

export type { UsagePillInjected } from './UsagePill.tsx'
export type { OpencodeGoKey } from './locales.ts'

/**
 * Services this half requires. The composer slot is declared by the
 * conversation package, whose activation order is not constrained relative to
 * this one, so registration depends on the slot through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'remote']

/**
 * Register the dictionaries, mount the Remote, and place the usage button.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dshopencodego: copy dictionaries')
  // The layout service, held live: the settings page's button selects the
  // request-log panel through it. It is read through `inject` rather than
  // off the context directly, because a service read through a scope that
  // never declared it throws — and a thrown read there would look like a
  // button that does nothing.
  const layout: { current: ILayout | undefined } = { current: undefined }
  ctx.inject(['layout'], (layoutScope) => {
    layout.current = layoutScope.layout
    // Drop the reference when the provider goes away, so a stale service is
    // never called after its owner is disposed.
    return () => { layout.current = undefined }
  })
  // Session navigation, held live for the same reason: a session title in the
  // request log opens that session's conversation. Archived sessions cannot
  // be opened, so the archived list rides along for the guard.
  const sessionOpener: { current: { openSession(sessionId: SessionId): void } | undefined } = { current: undefined }
  ctx.inject(['uiWorkspace'], (workspaceScope) => {
    sessionOpener.current = (workspaceScope as unknown as {
      uiWorkspace: { openSession(sessionId: SessionId): void }
    }).uiWorkspace
    return () => { sessionOpener.current = undefined }
  })
  const sessionArchive: {
    current: { readonly list: { getSnapshot(): { readonly archivedSessionIds: readonly string[] } } } | undefined
  } = { current: undefined }
  ctx.inject(['workspaces'], (archiveScope) => {
    sessionArchive.current = (archiveScope as unknown as {
      workspaces: { readonly list: { getSnapshot(): { readonly archivedSessionIds: readonly string[] } } }
    }).workspaces
    return () => { sessionArchive.current = undefined }
  })
  // One registry owns one contribution per package, so the catalog methods ride
  // the same mount as usage: a separate `$mount` would leave
  // `remote.opencodeGoCatalog` unregistered, and the settings section's inject
  // would then never be satisfied. Mirrors the Host-side contribution in
  // `src/remotes.ts`.
  const mounted = ctx.remote.$mount({
    package: usageRemote.package,
    descriptors: [
      ...usageRemote.descriptors,
      ...catalogRemote.descriptors,
      ...updateRemote.descriptors,
      ...networkRemote.descriptors,
      ...requestLogRemote.descriptors,
    ],
  })
  ctx.effect(() => {
    let dispose: TypertDisposer | undefined
    void mounted.then((next: TypertDisposer) => { dispose = next }).catch(() => {
      // A failed mount surfaces on the first call; the page still loads.
    })
    return () => { void dispose?.() }
  }, 'dshopencodego: usage Remote')
  // `remote.opencodeGoUpdate` belongs in this list: Cordis refuses an
  // undeclared service read with `cannot get property "…" without inject`
  // rather than returning undefined, and leaving it out made the settings
  // page's first update check throw into a panel that hid the failure —
  // a blank row for three releases.
  //
  // The network namespace is here for the same reason: the page reads the
  // gateway's pin through it, and reading an undeclared service throws.
  // The request-log namespace is here because the request-log viewer reads
  // its snapshot through it.
  ctx.inject(['configForms', 'remote.opencodeGoCatalog', 'remote.opencodeGoUpdate', 'remote.opencodeGoNetwork', 'remote.opencodeGoRequestLog', 'remote.credentials'], (scope) => {
    // Profile-entry forms live on `configForms`; the entry id is this
    // plugin's, and a composition without the form renders the page read-only.
    const forms = scope.get('configForms') as
      { get(id: string): SettingsScopeLike | undefined } | undefined
    const pluginManager: PluginManagerHolder = {}
    const profile = forms?.get('dshopencodego')
    const controller = new SectionController({
      remote: scope.remote,
      pluginManager,
      scope: profile,
    })
    // The package manager is filled separately and reactively.
    //
    // It is not part of the required list above: a composition may have no
    // plugin manager, and requiring it would withdraw this whole section. It
    // is also not a one-shot `scope.get()`, because `get` is strict and
    // answers undefined while the providing fiber is not yet active — which
    // is the state during this apply, so the page reported "no plugin
    // manager" on compositions that have one. `inject` waits for the real
    // thing instead.
    scope.inject(['remote.pluginManager'], (managerScope) => {
      pluginManager.current = managerScope.remote.pluginManager as never
      // Drop the reference when the providing fiber goes away, so a stale
      // namespace is never called after its owner is disposed.
      return () => { pluginManager.current = undefined }
    })
    const translate = scope.locale.bind(NS)
    scope.effect(() => () => { controller.dispose() })
    // The request-log page: a panel in the main column, with a sidebar entry
    // that selects it. A page rather than a dialog because a log of a hundred
    // rows needs the whole column — a card floating over the conversation
    // would be both smaller and less readable.
    //
    // The page reads its snapshot on demand and never polls, so a page nobody
    // opens costs nothing at all.
    const requestLog: RequestLogFace = {
      readLog: async () => {
        const result = await scope.remote.opencodeGoRequestLog.readLog()
        if (!result.ok) throw result.error
        return result.value
      },
      // Read live: the switch on the settings page can change while the log
      // page sits open, and the page says so rather than pretending.
      enabled: () => {
        const value = profile?.getSnapshot().value
        if (value === null || typeof value !== 'object') return false
        return (value as { requestLogEnabled?: unknown }).requestLogEnabled === true
      },
      // Whether a title click can open its session. The navigation service
      // is a separate composition member; without it titles stay text.
      canOpenSession: () => sessionOpener.current !== undefined,
      // Select a session and show its conversation: the same call the
      // sidebar's own rows make. Archived sessions refuse, and a throw
      // leaves the selection where it was — both read as false.
      openSession: (sessionId) => {
        const opener = sessionOpener.current
        if (opener === undefined) return false
        if (sessionArchive.current?.list.getSnapshot().archivedSessionIds.includes(sessionId) === true) return false
        try {
          opener.openSession(sessionId as SessionId)
          return true
        } catch {
          return false
        }
      },
      t: (key: string) => translate(key as OpencodeGoKey),
      getLocale: () => scope.locale.getLocale().active,
    }
    scope.slots.inject('main', function* () {
      yield scope.slots.register({
        name: 'main',
        key: REQUEST_LOG_PANEL,
        locale: NS,
        inject: () => requestLog,
      }, RequestLogPage)
    })
    scope.slots.inject('sidebar.panellist', () => scope.slots.register({
      name: 'sidebar.panellist',
      id: REQUEST_LOG_PANEL,
      // After the Host's own panels, which run from 0.
      order: 100,
      label: () => translate('requestLogTitle'),
      locale: NS,
    }, RequestLogPanelIcon))
    // The same page, in the conversation: a View beside the chat, scoped to
    // one session. It is the in-place way to answer "why was that turn
    // slow" — the rows are already this session's.
    scope.slots.inject('conversation.view', () => scope.slots.register({
      name: 'conversation.view',
      id: 'dshopencodego-request-log',
      // After the Host's own View (the chat itself), which runs at 0.
      order: 100,
      label: () => translate('requestLogTitle'),
      locale: NS,
      inject: (sessionId: SessionId) => ({ ...requestLog, sessionId: String(sessionId) }),
    }, RequestLogPage))
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section',
      id: 'dshopencodego',
      // After the product rows. The built-ins run -10 (account) through 20
      // (agent presets); sharing 20 with `agent-presets` left the pair ordered
      // by registration timing, which drifts between boots. The host's own
      // tests use 1000 for "last".
      order: 1000,
      label: () => translate('nav'),
      inject: () => ({
        controller,
        t: (key: string) => translate(key as OpencodeGoKey),
        getLocale: () => scope.locale.getLocale().active,
        // The settings page opens the log in the main column, beside this
        // page rather than over it. It reports whether it worked: a button
        // that silently does nothing is worse than one that says why.
        openRequestLog: () => {
          const service = layout.current
          if (service === undefined) return false
          service.selectPanel(REQUEST_LOG_PANEL)
          return true
        },
      }),
    }, Section))
  })
  // `modelDirectories.directoryFor` reads the session's remote namespace, so
  // the scope that calls it has to declare that namespace: a service read
  // through a scope that never declared it throws, and the throw lands in
  // the composer's render — a broken input bar rather than a broken page.
  ctx.inject(['modelDirectories', 'remote.opencodeGoUsage', 'remote.session'], (scope) => {
    const translate = scope.locale.bind(NS)
    scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right',
      id: 'dshopencodego-usage',
      order: 1000,
      inject: sessionId => ({
        directory: scope.modelDirectories.directoryFor(sessionId as SessionId).store,
        readWindows: async () => {
          const result = await scope.remote.opencodeGoUsage.readWindows()
          if (!result.ok) throw result.error
          return result.value
        },
        readMeter: async () => {
          const result = await scope.remote.opencodeGoUsage.readMeter()
          if (!result.ok) throw result.error
          return result.value
        },
        t: (key: string) => translate(key as OpencodeGoKey),
        getLocale: () => scope.locale.getLocale().active,
      }),
    }, UsagePill))
  })
}
