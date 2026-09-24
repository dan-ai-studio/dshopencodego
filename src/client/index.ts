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
// Type-only: pulls the slot registry Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge and the SessionId brand.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { usageRemote } from '../usage/contract.ts'
import type { TypertDisposer } from '@deepseek-ai/dsh-typert-protocol'
import { en, zh } from './locales.ts'
import type { OpencodeGoKey } from './locales.ts'
import { Section, SectionController } from './Section.tsx'
import type { SettingsScopeLike } from './Section.tsx'
import { UsagePill } from './UsagePill.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The OpenCode Go settings page copy. */
    'settings.dshopencodego': keyof typeof en
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.dshopencodego'

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
  const mounted = ctx.remote.$mount(usageRemote)
  ctx.effect(() => {
    let dispose: TypertDisposer | undefined
    void mounted.then((next: TypertDisposer) => { dispose = next }).catch(() => {
      // A failed mount surfaces on the first call; the page still loads.
    })
    return () => { void dispose?.() }
  }, 'dshopencodego: usage Remote')
  ctx.inject(['configForms', 'remote.opencodeGoCatalog', 'remote.credentials'], (scope) => {
    // 0.1.7 keeps profile-entry forms on `configForms`; the entry id is this
    // plugin's, and a composition without the form renders the page read-only.
    const forms = scope.get('configForms') as
      { get(id: string): SettingsScopeLike | undefined } | undefined
    const controller = new SectionController({
      remote: scope.remote,
      scope: forms?.get('dshopencodego'),
    })
    const translate = scope.locale.bind(NS)
    scope.effect(() => () => { controller.dispose() })
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section',
      id: 'dshopencodego',
      order: 20,
      label: () => translate('nav'),
      inject: () => ({
        controller,
        t: (key: string) => translate(key as OpencodeGoKey),
        getLocale: () => scope.locale.getLocale().active,
      }),
    }, Section))
  })
  ctx.inject(['modelDirectories', 'remote.opencodeGoUsage'], (scope) => {
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
