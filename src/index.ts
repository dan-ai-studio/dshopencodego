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
 *     baseURL: https://opencode.ai/zen/go/v1     # default
 *     refreshMinutes: 60                         # live catalog TTL
 *     modelProtocols:                            # last-resort protocol override
 *       some-model: openai-responses
 * ```
 *
 * @module @dan-ai-studio/dshopencodego
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import { OpencodeGoAdapter } from './adapter.ts'
import { DISPLAY_NAME, PROVIDER_ID, discoverCatalogModels } from './catalog/index.ts'
import { assertBaseURL, PlainConfig, readConfig } from './config.ts'
import type { LiveConfig, OpencodeGoConfig } from './config.ts'
import { registerRemotes } from './remotes.ts'
import { OpencodeGoUsageService, UsageMeter } from './usage/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

export { OpencodeGoAdapter } from './adapter.ts'
export type { OpencodeGoAdapterOptions, OpencodeGoImageAccess } from './adapter.ts'
export { DEFAULT_BASE_URL, DISPLAY_NAME, PROVIDER_ID, OpencodeGoCatalog, discoverCatalogModels } from './catalog/index.ts'
export { Config, PlainConfig, assertBaseURL, DEFAULT_API_KEY_ENV } from './config.ts'
export type { OpencodeGoConfig } from './config.ts'
export { SESSION_HEADER, opencodeSessionValue, providerHeaders } from './session-header.ts'
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

  /** Resolve the route credential; a named reference that misses fails loud. */
  const resolveApiKey = async (): Promise<string | undefined> => {
    const ref = current().apiKeyEnv
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(credentialRef(ref)))?.value
      // Without the credentials seam the process environment is the whole
      // credential plane.
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, name, ref)
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
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
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

  /** Re-evaluate the route gate against the credential that is in force now. */
  const syncRoute = (): void => {
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
  }
  syncRoute()

  const undiscover = ctx.llm.registerModelDiscovery(name, async (request: LlmModelDiscoveryRequest) => {
    if (request.provider !== PROVIDER_ID && !(request.baseURL ?? '').includes('opencode.ai')) {
      throw new LlmError(
        'dshopencodego discovers only OpenCode zen/go endpoints; enter this provider\'s models by hand',
        'DISCOVERY_UNSUPPORTED',
      )
    }
    return discoverCatalogModels(adapter.catalogOf(current()))
  })

  ctx.effect(() => () => {
    registration?.()
    undiscover()
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
