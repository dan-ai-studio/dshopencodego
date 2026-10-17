/**
 * The `dshopencodego` plugin: one `opencode-go` route with a live catalog and
 * the gateway's mandatory session header.
 *
 * The plugin exists because a generic pi-ai route cannot express two things the
 * OpenCode Go gateway needs: a model list that rotates faster than any shipped
 * catalog, and a per-conversation `x-opencode-session` routing header on every
 * inference request.
 *
 * Route registration is gated on both configuration and credential: a route
 * whose key is missing would otherwise sit in every model picker and read as a
 * usable provider to first-run onboarding. The gate re-evaluates on every
 * credential write and every loader update, and a route another adapter already
 * owns is reported rather than crashing the mount.
 *
 * ```yaml
 * - id: dshopencodego
 *   name: '@dan-ai-studio/dshopencodego'
 *   config:
 *     enabled: true                             # false withdraws the route only
 *     apiKeyEnv: OPENCODE_GO_API_KEY             # default
 *     baseURL: https://opencode.ai/inference/go/v1     # default
 *     refreshMinutes: 60                         # live catalog TTL
 *     modelProtocols:                            # last-resort protocol override
 *       some-model: openai-responses
 * ```
 *
 * @module @dan-ai-studio/dshopencodego
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the loader's `ctx.fiber.entry` merge, which supplies this
// mount's entry id — the settings namespace both discovery and the DSH Models
// page are keyed by.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import * as llm from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  AdapterRegistrationHandle,
  DirectoryRegistrationHandle,
  LlmConfigurableProvider,
  LlmModelDiscoveryRequest,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import { OpencodeGoAdapter } from './adapter.ts'
import { DEFAULT_BASE_URL, DISPLAY_NAME, PROVIDER_ID, discoverCatalogModels } from './catalog/index.ts'
import { assertBaseURL, PlainConfig, readConfig } from './config.ts'
import type { LiveConfig, OpencodeGoConfig } from './config.ts'
import { registerRemotes } from './remotes.ts'
import { OpencodeGoCatalogService } from './catalog/service.ts'
import { OpencodeGoUpdateService } from './update/index.ts'
import { PLUGIN_VERSION } from './update/index.ts'
import { OpencodeGoUsageService, UsageMeter } from './usage/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

export { OpencodeGoAdapter } from './adapter.ts'
export type { OpencodeGoAdapterOptions, OpencodeGoImageAccess } from './adapter.ts'
export { DEFAULT_BASE_URL, CONSOLE_BASE_URL, DISPLAY_NAME, PROVIDER_ID, OpencodeGoCatalog, discoverCatalogModels } from './catalog/index.ts'
export { Config, PlainConfig, assertBaseURL, DEFAULT_API_KEY_ENV } from './config.ts'
export type { OpencodeGoConfig } from './config.ts'
export { SESSION_HEADER, SESSION_AFFINITY_HEADER, opencodeSessionValue, providerHeaders } from './session-header.ts'
export { isModelEnabled, sortModels } from './models.ts'
export type { ModelSummary } from './models.ts'

export const name = 'dshopencodego'
export const inject = ['llm']

/** True when a loader handed this plugin its live field references. */
function isLiveConfig(raw: unknown): raw is LiveConfig {
  return typeof raw === 'object' && raw !== null && typeof (raw as { enabled?: unknown }).enabled === 'object'
    && typeof ((raw as { enabled?: { get?: unknown } }).enabled?.get) === 'function'
}

/**
 * Register the route, its discovery, and their teardown for one mount.
 *
 * Configuration is read through a live source so a profile edit reaches the
 * next request without a restart; the adapter re-reads it at every operation.
 * @param ctx - the plugin's Cordis context.
 * @param raw - the loader's live config, or a plain object in tests.
 */
export function apply(ctx: Context, raw?: unknown): void {
  const live = isLiveConfig(raw) ? raw : undefined
  const constant = live === undefined ? PlainConfig((raw ?? {}) as OpencodeGoConfig) : undefined
  const current = (): OpencodeGoConfig => (live === undefined ? constant as OpencodeGoConfig : readConfig(live))
  assertBaseURL(current().baseURL)

  // The id of the loader entry this mount belongs to: the settings namespace
  // DSH keys configuration and model discovery by. `registerModelDiscovery`
  // matches the directory entry's `settingsNs`, and the DSH Models page only
  // starts a discovery for a provider a directory entry names. A bare mount
  // (programmatic use, tests) has no loader entry, so the module name stands in
  // — the same fallback the official single-route plugins use.
  const settingsNs = ctx.fiber?.entry?.options.id ?? name

  let directory: DirectoryRegistrationHandle | undefined
  let directoryError: string | undefined
  let directoryRetired = false

  /** The directory entry, with its reparability notice when there is one. */
  const directoryEntry = (error: string | undefined): LlmConfigurableProvider => ({
    provider: PROVIDER_ID,
    displayName: DISPLAY_NAME,
    settingsNs,
    // This plugin's profile is the entry's whole `config:` mapping — the
    // bundled `cordis.patch.yml` inserts `id: dshopencodego` with the route's
    // fields directly under `config`, and `src/config.ts` owns exactly those
    // fields — so there is no path from the section root to a nested profile.
    settingsPath: [],
    defaultBaseURL: DEFAULT_BASE_URL,
    ...error === undefined ? {} : { error },
  })

  /**
   * Publish this route in the configurable-provider directory.
   *
   * Two facts ride on the entry: the `settingsNs` that lets a configuration
   * surface start model discovery for this provider, and an `error` that says
   * why the route is withheld. A missing credential is a configuration fact a
   * user can repair, so it is published; a route withdrawn by `enabled: false`
   * is deliberate and publishes nothing. Failures are contained: the directory
   * is configuration-surface metadata, and losing it must not take the route,
   * its discovery, or this mount down.
   * @param error - the repair diagnostic, or undefined when the route is fine.
   */
  const publishDirectory = (error: string | undefined): void => {
    if (directoryRetired || (directory !== undefined && error === directoryError)) return
    directoryError = error
    const entry = directoryEntry(error)
    try {
      if (directory === undefined) directory = ctx.llm.registerConfigurableProviders([entry])
      else directory.replace([entry])
    } catch (failure: unknown) {
      directoryRetired = true
      ctx.logger.error(
        `dshopencodego: could not publish the "${PROVIDER_ID}" configurable-provider entry;`
        + ` the Models page will not offer this route's model discovery (${String(failure)})`,
      )
    }
  }
  // The entry exists from the first moment: a configuration surface must be
  // able to name this provider before any credential is stored for it.
  publishDirectory(undefined)

  /** Resolve the route credential; a named reference that misses fails loud. */
  const resolveApiKey = async (): Promise<string | undefined> => {
    const ref = current().apiKeyEnv
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(credentialRef(ref)))?.value
      // Without the credentials seam the process environment is the whole
      // credential plane.
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) return llm.assertUsableApiKey(hit, name, ref)
    throw new LlmError(
      `dshopencodego: no credential; the profile resolves ${ref}, which is not set — store ${ref} through the`
      + ' credentials service (the Web Models page writes it) or export it',
      'MISSING_CREDENTIAL',
    )
  }

  const meter = new UsageMeter()
  const adapter = new OpencodeGoAdapter({
    config: current,
    resolveApiKey,
    imageAccess: {
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) => llm.resolveImageAttachmentAccess(
        attachments,
        hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
        ref,
      ),
    },
    onFallback: ({ url, error }) => {
      ctx.logger.warn(`dshopencodego: could not refresh ${url}; using the last known model data (${String(error)})`)
    },
    onUnconfigured: (entries) => {
      ctx.logger.warn(`dshopencodego: gateway models this build cannot configure: ${
        entries.map(entry => `${entry.id} (${entry.reason})`).join(', ')}`)
    },
    onReplayDegrade: (reason) => {
      ctx.logger.warn(`dshopencodego: unusable replay state on assistant history; sending provider-neutral content (${reason})`)
    },
    onUsage: ({ model, usage }) => { meter.record(model, usage) },
  })

  // The usage Remote is mounted before the route so a picker can read it even
  // while the route is withdrawn for a missing credential.
  registerRemotes(ctx)
  ctx.plugin(OpencodeGoUsageService, {
    baseURL: () => current().baseURL,
    resolveApiKey,
    meter,
  })
  ctx.plugin(OpencodeGoCatalogService, {
    catalog: () => adapter.catalogOf(current()),
    visibility: () => current().modelVisibility,
    onUnadvertised: (ids) => {
      // A switch for an id the gateway does not advertise is silently inert:
      // unlike `onUnconfigured` (listed, but unbuildable) nothing else reports
      // it, so the diagnostic exists here. Reported once per distinct set, on
      // a catalog reading — never per request.
      ctx.logger.warn(`dshopencodego: modelVisibility configures models the gateway does not advertise: ${
        ids.join(', ')}; those switches have no effect until the gateway publishes them`)
    },
  })
  ctx.plugin(OpencodeGoUpdateService, { currentVersion: PLUGIN_VERSION })

  let registration: AdapterRegistrationHandle | undefined
  let visibilityFacts = JSON.stringify(current().modelVisibility)

  /**
   * Register the route while it is enabled and its credential resolves, and
   * drop it when either says no.
   *
   * Nothing else is torn down with the route: model discovery and the
   * configuration surface stay mounted, so the switch that withdrew the route
   * stays reachable to bring it back.
   */
  const applyRoute = (credentialConfigured: boolean): void => {
    const enabled = current().enabled
    if (enabled && credentialConfigured && registration === undefined) {
      try {
        registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
      } catch (error: unknown) {
        // Most likely DUPLICATE_ADAPTER: another adapter family already owns
        // `opencode-go` (an `llm-pi-ai` profile, or the previous plugin).
        // Everything else this mount does keeps working.
        ctx.logger.error(
          `dshopencodego: not registering the "${PROVIDER_ID}" route — another adapter already owns it;`
          + ` uninstall or disable the other provider first (${String(error)})`,
        )
      }
    } else if ((!enabled || !credentialConfigured) && registration !== undefined) {
      registration()
      registration = undefined
      if (!enabled) {
        ctx.logger.info('dshopencodego: disabled by configuration; the route and its models are withdrawn')
      }
    }
    // The directory entry states the route's reparability rather than its
    // existence: a withheld route stays listed so the surface can explain why.
    publishDirectory(enabled && !credentialConfigured
      ? `the route is withheld until ${current().apiKeyEnv} is stored through the credentials service`
      : undefined)
  }

  /**
   * Re-evaluate the route gate against the credential that is in force now.
   *
   * Called from the `loader/volatile-update` listener and from credential
   * events. `registration.replace()` and `directory.replace()` throw
   * `REGISTRATION_DISPOSED` once their registration was released (harness
   * `packages/llm/llm/src/index.ts:321-326` and `:333-347`), and Cordis emits
   * listeners with `Array.map` — one synchronous throw starves every listener
   * registered after this one. The official adapter plugin contains its own
   * listener failures the same way (`llm-pi-ai/src/index.ts:315-321`).
   */
  const syncRoute = (): void => {
    try {
      const visibility = JSON.stringify(current().modelVisibility)
      if (visibility !== visibilityFacts) {
        visibilityFacts = visibility
        // Replacing the owned route notifies every open picker without a restart.
        registration?.replace([PROVIDER_ID])
      }
      const credentials = ctx.get('credentials')
      const ref = current().apiKeyEnv
      if (credentials === undefined) {
        applyRoute(launchEnvironmentOf(ctx).get(ref)?.value !== undefined)
        return
      }
      void credentials.describe(credentialRef(ref))
        .then((info) => {
          // An answer applies only while it still answers for the reference in force.
          if (ref === current().apiKeyEnv) applyRoute(info.configured)
        })
        .catch((error: unknown) => {
          ctx.logger.error(`dshopencodego: credential describe failed; keeping the previous route state (${String(error)})`)
        })
    } catch (error: unknown) {
      ctx.logger.error(
        'dshopencodego: could not re-evaluate the route after a configuration change;'
        + ` keeping the previous route state (${String(error)})`,
      )
    }
  }
  syncRoute()

  const undiscover = ctx.llm.registerModelDiscovery(
    settingsNs,
    async (request: LlmModelDiscoveryRequest, signal?: AbortSignal) => {
      if (request.provider !== PROVIDER_ID && !(request.baseURL ?? '').includes('opencode.ai')) {
        throw new LlmError(
          'dshopencodego discovers only OpenCode Go/Console endpoints; enter this provider\'s models by hand',
          'DISCOVERY_UNSUPPORTED',
        )
      }
      // The harness requires implementations to honor the supplied signal, so a
      // cancelled interrogation stops waiting on the catalog's documentation
      // read instead of finishing a fetch nobody is listening for.
      return discoverCatalogModels(adapter.catalogOf(current()), signal)
    },
  )

  ctx.effect(() => () => {
    registration?.()
    undiscover()
    // Withdrawn with the mount: a disposed directory handle throws
    // REGISTRATION_DISPOSED on any later `replace`.
    directory?.()
    directoryRetired = true
  })

  // Validate a profile edit before it is persisted, then re-evaluate the gate.
  ctx.on('internal/config', function (_raw, next) {
    const value: unknown = next()
    if (this === ctx.fiber) assertBaseURL(PlainConfig(value as OpencodeGoConfig).baseURL)
    return value
  })
  ctx.on('loader/volatile-update', syncRoute)
  ctx.inject(['credentials'], (credentialsCtx) => {
    credentialsCtx.on('credentials/reference-updated', (ref) => {
      if (ref === current().apiKeyEnv) syncRoute()
    })
    // The seam can become visible after this plugin applied, so the boot-time
    // call may have fallen back to the environment: sync again here.
    syncRoute()
  })

  ctx.logger.info(`dshopencodego: route "${PROVIDER_ID}" registered as ${DISPLAY_NAME}`)
}
