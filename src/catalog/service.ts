/**
 * Host half of the catalog Remote.
 *
 * Both methods return the same projection; they differ only in whether the
 * cache may answer. `refresh` is what the settings page's button calls, and it
 * revalidates the gateway listing and the online metadata before projecting.
 *
 * @module @dan-ai-studio/dshopencodego/catalog/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { OpencodeGoCatalog } from './index.ts'
import { catalogReading } from './reading.ts'
import type { CatalogReading } from './reading.ts'

/** Host inputs for the catalog service. */
export interface CatalogServiceOptions {
  /** The route's current catalog resolver. */
  readonly catalog: () => OpencodeGoCatalog
  /** Current per-model visibility switches. */
  readonly visibility: () => Readonly<Record<string, boolean>>
}

/** Catalog Remote: what the gateway serves, and how each model is called. */
export class OpencodeGoCatalogService extends TypertRemoteService {
  private readonly options: CatalogServiceOptions

  constructor(ctx: Context, options: CatalogServiceOptions) {
    super(ctx, 'opencodeGoCatalog')
    this.options = options
  }

  /** The cached reading. */
  read(): Promise<CatalogReading> {
    return this.project(false)
  }

  /** Revalidate both sources, then read. */
  refresh(): Promise<CatalogReading> {
    return this.project(true)
  }

  private async project(force: boolean): Promise<CatalogReading> {
    const catalog = this.options.catalog()
    const snapshot = await catalog.snapshot(force)
    const failure = snapshot.listingFailure
    return catalogReading(
      snapshot,
      this.options.visibility(),
      failure === undefined
        ? undefined
        : failure instanceof LlmError || failure instanceof Error ? failure.message : String(failure),
    )
  }
}

/** The domain failure the settings page renders when a refresh cannot run. */
export function catalogFailure(error: unknown): RemoteError {
  return new RemoteError('dshopencodego/usage-unavailable', error instanceof Error
    ? error.message
    : 'The OpenCode Go catalog is unavailable', {
    retryable: true,
    retainPrevious: true,
  }, { cause: error })
}
