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
import type { UpdateStatus } from './check.ts'

export type { UpdateStatus } from './check.ts'

/** Validate an update reading crossing the wire. */
export function parseUpdateStatus(value: unknown): UpdateStatus {
  if (value === null || typeof value !== 'object') throw new Error('invalid update reading')
  const row = value as Record<string, unknown>
  if (typeof row['current'] !== 'string') throw new Error('invalid update reading')
  if (row['latest'] !== undefined && typeof row['latest'] !== 'string') throw new Error('invalid update reading')
  if (typeof row['available'] !== 'boolean') throw new Error('invalid update reading')
  if (typeof row['checkedAt'] !== 'number' || !Number.isFinite(row['checkedAt'])) {
    throw new Error('invalid update reading')
  }
  return {
    current: row['current'],
    latest: typeof row['latest'] === 'string' ? row['latest'] : undefined,
    available: row['available'],
    checkedAt: row['checkedAt'],
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    opencodeGoUpdate: {
      readUpdate(): Promise<RemoteResult<UpdateStatus>>
      refreshUpdate(): Promise<RemoteResult<UpdateStatus>>
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
  ],
}
