/**
 * Host half of the request-log Remote.
 *
 * The viewer opens the snapshot on demand and refreshes it when asked; the
 * Host never pushes. A closed viewer therefore costs no wire traffic at all,
 * and an open one costs one read per refresh.
 *
 * @module @dan-ai-studio/dshopencodego/request-log/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RequestLog, RequestLogSnapshot } from './store.ts'

/** Host inputs for the request-log service. */
export interface RequestLogServiceOptions {
  /** The bounded ring the adapter appends to. */
  readonly log: RequestLog
  /** How many entries to keep; the ring trims to it on every read. */
  readonly maxEntries: () => number
}

/** Request-log Remote: one on-demand snapshot of the ring. */
export class OpencodeGoRequestLogService extends TypertRemoteService {
  private readonly options: RequestLogServiceOptions

  constructor(ctx: Context, options: RequestLogServiceOptions) {
    super(ctx, 'opencodeGoRequestLog')
    this.options = options
  }

  /** The current reading, trimmed to the configured bound first. */
  readLog(): RequestLogSnapshot {
    // A lowered bound takes effect on the next read, not just the next
    // request: the viewer never shows more than the profile allows.
    this.options.log.setMaxEntries(this.options.maxEntries())
    return this.options.log.snapshot()
  }
}
