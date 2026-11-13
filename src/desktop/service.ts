/**
 * Host half of the desktop Remote.
 *
 * One question: which installer does the desktop download host publish right
 * now? The service answers from the cached feed reader in `./feed.ts`, so the
 * settings page learns the address without the model path ever touching the
 * network. Downloading and installing are intentionally absent — this only
 * reports where the installer lives.
 *
 * @module @dan-ai-studio/dshopencodego/desktop/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createDesktopFeedReader } from './feed.ts'
import type { DesktopReading } from './feed.ts'

/** Desktop Remote: the cached feed reading for the settings page. */
export class OpencodeGoDesktopService extends TypertRemoteService {
  private readonly read: (force?: boolean) => Promise<DesktopReading>

  constructor(ctx: Context) {
    super(ctx, 'opencodeGoDesktop')
    const reader = createDesktopFeedReader()
    this.read = (force?: boolean) => reader.read(force)
  }

  /**
   * The newest published installer (cached reading).
   *
   * The wire method takes no arguments — the gateway client rejects any call
   * whose positional arity differs from the descriptor's `parameters`, so a
   * `force` flag cannot ride this call. Forced revalidation is the separate
   * `refreshDesktop` method below, mirroring the update Remote's pair.
   */
  readDesktop(): Promise<DesktopReading> {
    return this.read(false)
  }

  /** Revalidate against the feed, bypassing the cache. */
  refreshDesktop(): Promise<DesktopReading> {
    return this.read(true)
  }
}
