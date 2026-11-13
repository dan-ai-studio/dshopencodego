/**
 * Wire contract for the update Remote.
 *
 * `readUpdate` answers whether a newer release of this package is published.
 * The reading is advisory — applying the update stays a user click that
 * drives the host's `pluginManager`, never an automatic download.
 *
 * @module @dan-ai-studio/dshopencodego/update/contract
 */

import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { DesktopReading, DesktopRelease } from '../desktop/feed.ts'
import type { UpdateStatus } from './check.ts'

export type { UpdateStatus } from './check.ts'
export type { DesktopReading, DesktopRelease } from '../desktop/feed.ts'

/** Validate an update reading crossing the wire. */
export function parseUpdateStatus(value: unknown): UpdateStatus {
  if (value === null || typeof value !== 'object') throw new Error('invalid update reading')
  const row = value as Record<string, unknown>
  if (typeof row['current'] !== 'string') throw new Error('invalid update reading')
  if (row['latest'] !== undefined && typeof row['latest'] !== 'string') throw new Error('invalid update reading')
  if (typeof row['available'] !== 'boolean') throw new Error('invalid update reading')
  if (typeof row['checked'] !== 'boolean') throw new Error('invalid update reading')
  if (typeof row['checkedAt'] !== 'number' || !Number.isFinite(row['checkedAt'])) {
    throw new Error('invalid update reading')
  }
  return {
    current: row['current'],
    latest: typeof row['latest'] === 'string' ? row['latest'] : undefined,
    available: row['available'],
    checkedAt: row['checkedAt'],
    checked: row['checked'],
  }
}

/** Validate one published installer crossing the wire. */
function parseRelease(value: unknown): DesktopRelease {
  if (value === null || typeof value !== 'object') throw new Error('invalid desktop release')
  const row = value as Record<string, unknown>
  const version = row['version']
  const url = row['url']
  if (typeof version !== 'string' || version.length === 0) throw new Error('invalid desktop release')
  if (typeof url !== 'string' || url.length === 0) throw new Error('invalid desktop release')
  const size = row['size']
  const sha512 = row['sha512']
  const stagingPercentage = row['stagingPercentage']
  const releaseDate = row['releaseDate']
  return {
    version,
    url,
    ...typeof size === 'number' && Number.isFinite(size) && size >= 0 ? { size } : {},
    ...typeof sha512 === 'string' && sha512.length > 0 ? { sha512 } : {},
    ...typeof stagingPercentage === 'number' && Number.isFinite(stagingPercentage)
      ? { stagingPercentage }
      : {},
    ...typeof releaseDate === 'string' && releaseDate.length > 0 ? { releaseDate } : {},
  }
}

/** Validate a desktop download reading crossing the wire. */
export function parseDesktopReading(value: unknown): DesktopReading {
  if (value === null || typeof value !== 'object') throw new Error('invalid desktop reading')
  const row = value as Record<string, unknown>
  if (typeof row['checked'] !== 'boolean') throw new Error('invalid desktop reading')
  if (typeof row['checkedAt'] !== 'number' || !Number.isFinite(row['checkedAt'])) {
    throw new Error('invalid desktop reading')
  }
  if (typeof row['platform'] !== 'string') throw new Error('invalid desktop reading')
  if (typeof row['channel'] !== 'string') throw new Error('invalid desktop reading')
  const release = row['release']
  return {
    checked: row['checked'],
    checkedAt: row['checkedAt'],
    platform: row['platform'],
    channel: row['channel'],
    ...release === undefined ? {} : { release: parseRelease(release) },
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    opencodeGoUpdate: {
      readUpdate(): Promise<RemoteResult<UpdateStatus>>
      refreshUpdate(): Promise<RemoteResult<UpdateStatus>>
      readDesktop(): Promise<RemoteResult<DesktopReading>>
      refreshDesktop(): Promise<RemoteResult<DesktopReading>>
    }
  }
}

/** Codec shape accepted by both released and source DSH builds. */
const codec = (typeSymbol: string, parse: (value: unknown) => unknown): {
  mode: 'strict'
  typeSymbol: string
  schema: { parse: (value: unknown) => unknown }
  create: () => { parse: (value: unknown) => unknown }
} => ({
  mode: 'strict',
  typeSymbol,
  schema: { parse },
  create: () => ({ parse }),
})

/** Remote methods this package owns, mounted together by the plugin. */
export const updateRemote: TypertRemoteContribution = {
  package: '@dan-ai-studio/dshopencodego',
  descriptors: [
    {
      id: '@dan-ai-studio/dshopencodego#opencodeGoUpdate/readUpdate',
      service: 'opencodeGoUpdate',
      namespace: 'opencodeGoUpdate',
      method: 'readUpdate',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@dan-ai-studio/dshopencodego#UpdateStatus', parseUpdateStatus),
    },
    {
      id: '@dan-ai-studio/dshopencodego#opencodeGoUpdate/refreshUpdate',
      service: 'opencodeGoUpdate',
      namespace: 'opencodeGoUpdate',
      method: 'refreshUpdate',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@dan-ai-studio/dshopencodego#UpdateStatus', parseUpdateStatus),
    },
    // The desktop download feed rides this namespace rather than one of its
    // own. A separate namespace would need its descriptor listed in both the
    // Host contribution and the Client's `$mount`, and a namespace missing
    // from either side is invisible in a way that takes the whole settings
    // section with it (0.1.92). Riding `opencodeGoUpdate` — a namespace that
    // already mounts — makes that class of defect impossible here.
    {
      id: '@dan-ai-studio/dshopencodego#opencodeGoUpdate/readDesktop',
      service: 'opencodeGoUpdate',
      namespace: 'opencodeGoUpdate',
      method: 'readDesktop',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@dan-ai-studio/dshopencodego#DesktopReading', parseDesktopReading),
    },
    {
      id: '@dan-ai-studio/dshopencodego#opencodeGoUpdate/refreshDesktop',
      service: 'opencodeGoUpdate',
      namespace: 'opencodeGoUpdate',
      method: 'refreshDesktop',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@dan-ai-studio/dshopencodego#DesktopReading', parseDesktopReading),
    },
  ],
}
