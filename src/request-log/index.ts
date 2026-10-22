/**
 * The per-request log: public surface of the request-log module.
 *
 * @module @dan-ai-studio/dshopencodego/request-log
 */

export { OpencodeGoRequestLogService } from './service.ts'
export type { RequestLogServiceOptions } from './service.ts'
export { RequestLog } from './store.ts'
export type {
  PoolLogEvent,
  RequestLogEntry,
  RequestLogGates,
  RequestLogSnapshot,
  RequestRecorder,
  RequestSpan,
  RequestStart,
} from './store.ts'
export { parseRequestLogSnapshot, requestLogRemote } from './contract.ts'
