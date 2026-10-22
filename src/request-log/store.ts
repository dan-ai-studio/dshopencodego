/**
 * The per-request log: a bounded ring buffer owned by the Host.
 *
 * Everything here is inert unless the profile enables it. The recorder is
 * constructed only when `requestLogEnabled` reads true, so a disabled log
 * changes nothing on the request path — not one extra allocation. When
 * enabled, one entry per completed or failed request is appended; the oldest
 * entries are dropped past the configured bound, so the log can never grow
 * with the session.
 *
 * Two facts are structural rather than conventional:
 *
 * - Authorization never enters a record. The recorder takes no headers
 *   argument at all; the only header-derived value it stores is the session
 *   id it is handed, already separated from the credential by the caller.
 * - The session id is stored truncated (first 8 characters) unless debug
 *   mode is on at record time. A truncated id groups one conversation's
 *   requests without writing the full identity to the log.
 *
 * @module @dan-ai-studio/dshopencodego/request-log/store
 */

/** How many session-id characters the common (non-debug) log keeps. */
export const SESSION_PREFIX_LENGTH = 8

/** One recorded request. Counts are provider-reported; timings are Host-measured. */
export interface RequestLogEntry {
  /** Monotonic sequence within this process; gaps mean nothing was recorded. */
  readonly seq: number
  /** When the request started, in epoch milliseconds. */
  readonly atMs: number
  /** The model id the request was made with. */
  readonly model: string
  /** The session id, full in debug mode, truncated to {@link SESSION_PREFIX_LENGTH} otherwise. */
  readonly session: string
  /** HTTP method used. */
  readonly method: string
  /** Request URL without any credential (the key travels in a header). */
  readonly url: string
  /** Response status when a response arrived; absent when the request never got one. */
  readonly status?: number
  /** Provider-reported input tokens, when the terminal usage arrived. */
  readonly inputTokens?: number
  /** Provider-reported output tokens, when the terminal usage arrived. */
  readonly outputTokens?: number
  /** Provider-reported cache-read tokens, when positive. */
  readonly cacheReadTokens?: number
  /** Wall time from request start to terminal event, in milliseconds. */
  readonly durationMs?: number
  /** Wall time from request start to the first token delta, in milliseconds. */
  readonly firstTokenMs?: number
  /** Whether the request completed. */
  readonly ok: boolean
  /** Failure code (`TIMEOUT`, `TRANSPORT`, …) for a request that did not complete. */
  readonly code?: string
  /** Connection-pool key the request ran under, when the pool is enabled. */
  readonly poolKey?: string
  /** Request shape summary, so the log stays informative without bodies. */
  readonly shape?: {
    /** Number of conversation messages sent. */
    readonly messages: number
    /** Whether any message carried image content. */
    readonly hasImage: boolean
    /** Number of tool schemas sent. */
    readonly tools: number
  }
  /**
   * Debug-only headers, allowlisted at record time: the session id and the
   * user agent. Never the credential — the recorder takes no headers
   * argument, so there is no path by which an `authorization` value could
   * reach a record.
   */
  readonly headers?: {
    readonly session?: string
    readonly userAgent?: string
  }
}

/** One pool lifecycle event. Rare by construction: pools live for minutes. */
export interface PoolLogEvent {
  readonly atMs: number
  readonly type: 'create' | 'close'
  /** The pool key (`host@address@timeoutMs`). */
  readonly key: string
}

/** What the viewer reads: the entries plus the counters a rate needs. */
export interface RequestLogSnapshot {
  /** Newest first, at most the configured bound. */
  readonly entries: readonly RequestLogEntry[]
  /** Recent pool lifecycle, newest first, capped. */
  readonly poolEvents: readonly PoolLogEvent[]
  /** Requests recorded since boot, including ones since dropped. */
  readonly totalRecords: number
  /** Requests dropped for exceeding the bound. */
  readonly droppedRecords: number
  /** Sockets the gateway accepted since boot. */
  readonly newConnections: number
  /** Pool key currently in force, if any request has run. */
  readonly poolKey?: string
}

/** Live gates the recorder reads at record time. */
export interface RequestLogGates {
  /** Whether any record is kept at all. */
  readonly enabled: () => boolean
  /** Whether debug detail (full session, pool events) is kept. */
  readonly debug: () => boolean
  /** How many entries to keep; the ring trims to it on every append. */
  readonly maxEntries: () => number
}

/** Cap on pool lifecycle events; pools are rare, so this is generous. */
const MAX_POOL_EVENTS = 20

/**
 * An in-flight request, handed back only when the log is enabled.
 *
 * Every method is cheap by construction: two `Date.now` reads and small
 * integer arithmetic across the whole span. No serialization, no hashing,
 * no body handling — the counts ride the usage chunk the adapter already
 * holds, and the timings bracket work that already happened.
 */
export interface RequestSpan {
  /** Mark the first token delta's arrival. Idempotent: only the first call counts. */
  firstToken(): void
  /**
   * Record the wire request line, from the fetch wrapper. Called at most
   * once per span; a second call keeps the first, so retries never rewrite
   * the original line.
   */
  request(method: string, url: string): void
  /** Mark the response status line's arrival. */
  status(status: number): void
  /**
   * Close the span and append its entry.
   * @param ok - whether the request completed.
   * @param code - failure code for a request that did not complete.
   * @param usage - provider-reported counts, when the terminal usage arrived.
   */
  finish(ok: boolean, code?: string, usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens?: number
  }): void
}

/** Detail the adapter hands the recorder for one request. */
export interface RequestStart {
  readonly model: string
  readonly sessionId: string | undefined
  /** Fallback line, used only when the fetch wrapper never reported the real one. */
  readonly method?: string
  readonly url?: string
  readonly messageCount: number
  readonly hasImage: boolean
  readonly toolCount: number
  /** Allowlisted request headers; the recorder never sees the credential. */
  readonly headers: { readonly session?: string; readonly userAgent?: string }
}

/**
 * One request's recorder. The adapter calls `start` once per stream; the
 * span it returns (or undefined when the log is disabled) carries the rest.
 */
export interface RequestRecorder {
  start(detail: RequestStart): RequestSpan | undefined
}

/** Appends bounded per-request records for the lifetime of one Host process. */
export class RequestLog {
  private readonly gates: RequestLogGates
  private entries: RequestLogEntry[] = []
  private poolEvents: PoolLogEvent[] = []
  private seq = 0
  private totalRecords = 0
  private droppedRecords = 0
  private newConnections = 0
  private poolKey: string | undefined

  constructor(gates: RequestLogGates) {
    this.gates = gates
  }

  /**
   * Count one accepted socket. Called from the diagnostics channel, not the
   * request path, so its cost never lands on a request.
   */
  connectionOpened(): void {
    this.newConnections += 1
  }

  /**
   * Record one pool lifecycle event. Pools live for minutes, so this is rare
   * by construction; still gated on debug so the common log stays request-only.
   */
  poolEvent(type: 'create' | 'close', key: string): void {
    if (!this.gates.enabled() || !this.gates.debug()) return
    this.poolKey = type === 'create' ? key : this.poolKey
    if (type === 'close' && this.poolKey === key) this.poolKey = undefined
    this.poolEvents = [{ atMs: Date.now(), type, key }, ...this.poolEvents].slice(0, MAX_POOL_EVENTS)
  }

  /**
   * Begin one request's span, or nothing when the log is disabled.
   *
   * This is the single gate on the request path: a disabled log costs one
   * method call and one boolean read, and constructs nothing.
   */
  start(detail: RequestStart): RequestSpan | undefined {
    if (!this.gates.enabled()) return undefined
    const debug = this.gates.debug()
    const startedAt = Date.now()
    const full = detail.sessionId ?? ''
    const session = debug || full.length === 0
      ? full
      : full.slice(0, SESSION_PREFIX_LENGTH)
    let firstTokenAt: number | undefined
    let method: string | undefined
    let url: string | undefined
    let status: number | undefined
    let finished = false
    return {
      firstToken: (): void => {
        if (firstTokenAt === undefined) firstTokenAt = Date.now()
      },
      request: (nextMethod: string, nextUrl: string): void => {
        if (method === undefined) {
          method = nextMethod
          url = nextUrl
        }
      },
      status: (value: number): void => {
        status = value
      },
      finish: (ok, code, usage): void => {
        if (finished) return
        finished = true
        const endedAt = Date.now()
        const entry: RequestLogEntry = {
          seq: ++this.seq,
          atMs: startedAt,
          model: detail.model,
          session,
          method: method ?? detail.method ?? 'POST',
          url: url ?? detail.url ?? '',
          ...status === undefined ? {} : { status },
          ...usage === undefined ? {} : {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...usage.cacheReadTokens === undefined || usage.cacheReadTokens <= 0
              ? {}
              : { cacheReadTokens: usage.cacheReadTokens },
          },
          durationMs: Math.max(0, endedAt - startedAt),
          ...firstTokenAt === undefined ? {} : { firstTokenMs: Math.max(0, firstTokenAt - startedAt) },
          ok,
          ...code === undefined ? {} : { code },
          // The pool in force when the request finished. Pool switches are
          // rare enough that attributing the finishing pool is honest; the
          // create/close events carry the exact history.
          ...this.poolKey === undefined ? {} : { poolKey: this.poolKey },
          shape: { messages: detail.messageCount, hasImage: detail.hasImage, tools: detail.toolCount },
          ...!debug ? {} : {
            headers: {
              ...detail.headers.session === undefined ? {} : { session: detail.headers.session },
              ...detail.headers.userAgent === undefined ? {} : { userAgent: detail.headers.userAgent },
            },
          },
        }
        this.append(entry)
      },
    }
  }

  private append(entry: RequestLogEntry): void {
    this.totalRecords += 1
    const bound = Math.max(1, Math.floor(this.gates.maxEntries()))
    const next = [entry, ...this.entries].slice(0, bound)
    this.droppedRecords += this.entries.length + 1 - next.length
    this.entries = next
  }

  /** Shrink the ring to a new bound immediately; growing backfills nothing. */
  setMaxEntries(bound: number): void {
    if (!Number.isSafeInteger(bound) || bound < 1) return
    if (this.entries.length > bound) {
      this.droppedRecords += this.entries.length - bound
      this.entries = this.entries.slice(0, bound)
    }
  }

  /** The current reading, newest first. Computed lazily: nothing on the hot path. */
  snapshot(): RequestLogSnapshot {
    return {
      entries: this.entries,
      poolEvents: this.poolEvents,
      totalRecords: this.totalRecords,
      droppedRecords: this.droppedRecords,
      newConnections: this.newConnections,
      ...this.poolKey === undefined ? {} : { poolKey: this.poolKey },
    }
  }
}
