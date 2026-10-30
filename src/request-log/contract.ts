/**
 * Wire contract for the request-log Remote.
 *
 * One reading: the bounded per-request log the Host keeps while the profile
 * enables it. The viewer opens it on demand; nothing polls, so a closed
 * viewer costs no wire traffic at all.
 *
 * @module @dan-ai-studio/dshopencodego/request-log/contract
 */

import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { PoolLogEvent, RequestLogEntry, RequestLogSnapshot } from './store.ts'
import { MAX_STREAM_MARKS } from './store.ts'

export type { PoolLogEvent, RequestLogEntry, RequestLogSnapshot } from './store.ts'

function count(key: string, row: Record<string, unknown>): number
function count(key: string, row: Record<string, unknown>, optional: true): number | undefined
function count(key: string, row: Record<string, unknown>, optional?: boolean): number | undefined {
  const entry = row[key]
  if (entry === undefined) {
    if (optional === true) return undefined
    throw new Error(`invalid request-log entry "${key}"`)
  }
  if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) {
    throw new Error(`invalid request-log entry "${key}"`)
  }
  return entry
}

function text(key: string, row: Record<string, unknown>): string
function text(key: string, row: Record<string, unknown>, optional: true): string | undefined
function text(key: string, row: Record<string, unknown>, optional?: boolean): string | undefined {
  const entry = row[key]
  if (entry === undefined) {
    if (optional === true) return undefined
    throw new Error(`invalid request-log entry "${key}"`)
  }
  if (typeof entry !== 'string') throw new Error(`invalid request-log entry "${key}"`)
  return entry
}

/** Validate one entry crossing the wire. */
function parseEntry(value: unknown): RequestLogEntry {
  if (value === null || typeof value !== 'object') throw new Error('invalid request-log entry')
  const row = value as Record<string, unknown>
  const shape = row['shape']
  const headers = row['headers']
  const protocol = row['protocol']
  return {
    seq: count('seq', row),
    atMs: count('atMs', row),
    model: text('model', row),
    // Older rows predate the protocol recording; they read without one
    // rather than failing the whole snapshot.
    ...protocol === 'anthropic-messages' || protocol === 'openai-completions' || protocol === 'openai-responses'
      ? { protocol }
      : {},
    session: text('session', row),
    method: text('method', row),
    url: text('url', row),
    ...row['status'] === undefined ? {} : { status: count('status', row) },
    ...row['inputTokens'] === undefined ? {} : { inputTokens: count('inputTokens', row) },
    ...row['outputTokens'] === undefined ? {} : { outputTokens: count('outputTokens', row) },
    ...row['cacheReadTokens'] === undefined ? {} : { cacheReadTokens: count('cacheReadTokens', row) },
    ...row['cacheWriteTokens'] === undefined ? {} : { cacheWriteTokens: count('cacheWriteTokens', row) },
    ...row['reasoningTokens'] === undefined ? {} : { reasoningTokens: count('reasoningTokens', row) },
    ...row['costUsd'] === undefined ? {} : { costUsd: rate('costUsd', row) },
    ...row['requestBytes'] === undefined ? {} : { requestBytes: count('requestBytes', row) },
    ...row['prepMs'] === undefined ? {} : { prepMs: count('prepMs', row) },
    ...row['responseMs'] === undefined ? {} : { responseMs: count('responseMs', row) },
    ...row['streamMarksMs'] === undefined ? {} : { streamMarksMs: parseMarks(row['streamMarksMs']) },
    ...row['imageBytes'] === undefined ? {} : { imageBytes: count('imageBytes', row) },
    ...row['durationMs'] === undefined ? {} : { durationMs: count('durationMs', row) },
    ...row['firstTokenMs'] === undefined ? {} : { firstTokenMs: count('firstTokenMs', row) },
    ...row['decodeMs'] === undefined ? {} : { decodeMs: count('decodeMs', row) },
    ...row['streamMs'] === undefined ? {} : { streamMs: count('streamMs', row) },
    ...row['tps'] === undefined ? {} : { tps: rate('tps', row) },
    // Running rows cross the wire too: a viewer opened mid-request must
    // see them. Older snapshots predate the flag and read as finished.
    ...row['running'] === true ? { running: true } : {},
    ok: row['ok'] === true,
    ...typeof row['code'] === 'string' ? { code: row['code'] } : {},
    ...typeof row['poolKey'] === 'string' ? { poolKey: row['poolKey'] } : {},
    ...shape !== null && typeof shape === 'object' ? {
      shape: {
        messages: count('messages', shape as Record<string, unknown>),
        hasImage: (shape as Record<string, unknown>)['hasImage'] === true,
        tools: count('tools', shape as Record<string, unknown>),
      },
    } : {},
    ...headers !== null && typeof headers === 'object' ? {
      headers: {
        ...typeof (headers as Record<string, unknown>)['session'] === 'string'
          ? { session: (headers as Record<string, unknown>)['session'] as string }
          : {},
        ...typeof (headers as Record<string, unknown>)['userAgent'] === 'string'
          ? { userAgent: (headers as Record<string, unknown>)['userAgent'] as string }
          : {},
      },
    } : {},
  }
}

/**
 * Validate the streaming trail crossing the wire.
 *
 * Numbers must each be finite and non-negative; a longer trail is cut down
 * to the cap rather than failing the row — the row's counts stand on their
 * own, and the trail is only ever a visualization aid.
 */
function parseMarks(value: unknown): readonly number[] {
  if (!Array.isArray(value)) throw new Error('invalid request-log stream marks')
  const kept: number[] = []
  for (const mark of value) {
    if (typeof mark !== 'number' || !Number.isFinite(mark) || mark < 0 || kept.length >= MAX_STREAM_MARKS) continue
    kept.push(mark)
  }
  return kept
}

/** A non-negative finite rate (tokens per second); decimals are meaningful here. */
function rate(key: string, row: Record<string, unknown>): number {
  const entry = row[key]
  if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) {
    throw new Error(`invalid request-log entry "${key}"`)
  }
  return entry
}

/** Validate one pool event crossing the wire. */
function parsePoolEvent(value: unknown): PoolLogEvent {
  if (value === null || typeof value !== 'object') throw new Error('invalid request-log pool event')
  const row = value as Record<string, unknown>
  const type = row['type']
  if (type !== 'create' && type !== 'close') throw new Error('invalid request-log pool event')
  return { atMs: count('atMs', row), type, key: text('key', row) }
}

/** Validate a snapshot crossing the wire. */
export function parseRequestLogSnapshot(value: unknown): RequestLogSnapshot {
  if (value === null || typeof value !== 'object') throw new Error('invalid request-log snapshot')
  const row = value as Record<string, unknown>
  if (!Array.isArray(row['entries']) || !Array.isArray(row['poolEvents'])) {
    throw new Error('invalid request-log snapshot')
  }
  return {
    entries: (row['entries'] as unknown[]).map(parseEntry),
    poolEvents: (row['poolEvents'] as unknown[]).map(parsePoolEvent),
    totalRecords: count('totalRecords', row),
    droppedRecords: count('droppedRecords', row),
    newConnections: count('newConnections', row),
    ...typeof row['poolKey'] === 'string' ? { poolKey: row['poolKey'] } : {},
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    opencodeGoRequestLog: {
      readLog(): Promise<RemoteResult<RequestLogSnapshot>>
    }
  }
}

/** Codec shape accepted by both released and source DSH builds. */
const codec = {
  mode: 'strict' as const,
  typeSymbol: '@dan-ai-studio/dshopencodego#RequestLogSnapshot',
  schema: { parse: parseRequestLogSnapshot },
  create: () => ({ parse: parseRequestLogSnapshot }),
}

/** Remote methods this package owns, mounted together by the plugin. */
export const requestLogRemote: TypertRemoteContribution = {
  package: '@dan-ai-studio/dshopencodego',
  descriptors: [
    {
      id: '@dan-ai-studio/dshopencodego#opencodeGoRequestLog/readLog',
      service: 'opencodeGoRequestLog',
      namespace: 'opencodeGoRequestLog',
      method: 'readLog',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec,
    },
  ],
}
