/**
 * Wire contract for the catalog Remote.
 *
 * `read` serves the cached snapshot; `refresh` revalidates both sources first.
 * The distinction is the whole point of the settings page's refresh button: the
 * runtime TTL exists so sessions do not re-fetch on every request, and a human
 * asking "what does the gateway serve right now" must not be answered from
 * that cache.
 *
 * @module @dan-ai-studio/dshopencodego/catalog/contract
 */

import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { ModelSummary } from '../models.ts'
import type { GoQuota } from '../go-limits.ts'
import type { CatalogReading } from './reading.ts'

export type { CatalogReading } from './reading.ts'

function parseGoQuota(value: unknown): GoQuota {
  if (value === null || typeof value !== 'object') throw new Error('invalid go quota')
  const row = value as Record<string, unknown>
  const usd = row['monthlyUsd']
  if (usd !== 'unlimited' && (typeof usd !== 'number' || !Number.isFinite(usd))) {
    throw new Error('invalid go quota monthlyUsd')
  }
  const requests = row['monthlyRequests']
  if (requests !== undefined && requests !== 'unlimited'
    && (typeof requests !== 'number' || !Number.isFinite(requests))) {
    throw new Error('invalid go quota monthlyRequests')
  }
  return {
    monthlyUsd: usd as number | 'unlimited',
    ...requests === undefined ? {} : { monthlyRequests: requests as number | 'unlimited' },
  }
}

function parseCost(value: unknown): { input: number; output: number; cacheRead?: number; cacheWrite?: number } {
  if (value === null || typeof value !== 'object') throw new Error('invalid model cost')
  const row = value as Record<string, unknown>
  const rate = (key: string): number => {
    const entry = row[key]
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) throw new Error(`invalid model cost "${key}"`)
    return entry
  }
  return {
    input: rate('input'),
    output: rate('output'),
    ...typeof row['cacheRead'] === 'number' ? { cacheRead: rate('cacheRead') } : {},
    ...typeof row['cacheWrite'] === 'number' ? { cacheWrite: rate('cacheWrite') } : {},
  }
}

function parseModel(value: unknown): ModelSummary {
  if (value === null || typeof value !== 'object') throw new Error('invalid catalog model')
  const row = value as Record<string, unknown>
  if (typeof row['id'] !== 'string' || row['id'].length === 0) throw new Error('invalid catalog model id')
  return {
    id: row['id'],
    name: typeof row['name'] === 'string' ? row['name'] : row['id'],
    ...typeof row['contextWindow'] === 'number' ? { contextWindow: row['contextWindow'] } : {},
    ...typeof row['maxInputTokens'] === 'number' ? { maxInputTokens: row['maxInputTokens'] } : {},
    ...typeof row['maxTokens'] === 'number' ? { maxTokens: row['maxTokens'] } : {},
    ...typeof row['deprecated'] === 'boolean' ? { deprecated: row['deprecated'] } : {},
    ...typeof row['releaseDate'] === 'string' ? { releaseDate: row['releaseDate'] } : {},
    ...row['goQuota'] === undefined ? {} : { goQuota: parseGoQuota(row['goQuota']) },
    ...row['cost'] === undefined ? {} : { cost: parseCost(row['cost']) },
    ...row['protocolSource'] === 'builtin' || row['protocolSource'] === 'online'
      || row['protocolSource'] === 'inferred' || row['protocolSource'] === 'override'
      ? { protocolSource: row['protocolSource'] } : {},
    ...typeof row['assumedLimits'] === 'boolean' ? { assumedLimits: row['assumedLimits'] } : {},
    ...typeof row['configurationMissing'] === 'string' ? { configurationMissing: row['configurationMissing'] } : {},
  }
}

/** Validate a catalog reading crossing the wire. */
export function parseCatalogReading(value: unknown): CatalogReading {
  if (value === null || typeof value !== 'object') throw new Error('invalid catalog reading')
  const row = value as Record<string, unknown>
  const counts = row['counts']
  if (!Array.isArray(row['models']) || typeof row['stale'] !== 'boolean'
    || typeof row['fetchedAtMs'] !== 'number' || counts === null || typeof counts !== 'object') {
    throw new Error('invalid catalog reading')
  }
  const numbers = counts as Record<string, unknown>
  const count = (key: string): number => {
    const entry = numbers[key]
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) throw new Error(`invalid catalog count "${key}"`)
    return entry
  }
  return {
    models: row['models'].map(parseModel),
    stale: row['stale'],
    ...typeof row['error'] === 'string' ? { error: row['error'] } : {},
    fetchedAtMs: row['fetchedAtMs'],
    counts: {
      total: count('total'),
      enabled: count('enabled'),
      deprecated: count('deprecated'),
      unconfigured: count('unconfigured'),
      inferred: count('inferred'),
    },
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    opencodeGoCatalog: {
      read(): Promise<RemoteResult<CatalogReading>>
      refresh(): Promise<RemoteResult<CatalogReading>>
    }
  }
}

/** Codec shape accepted by both released and source DSH builds. */
const codec = {
  mode: 'strict' as const,
  typeSymbol: '@dan-ai-studio/dshopencodego#CatalogReading',
  schema: { parse: parseCatalogReading },
  create: () => ({ parse: parseCatalogReading }),
}

/** Remote methods the catalog owns. */
export const catalogRemote: TypertRemoteContribution = {
  package: '@dan-ai-studio/dshopencodego',
  descriptors: [
    {
      id: '@dan-ai-studio/dshopencodego#opencodeGoCatalog/read',
      service: 'opencodeGoCatalog',
      namespace: 'opencodeGoCatalog',
      method: 'read',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec,
    },
    {
      id: '@dan-ai-studio/dshopencodego#opencodeGoCatalog/refresh',
      service: 'opencodeGoCatalog',
      namespace: 'opencodeGoCatalog',
      method: 'refresh',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec,
    },
  ],
}
