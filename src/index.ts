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
import dc from 'node:diagnostics_channel'
// Type-only: pulls the loader's `ctx.fiber.entry` merge, which supplies this
// mount's entry id — the settings namespace both discovery and the DSH Models
// page are keyed by.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import * as llm from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import { OpencodeGoAdapter } from './adapter.ts'
import { DISPLAY_NAME, PROVIDER_ID, discoverCatalogModels } from './catalog/index.ts'
import { assertBaseURL, PlainConfig, readConfig } from './config.ts'
import type { LiveConfig, OpencodeGoConfig } from './config.ts'
import { registerRemotes } from './remotes.ts'
import { OpencodeGoCatalogService } from './catalog/service.ts'
import { closeDispatcher, gatewayFetch as fetchThroughPin, observePool, resolveGatewayPin } from './network/pinning.ts'
import { OpencodeGoNetworkService } from './network/service.ts'
import { OpencodeGoRequestLogService, RequestLog } from './request-log/index.ts'
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
export { DEFAULT_BASE_URL, CONSOLE_BASE_URL, DISPLAY_NAME, PROVIDER_ID, OpencodeGoCatalog, discoverCatalogModels, fetchModelIds } from './catalog/index.ts'
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
 * Where this plugin remembers what it discovered.
 *
 * The Harness publishes a home-path resolver on the context
 * (`ctx.dshHomePath`, provided by `app-boot`), and that resolver already
 * follows the Harness' own rule — `$DSH_HOME`, then `~/.dsh` — so a custom
 * home is respected instead of writing the cache beside the wrong tree.
 *
 * Without a resolver there is no home to write into, and the plugin writes
 * nothing. That is not a loss: the resolver is present in every host the
 * Harness runs, and a context without one is a context that is not a
 * Harness — a test, or an embedder that has its own idea of where state
 * belongs. Falling back to a guessed path there would put this plugin's
 * cache into somebody's home directory without asking, and would let a
 * test's fixtures overwrite the real one.
 * @param ctx - the plugin's Cordis context.
 * @returns the directory the cache belongs in, or undefined when there is
 *   no home to put it in.
 */
function resolveCacheDir(ctx: Context): string | undefined {
  const home = (ctx as { dshHomePath?: (...segments: string[]) => string }).dshHomePath
  if (typeof home !== 'function') return undefined
  try {
    return home('cache', '@dan-ai-studio/dshopencodego')
  } catch {
    // A resolver that throws is no resolver.
    return undefined
  }
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
  // DSH keys configuration and model discovery by. `registerModelDiscovery` is
  // keyed by it, and a configuration surface starts a discovery for a provider
  // whose entry names this namespace. A bare mount (programmatic use, tests)
  // has no loader entry, so the module name stands in — the same fallback the
  // official single-route plugins use.
  const settingsNs = ctx.fiber?.entry?.options.id ?? name

  // This mount deliberately publishes **no** configurable-provider directory
  // entry, and the reason is worth keeping here so nobody adds one back.
  //
  // `opencode-go` is a provider the bundled `llm-pi-ai` already declares: it
  // walks pi-ai's entire builtin catalog (`llm-pi-ai/src/index.ts:148`). That
  // directory is keyed by provider, so only one declaration can exist
  // (`llm/src/index.ts:515-518`, `DUPLICATE_DIRECTORY`) — whoever registers
  // first wins. And `llm-pi-ai` registers without a try/catch
  // (`llm-pi-ai/src/index.ts:246-261`): if this plugin ever loaded first, the
  // throw would escape that plugin's `apply` and take every pi-ai provider
  // down with it.
  //
  // Declaring an entry here would therefore buy nothing — the Models page
  // already offers `opencode-go` through pi-ai — while adding a
  // load-order-dependent way to break a neighbour. What this mount keeps is
  // the part that is genuinely its own: the `settingsNs` above, so discovery
  // is registered under the namespace a surface would look up, and the signal
  // forwarding inside that registration.

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
  const cacheDir = resolveCacheDir(ctx)
  /**
   * The per-request log. Disabled by default, and then it costs nothing:
   * `start` returns undefined without constructing a span, pool events are
   * still observed (rare by construction) but dropped on the floor, and the
   * fetch below is the pin's own.
   *
   * The gates read the live configuration on every call, so flipping the
   * switches in the settings page takes effect on the next request without
   * a restart — and turning them off returns the request path to exactly
   * what it was.
   */
  const requestLog = new RequestLog({
    enabled: () => current().requestLogEnabled,
    debug: () => current().requestLogDebug,
    maxEntries: () => current().requestLogMaxEntries,
  })
  // Pool lifecycle is rare by construction (pools live for minutes), so
  // observing it costs nothing on the request path. The store itself drops
  // the events unless debug mode is on.
  observePool({
    create: (key) => { requestLog.poolEvent('create', key) },
    close: (key) => { requestLog.poolEvent('close', key) },
  })
  // New connections are counted here, not on the request path: the channel
  // only fires when a socket is actually established, which is exactly the
  // event keep-alive exists to avoid.
  ctx.effect(() => {
    const channel = dc.channel('undici:client:connected')
    const onConnect = (): void => { requestLog.connectionOpened() }
    channel.subscribe(onConnect)
    return () => { channel.unsubscribe(onConnect) }
  }, 'dshopencodego: connection counter')
  /**
   * The fetch every gateway request is made through.
   *
   * The pin is read from the live configuration on every call, so a profile
   * edit reaches the next request without a restart. With no pin configured
   * this is the system's own fetch, with nothing added to it.
   */
  const gatewayRequest = (): typeof fetch => fetchThroughPin(
    resolveGatewayPin(current().pinnedAddresses, current().baseURL),
    current().keepAliveTimeoutMs,
  )
  const adapter = new OpencodeGoAdapter({
    config: current,
    resolveApiKey,
    fetch: gatewayRequest,
    ...cacheDir === undefined ? {} : { cacheDir },
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
    requestLog,
  })

  // The usage Remote is mounted before the route so a picker can read it even
  // while the route is withdrawn for a missing credential.
  registerRemotes(ctx)
  ctx.plugin(OpencodeGoUsageService, {
    baseURL: () => current().baseURL,
    resolveApiKey,
    meter,
    fetch: gatewayRequest,
  })
  // The viewer reads this on demand; a closed viewer costs no wire traffic.
  ctx.plugin(OpencodeGoRequestLogService, {
    log: requestLog,
    maxEntries: () => current().requestLogMaxEntries,
  })
  ctx.plugin(OpencodeGoNetworkService, {
    baseURL: () => current().baseURL,
    pinnedAddresses: () => current().pinnedAddresses,
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

  // Warm the catalog while the host is still starting up.
  //
  // The first thing a new session does is resolve its model, and resolving a
  // model builds the catalog: the gateway listing, the provider's document,
  // and the model metadata — 5.6 MB of it, which is a download measured in
  // seconds on a desktop build. The wait lands on the first message of a
  // session, which is where a user notices it, and it is paid again on
  // every restart because a fresh process has nothing to show for the last
  // one.
  //
  // So the catalog is asked for here, in the background, while the host
  // starts. By the time a session resolves its model, the answer is usually
  // already there. The read is the same one the session would make, so
  // nothing is fetched twice: the catalog serves the second caller from
  // what the first one built.
  //
  // The wait is not waited for — a mount that blocks on the network is a
  // mount that fails to start when the network is slow — and a warm-up that
  // fails is not an error: the session's own read will report it properly.
  ctx.effect(() => {
    void adapter.catalogOf(current()).snapshot().catch(() => undefined)
    // Nothing to undo: the read either finishes or fails on its own, and
    // either way the session's own read is the one that reports.
    return () => {}
  }, 'dshopencodego: catalog warm-up')

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
  }

  /**
   * Re-evaluate the route gate against the credential that is in force now.
   *
   * Called from the `loader/volatile-update` listener and from credential
   * events. `registration.replace()` throws `REGISTRATION_DISPOSED` once its
   * registration was released (harness `packages/llm/llm/src/index.ts:321-326`),
   * and Cordis emits
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
    // The gateway connection pool is this plugin's, and the plugin's life is
    // the host's — so when the plugin goes away, the sockets should go with
    // it rather than linger until the process ends. The disposer is allowed
    // to be async, and the host awaits it, so the sockets are really closed
    // before the next version of the plugin starts.
    return closeDispatcher()
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
