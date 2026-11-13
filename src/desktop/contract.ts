/**
 * Wire contract for the desktop Remote.
 *
 * `readDesktop` answers which installer the desktop download host publishes
 * right now, and where it lives. The reading is advisory: the page shows the
 * address so a human can copy it or open it in a browser, and nothing here
 * downloads or installs anything.
 *
 * @module @dan-ai-studio/dshopencodego/desktop/contract
 */

import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { DesktopReading, DesktopRelease } from './feed.ts'

export type { DesktopReading, DesktopRelease } from './feed.ts'

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

/** Validate a desktop reading crossing the wire. */
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
    opencodeGoDesktop: {
      readDesktop(): Promise<RemoteResult<DesktopReading>>
      refreshDesktop(): Promise<RemoteResult<DesktopReading>>
    }
  }
}

/** Codec shape accepted by both released and source DSH builds. */
const codec = {
  mode: 'strict' as const,
  typeSymbol: '@dan-ai-studio/dshopencodego#DesktopReading',
  schema: { parse: parseDesktopReading },
  create: () => ({ parse: parseDesktopReading }),
}

/** Remote methods this package owns, mounted together by the plugin. */
export const desktopRemote: TypertRemoteContribution = {
  package: '@dan-ai-studio/dshopencodego',
  descriptors: [
    {
      id: '@dan-ai-studio/dshopencodego#opencodeGoDesktop/readDesktop',
      service: 'opencodeGoDesktop',
      namespace: 'opencodeGoDesktop',
      method: 'readDesktop',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec,
    },
    {
      id: '@dan-ai-studio/dshopencodego#opencodeGoDesktop/refreshDesktop',
      service: 'opencodeGoDesktop',
      namespace: 'opencodeGoDesktop',
      method: 'refreshDesktop',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec,
    },
  ],
}
