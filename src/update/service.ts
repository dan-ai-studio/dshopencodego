/**
 * Host half of the update Remote.
 *
 * Two questions, one namespace: is a newer release of this package published,
 * and where does the newest desktop installer live? Both are advisory reads
 * the settings page asks for on open.
 *
 * The desktop methods ride this namespace instead of one of their own on
 * purpose. A separate namespace has to be listed in the Host contribution
 * *and* in the Client's `$mount`, and a namespace missing from either side is
 * invisible in a way that takes the whole settings section down with it — that
 * is the 0.1.92 regression. `opencodeGoUpdate` already mounts, so adding
 * methods to it cannot fail that way.
 *
 * Applying an update is intentionally absent here — the page drives the host's
 * own `pluginManager` (`removeBundle` then `installBundle`), which owns the
 * manifest lock, peer checks, build approvals, and the HMR lifecycle a
 * self-replacing plugin would bypass.
 *
 * @module @dan-ai-studio/dshopencodego/update/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createDesktopFeedReader } from '../desktop/feed.ts'
import type { DesktopReading } from '../desktop/feed.ts'
import { createUpdateChecker } from './check.ts'
import type { UpdateStatus } from './check.ts'

/** Host inputs for the update service. */
export interface UpdateServiceOptions {
  /** Running build's version. */
  readonly currentVersion: string
}

/** Update Remote: the cached registry reading and the desktop download feed. */
export class OpencodeGoUpdateService extends TypertRemoteService {
  private readonly check: (force?: boolean) => Promise<UpdateStatus>
  private readonly desktop: (force?: boolean) => Promise<DesktopReading>

  constructor(ctx: Context, options: UpdateServiceOptions) {
    super(ctx, 'opencodeGoUpdate')
    const checker = createUpdateChecker({ currentVersion: options.currentVersion })
    this.check = (force?: boolean) => checker.check(force)
    const feed = createDesktopFeedReader()
    this.desktop = (force?: boolean) => feed.read(force)
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

  /**
   * The newest published desktop installer (cached feed reading).
   *
   * Same zero-argument shape as `readUpdate`, and for the same reason.
   */
  readDesktop(): Promise<DesktopReading> {
    return this.desktop(false)
  }

  /** Revalidate against the desktop download feed, bypassing the cache. */
  refreshDesktop(): Promise<DesktopReading> {
    return this.desktop(true)
  }
}
