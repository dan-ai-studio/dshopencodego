/**
 * Host half of the usage Remote.
 *
 * The credential never leaves the Host: the browser asks for a reading and gets
 * percentages, and the Host decides whether a failed read may be shown as the
 * previous one. A read that fails while the account is unchanged keeps the last
 * good value and says it is stale; a read for a different endpoint or key
 * invalidates it, because the old numbers describe a different account.
 *
 * @module @dan-ai-studio/dshopencodego/usage/service
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { assertBaseURL } from '../config.ts'
import type { UsageMeter } from './meter.ts'
import type { GoMeter } from './meter.ts'
import { readUsageWindows } from './windows.ts'
import type { GoUsageWindows } from './windows.ts'

/** Host inputs for the usage service. */
export interface UsageServiceOptions {
  /** Current gateway base URL. */
  readonly baseURL: () => string
  /** Resolve the route credential per read. */
  readonly resolveApiKey: () => Promise<string | undefined>
  /** The process-lifetime meter fed by the adapter. */
  readonly meter: UsageMeter
}

/** One endpoint and credential pair, with the opaque identity the client sees. */
interface Identity {
  readonly baseURL: string
  readonly key: string
  readonly source: string
}

/**
 * Decide what one failed read means for the client.
 *
 * A missing credential is a configuration fact, not a transient one: retrying
 * cannot help and the reading a client holds was produced by a *different*
 * account, so it must not be shown as this one's. Any other failure describes
 * the account the client already has a reading for, so that reading stays valid
 * and is marked stale.
 * @param error - the failure raised by credential resolution or the read.
 * @param source - identity of the account the failed read was for.
 * @returns the domain error to send across the wire.
 */
export function usageFailure(error: unknown, source: string | undefined): RemoteError {
  const missing = error instanceof LlmError && error.code === 'MISSING_CREDENTIAL'
  return new RemoteError(
    'dshopencodego/usage-unavailable',
    error instanceof Error ? error.message : 'OpenCode Go usage is unavailable',
    missing
      ? { retryable: false, retainPrevious: false }
      : { retryable: true, retainPrevious: true, ...source === undefined ? {} : { source } },
    { cause: error },
  )
}

/** Usage Remote: account windows from the gateway, spend from this process. */
export class OpencodeGoUsageService extends TypertRemoteService {
  private identity: Identity | undefined
  private readonly options: UsageServiceOptions

  constructor(ctx: Context, options: UsageServiceOptions) {
    super(ctx, 'opencodeGoUsage')
    this.options = options
  }

  /** The account's three windows, or a domain failure the client can render. */
  async readWindows(): Promise<GoUsageWindows> {
    const baseURL = assertBaseURL(this.options.baseURL())
    let key: string | undefined
    try {
      key = await this.options.resolveApiKey()
    } catch (error: unknown) {
      this.identity = undefined
      throw usageFailure(error, undefined)
    }
    if (key === undefined || key.length === 0) {
      this.identity = undefined
      throw usageFailure(new LlmError('No OpenCode Go API key is configured', 'MISSING_CREDENTIAL'), undefined)
    }
    if (this.identity?.baseURL !== baseURL || this.identity.key !== key) {
      // A new account or endpoint invalidates any reading the client holds.
      this.identity = { baseURL, key, source: randomUUID() }
    }
    const { source } = this.identity
    try {
      return await readUsageWindows({ baseURL, apiKey: key, source })
    } catch (error: unknown) {
      throw usageFailure(error, source)
    }
  }

  /** What this process has spent through the route since it started. */
  readMeter(): GoMeter {
    return this.options.meter.snapshot()
  }
}
