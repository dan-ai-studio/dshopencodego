/**
 * Wire contract for the usage Remote.
 *
 * Two readings are exposed, and they answer different questions: `readWindows`
 * asks the gateway what the account has left, and `readMeter` reports what this
 * process has actually spent since it started. Neither is a per-model quota —
 * the endpoint does not publish one — and the client labels them accordingly.
 *
 * @module @dan-ai-studio/dshopencodego/usage/contract
 */

import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { GoMeter } from './meter.ts'
import type { GoUsageWindows, UsageWindow } from './windows.ts'

export type { GoMeter, MeterModelEntry, MeterTotals } from './meter.ts'
export type { GoUsageWindows, UsageWindow } from './windows.ts'

/** Validate one window on the way back from the Host. */
function parseWindow(value: unknown, key: string): UsageWindow {
  if (value === null || typeof value !== 'object') throw new Error(`invalid usage window "${key}"`)
  const row = value as Record<string, unknown>
  if ((row['status'] !== 'ok' && row['status'] !== 'rate-limited')
    || typeof row['percent'] !== 'number' || !Number.isFinite(row['percent'])
    || typeof row['resetsAt'] !== 'string') {
    throw new Error(`invalid usage window "${key}"`)
  }
  return { status: row['status'], percent: row['percent'], resetsAt: row['resetsAt'] }
}

/** Validate a windows reading crossing the wire. */
export function parseUsageWindows(value: unknown): GoUsageWindows {
  if (value === null || typeof value !== 'object') throw new Error('invalid usage reading')
  const row = value as Record<string, unknown>
  return {
    ...typeof row['source'] === 'string' ? { source: row['source'] } : {},
    rolling: parseWindow(row['rolling'], 'rolling'),
    weekly: parseWindow(row['weekly'], 'weekly'),
    monthly: parseWindow(row['monthly'], 'monthly'),
  }
}

function parseTotals(value: unknown): GoMeter['totals'] {
  if (value === null || typeof value !== 'object') throw new Error('invalid meter totals')
  const row = value as Record<string, unknown>
  const count = (key: string): number => {
    const entry = row[key]
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) throw new Error(`invalid meter field "${key}"`)
    return entry
  }
  return {
    calls: count('calls'),
    inputTokens: count('inputTokens'),
    outputTokens: count('outputTokens'),
    cacheReadTokens: count('cacheReadTokens'),
    cacheWriteTokens: count('cacheWriteTokens'),
    totalTokens: count('totalTokens'),
  }
}

/** Validate a meter reading crossing the wire. */
export function parseGoMeter(value: unknown): GoMeter {
  if (value === null || typeof value !== 'object') throw new Error('invalid meter reading')
  const row = value as Record<string, unknown>
  if (typeof row['sinceMs'] !== 'number' || typeof row['atMs'] !== 'number' || !Array.isArray(row['models'])) {
    throw new Error('invalid meter reading')
  }
  return {
    sinceMs: row['sinceMs'],
    atMs: row['atMs'],
    totals: parseTotals(row['totals']),
    models: row['models'].map((entry: unknown) => {
      if (entry === null || typeof entry !== 'object') throw new Error('invalid meter model entry')
      const model = (entry as Record<string, unknown>)['model']
      if (typeof model !== 'string') throw new Error('invalid meter model entry')
      return { model, ...parseTotals(entry) }
    }),
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'dshopencodego/usage-unavailable': {
      /** Whether retrying the same read could succeed. */
      readonly retryable: boolean
      /** Whether a previously displayed reading stays valid. */
      readonly retainPrevious: boolean
      /** Identity of the reading the client already holds, when any. */
      readonly source?: string
    }
  }
  interface TypertRemoteNamespaceMap {
    opencodeGoUsage: {
      readWindows(): Promise<RemoteResult<GoUsageWindows>>
      readMeter(): Promise<RemoteResult<GoMeter>>
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
export const usageRemote: TypertRemoteContribution = {
  package: '@dan-ai-studio/dshopencodego',
  descriptors: [
    {
      id: '@dan-ai-studio/dshopencodego#opencodeGoUsage/readWindows',
      service: 'opencodeGoUsage',
      namespace: 'opencodeGoUsage',
      method: 'readWindows',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@dan-ai-studio/dshopencodego#GoUsageWindows', parseUsageWindows),
    },
    {
      id: '@dan-ai-studio/dshopencodego#opencodeGoUsage/readMeter',
      service: 'opencodeGoUsage',
      namespace: 'opencodeGoUsage',
      method: 'readMeter',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@dan-ai-studio/dshopencodego#GoMeter', parseGoMeter),
    },
  ],
}
