/**
 * Host half of the update Remote.
 *
 * One method, one question: is a newer release of this package published?
 * The service answers from the registry through the cached checker in
 * `./check.ts`, so the settings page learns about updates without the model
 * path ever touching the network. Applying an update is intentionally absent
 * here — the page drives the host's own `pluginManager` (`removeBundle` then
 * `installBundle`), which owns the manifest lock, peer checks, build
 * approvals, and the HMR lifecycle a self-replacing plugin would bypass.
 *
 * @module @dan-ai-studio/dshopencodego/update/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createUpdateChecker } from './check.ts'
import type { UpdateStatus } from './check.ts'

/** Host inputs for the update service. */
export interface UpdateServiceOptions {
  /** Running build's version. */
  readonly currentVersion: string
}

/** Update Remote: the cached registry reading for the settings page. */
export class OpencodeGoUpdateService extends TypertRemoteService {
  private readonly check: (force?: boolean) => Promise<UpdateStatus>

  constructor(ctx: Context, options: UpdateServiceOptions) {
    super(ctx, 'opencodeGoUpdate')
    const checker = createUpdateChecker({ currentVersion: options.currentVersion })
    this.check = (force?: boolean) => checker.check(force)
  }

  /**
   * Whether a newer release is published (cached reading).
   *
   * The wire method takes no arguments — the gateway client rejects any call
   * whose positional arity differs from the descriptor's `parameters`, so a
   * `force` flag cannot ride this call. Forced revalidation is the separate
   * `refreshUpdate` method below, mirroring the catalog's read/refresh pair.
   */
  readUpdate(): Promise<UpdateStatus> {
    return this.check(false)
  }

  /** Revalidate against the registry, bypassing the cache. */
  refreshUpdate(): Promise<UpdateStatus> {
    return this.check(true)
  }
}
