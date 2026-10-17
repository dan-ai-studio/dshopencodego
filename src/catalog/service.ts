/**
 * Host half of the catalog Remote.
 *
 * Both methods return the same projection; they differ only in whether the
 * cache may answer. `refresh` is what the settings page's button calls, and it
 * revalidates the gateway listing and the online metadata before projecting.
 *
 * A read that cannot be projected at all is this Remote's own domain failure:
 * it carries a catalog code, not the usage Remote's, because the two describe
 * different accounts of the world and a client branches on `code`.
 *
 * @module @dan-ai-studio/dshopencodego/catalog/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { OpencodeGoCatalog, CatalogSnapshot } from './index.ts'
import { catalogReading } from './reading.ts'
import type { CatalogReading } from './reading.ts'
import { unadvertisedVisibilityIds } from '../models.ts'

/** Host inputs for the catalog service. */
interface CatalogServiceOptions {
  /** The route's current catalog resolver. */
  readonly catalog: () => OpencodeGoCatalog
  /** Current per-model visibility switches. */
  readonly visibility: () => Readonly<Record<string, boolean>>
  /**
   * Report configured visibility switches the gateway does not advertise,
   * once per distinct set.
   */
  readonly onUnadvertised?: (ids: readonly string[]) => void
}

/** Catalog Remote: what the gateway serves, and how each model is called. */
export class OpencodeGoCatalogService extends TypertRemoteService {
  private readonly options: CatalogServiceOptions
  /** The last reported set of unadvertised switches, as a comparable fact. */
  private reportedUnadvertised: string | undefined

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
    try {
      const snapshot = await catalog.snapshot(force)
      const failure = snapshot.listingFailure
      const visibility = this.options.visibility()
      const reading = catalogReading(
        snapshot,
        visibility,
        failure === undefined
          ? undefined
          : failure instanceof LlmError || failure instanceof Error ? failure.message : String(failure),
      )
      this.reportUnadvertised(snapshot, visibility)
      return reading
    } catch (error: unknown) {
      throw catalogFailure(error)
    }
  }

  /**
   * Report switches for ids the gateway never advertised.
   *
   * `modelVisibility` is per-id configuration, and an entry naming a model the
   * gateway does not serve has no effect anywhere — the picker cannot show a
   * model that is not in the listing, so without this the switch is silent.
   * (The reverse case, advertised but unbuildable, is `onUnconfigured`.)
   *
   * Only a live listing is evidence of absence: a retained snapshot after an
   * outage would accuse models that merely could not be re-read. The set is
   * compared as a fact, so re-reading the page does not repeat the warning.
   * @param snapshot - the snapshot the reading was projected from.
   * @param visibility - the switches in force for this read.
   */
  private reportUnadvertised(
    snapshot: CatalogSnapshot,
    visibility: Readonly<Record<string, boolean>> | undefined,
  ): void {
    const missing = snapshot.live && visibility !== undefined
      ? unadvertisedVisibilityIds(visibility, [...snapshot.facts.keys(), ...snapshot.unavailable.keys()])
      : []
    const facts = JSON.stringify(missing)
    if (facts === this.reportedUnadvertised) return
    this.reportedUnadvertised = facts
    if (missing.length > 0) this.options.onUnadvertised?.(missing)
  }
}

/**
 * The domain failure the settings page renders when a refresh cannot run.
 *
 * Its code is the catalog's own: a client that branches on the usage code
 * (`client/UsagePill.tsx:39`) must not read a catalog failure as a usage one.
 * @param error - the failure the projection could not turn into a reading.
 * @returns the retryable, retain-previous failure for the wire.
 */
export function catalogFailure(error: unknown): RemoteError {
  return new RemoteError('dshopencodego/catalog-unavailable', error instanceof Error
    ? error.message
    : 'The OpenCode Go catalog is unavailable', {
    retryable: true,
    retainPrevious: true,
  }, { cause: error })
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'dshopencodego/catalog-unavailable': {
      /** Whether retrying the same read could succeed. */
      readonly retryable: boolean
      /** Whether a previously displayed reading stays valid. */
      readonly retainPrevious: boolean
    }
  }
}
