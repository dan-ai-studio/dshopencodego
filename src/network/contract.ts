/**
 * Wire contract for the network Remote.
 *
 * One reading, answering one question: which address is the gateway sent to
 * right now, and did that address survive its first request?
 *
 * A spent address is not a failure the user has to fix — the requests are
 * being served by the system's own resolution, and this says so.
 *
 * @module @dan-ai-studio/dshopencodego/network/contract
 */

import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

/** The gateway's name and the address it is pinned to. */
export interface NetworkReading {
  /** The gateway's name. */
  readonly host: string
  /** The address the name is pinned to; absent when nothing is pinned. */
  readonly address?: string
  /** Whether the pinned address was found to be gone. */
  readonly failed?: boolean
}

/** Validate a network reading crossing the wire. */
export function parseNetworkReading(value: unknown): NetworkReading {
  if (value === null || typeof value !== 'object') throw new Error('invalid network reading')
  const row = value as Record<string, unknown>
  const host = row['host']
  if (typeof host !== 'string') throw new Error('invalid network reading')
  const address = row['address']
  const failed = row['failed']
  return {
    host,
    ...typeof address === 'string' && address.length > 0 ? { address } : {},
    ...typeof failed === 'boolean' ? { failed } : {},
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    opencodeGoNetwork: {
      readNetwork(): Promise<RemoteResult<NetworkReading>>
    }
  }
}

/** Codec shape accepted by both released and source DSH builds. */
const codec = {
  mode: 'strict' as const,
  typeSymbol: '@dan-ai-studio/dshopencodego#NetworkReading',
  schema: { parse: parseNetworkReading },
  create: () => ({ parse: parseNetworkReading }),
}

/** Remote methods this package owns, mounted together by the plugin. */
export const networkRemote: TypertRemoteContribution = {
  package: '@dan-ai-studio/dshopencodego',
  descriptors: [
    {
      id: '@dan-ai-studio/dshopencodego#opencodeGoNetwork/readNetwork',
      service: 'opencodeGoNetwork',
      namespace: 'opencodeGoNetwork',
      method: 'readNetwork',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec,
    },
  ],
}
