/**
 * The per-request log: a bounded ring buffer owned by the Host.
 *
 * Everything here is inert unless the profile enables it. The recorder is
 * constructed only when `requestLogEnabled` reads true, so a disabled log
 * changes nothing on the request path — not one extra allocation. When
 * enabled, `start` appends a running placeholder immediately — so a request
 * is visible from the moment it begins, not only after it ends — and
 * `finish` completes that same row in place. The oldest entries are dropped
 * past the configured bound, so the log can never grow with the session.
 *
 * Two facts are structural rather than conventional:
 *
 * - Authorization never enters a record. The recorder takes no headers
 *   argument at all; the only header-derived value it stores is the session
 *   id it is handed, already separated from the credential by the caller.
 * - The session id is stored whole. It is a conversation identity, not a
 *   secret, and a truncated one cannot group a conversation's requests —
 *   two conversations sharing an eight-character prefix would read as one.
 *
 * @module @dan-ai-studio/dshopencodego/request-log/store
 */

import type { WireProtocol } from '../catalog/protocol.ts'

/** One recorded request. Counts are provider-reported; timings are Host-measured. */
export interface RequestLogEntry {
  /** Monotonic sequence within this process; gaps mean nothing was recorded. */
  readonly seq: number
  /** When the request started, in epoch milliseconds. */
  readonly atMs: number
  /** The model id the request was made with. */
  readonly model: string
  /**
   * The wire protocol the request ran on, as the catalog resolved it.
   * Present from the build that records it; older rows simply lack it.
   */
  readonly protocol?: WireProtocol
  /** The session id the request belonged to, whole. */
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
  /** Provider-reported cache-write tokens, when positive. */
  readonly cacheWriteTokens?: number
  /**
   * Provider-reported reasoning tokens, when positive. A subset of
   * `outputTokens` — never added to a total — recorded so a thinking turn's
   * shape stays visible.
   */
  readonly reasoningTokens?: number
  /**
   * Estimated USD for this request at the rates in force when it ran, by the
   * same function that prices the since-boot meter. Absent for unpriced
   * models: no zero standing in for "unknown".
   */
  readonly costUsd?: number
  /**
   * Request body size in bytes, as handed to fetch. Explanatory, not
   * sensitive: a multi-megabyte turn uploads slowly no matter the model.
   */
  readonly requestBytes?: number
  /**
   * Estimated image share of the wire body, in bytes: unique attached
   * images as base64, each capped at the route's encoded-byte target.
   * The text share is the residual (`requestBytes` minus this), so the two
   * always reconcile with the total. Absent when the request carries no
   * image bytes at all.
   */
  readonly imageBytes?: number
  /**
   * Wall time from the first to the last content token, in milliseconds —
   * the window the output actually streamed in. Absent when fewer than two
   * content tokens arrived; a burst delivery reads here as ~zero while the
   * whole reply still counts in the totals above.
   */
  readonly streamMs?: number
  /**
   * Wall time from request start to the moment the fetch actually went out,
   * in milliseconds — the local preparation (catalog, conversion, images).
   * The rest of the first-token wait belongs to the wire and the gateway.
   * Absent when the request never reached the wire (rejected up front).
   */
  readonly prepMs?: number
  /** Wall time from request start to terminal event, in milliseconds. */
  readonly durationMs?: number
  /** Wall time from request start to the first token delta, in milliseconds. */
  readonly firstTokenMs?: number
  /**
   * Wall time from the first token delta to the terminal event, in
   * milliseconds — the decode window, on the same scale as the Harness's own
   * per-turn reading.
   */
  readonly decodeMs?: number
  /**
   * Output tokens per second over the decode window.
   *
   * Absent when the request produced no token, when the decode window
   * rounds to zero milliseconds, or when the whole output arrived in one
   * burst (see `MIN_STREAM_MS_FOR_RATE`): a rate divided by zero is not a
   * rate, and a rate over a burst is not a generation speed. Either would
   * misreport a buffered reply as infinitely quick.
   */
  readonly tps?: number
  /**
   * Whether the request is still in flight. Present only while it runs:
   * `finish` removes it. A running row always reads `ok: false` with no
   * `code`, so readers must check this flag before counting a failure.
   */
  readonly running?: boolean
  /**
   * Whether the request completed successfully. Always false while
   * `running` is true.
   */
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
  /** Newest first, at most the configured bound — finished rows plus running ones. */
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
 * Minimum content span for a meaningful rate, in milliseconds.
 *
 * A rate needs a window, and a sub-100ms arrival spread is delivery shape,
 * not generation speed: wall-clock timers resolve to a millisecond, one
 * network flush fans its events out across several event-loop turns, and no
 * served LLM sustains thousands of tokens per second. Below this line the
 * tokens arrived in one burst — the reply's speed on the wire is unknown,
 * so no rate is reported rather than a fabricated one.
 */
const MIN_STREAM_MS_FOR_RATE = 100

/**
 * An in-flight request, handed back only when the log is enabled.
 *
 * `start` already appended its running row, so every method mutates the
 * visible entry in place. Every method stays cheap by construction: one
 * `Date.now` read per content delta, field writes for the wire line, and
 * small integer arithmetic at close. No serialization, no hashing, no body
 * handling — the counts ride the usage chunk the adapter already holds,
 * and the timings bracket work that already happened.
 */
export interface RequestSpan {
  /**
   * Mark one content token's arrival.
   *
   * The first call opens the decode window; every call moves the last-token
   * mark, so the span between them is the window the output actually
   * streamed in. The adapter calls this for every chunk its own first-token
   * definition accepts — the same definition the Harness uses.
   */
  token(): void
  /**
   * Record the wire request line, from the fetch wrapper. Called at most
   * once per span; a second call keeps the first, so retries never rewrite
   * the original line.
   * @param requestBytes - request body size in bytes, when the body was a
   *   measurable in-memory value rather than a stream.
   */
  request(method: string, url: string, requestBytes?: number): void
  /** Mark the response status line's arrival. */
  status(status: number): void
  /**
   * Close the span and complete its running row in place.
   * @param ok - whether the request completed.
   * @param code - failure code for a request that did not complete.
   * @param usage - provider-reported counts, when the terminal usage arrived.
   * @param costUsd - estimated USD at the call's rates, when priced.
   */
  finish(ok: boolean, code?: string, usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
    readonly reasoningTokens?: number
  }, costUsd?: number): void
}

/** Detail the adapter hands the recorder for one request. */
export interface RequestStart {
  readonly model: string
  readonly sessionId: string | undefined
  /** The wire protocol, as the catalog resolved it for this model. */
  readonly protocol?: WireProtocol
  /** Fallback line, used only when the fetch wrapper never reported the real one. */
  readonly method?: string
  readonly url?: string
  readonly messageCount: number
  readonly hasImage: boolean
  readonly toolCount: number
  /** Estimated image share of the wire body, in bytes; see the entry field. */
  readonly imageBytes?: number
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
   * method call and one boolean read, and constructs nothing. When enabled,
   * the running row is appended before the span is returned, so the viewer
   * sees the request while it runs; `request` and `status` mutate that same
   * visible row as the wire facts arrive.
   */
  start(detail: RequestStart): RequestSpan | undefined {
    if (!this.gates.enabled()) return undefined
    const debug = this.gates.debug()
    const startedAt = Date.now()
    // The session id is kept whole: it is the conversation's identity, not a
    // credential, and a truncated one cannot tell two conversations apart.
    const session = detail.sessionId ?? ''
    // Mutable while the request runs; the snapshot hands out this same
    // object, so the wire line lands in the visible row as it arrives. The
    // readonly type is a compile-time promise to readers, not a freeze.
    const record = {
      seq: ++this.seq,
      atMs: startedAt,
      model: detail.model,
      ...detail.protocol === undefined ? {} : { protocol: detail.protocol },
      session,
      method: detail.method ?? 'POST',
      url: detail.url ?? '',
      running: true,
      ok: false,
      shape: { messages: detail.messageCount, hasImage: detail.hasImage, tools: detail.toolCount },
      ...detail.imageBytes === undefined ? {} : { imageBytes: detail.imageBytes },
      ...!debug ? {} : {
        headers: {
          ...detail.headers.session === undefined ? {} : { session: detail.headers.session },
          ...detail.headers.userAgent === undefined ? {} : { userAgent: detail.headers.userAgent },
        },
      },
    } as { -readonly [K in keyof RequestLogEntry]: RequestLogEntry[K] }
    this.insert(record as RequestLogEntry, true)
    let firstTokenAt: number | undefined
    let lastTokenAt: number | undefined
    // The wire line lands once: a second call keeps the first, so retries
    // never rewrite the original line — the same rule as before, now
    // applied to the visible row.
    let reported = false
    let finished = false
    return {
      token: (): void => {
        const now = Date.now()
        if (firstTokenAt === undefined) {
          firstTokenAt = now
          // The first token's arrival is visible while the request still
          // runs — `finish` reuses this same mark for the decode window.
          record.firstTokenMs = Math.max(0, now - startedAt)
        }
        lastTokenAt = now
      },
      request: (nextMethod: string, nextUrl: string, nextRequestBytes?: number): void => {
        if (!reported) {
          reported = true
          record.method = nextMethod
          record.url = nextUrl
          if (nextRequestBytes !== undefined) record.requestBytes = nextRequestBytes
          // The SDK fires the HTTP call here, so this mark splits the
          // first-token wait: everything before it is local preparation,
          // everything after it is the wire and the gateway. Set on the
          // visible row at once, so a slow start reads while it runs.
          record.prepMs = Math.max(0, Date.now() - startedAt)
        }
      },
      status: (value: number): void => {
        record.status = value
      },
      finish: (ok, code, usage, costUsd): void => {
        if (finished) return
        finished = true
        const seq = record.seq
        const endedAt = Date.now()
        // The decode window: first token to the terminal event. The terminal
        // event follows the last token by a few milliseconds, so this is the
        // same scale as the Harness's own per-turn decode reading.
        const decodeMs = firstTokenAt === undefined ? undefined : Math.max(0, endedAt - firstTokenAt)
        // The content span: first token to last token. On an evenly streamed
        // reply this covers the decode window; on a buffered one the whole
        // output lands in one flush and the span collapses to ~zero.
        const streamMs = firstTokenAt === undefined || lastTokenAt === undefined
          ? undefined
          : Math.max(0, lastTokenAt - firstTokenAt)
        // Output tokens per second. The provider's output count includes
        // reasoning tokens, exactly as the Harness's own decode rate counts
        // them, so the two numbers mean the same thing. A burst delivery has
        // no meaningful rate — its span says how the network flushed, not how
        // the model generated — so it reports none instead of a fabricated
        // thousands-per-second.
        const tps = decodeMs === undefined || decodeMs <= 0 || usage === undefined
          || streamMs === undefined || streamMs < MIN_STREAM_MS_FOR_RATE
          ? undefined
          : usage.outputTokens / (decodeMs / 1000)
        const entry: RequestLogEntry = {
          seq,
          atMs: startedAt,
          model: detail.model,
          ...detail.protocol === undefined ? {} : { protocol: detail.protocol },
          session,
          method: record.method,
          url: record.url,
          ...record.status === undefined ? {} : { status: record.status },
          ...record.prepMs === undefined ? {} : { prepMs: record.prepMs },
          ...usage === undefined ? {} : {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...usage.cacheReadTokens === undefined || usage.cacheReadTokens <= 0
              ? {}
              : { cacheReadTokens: usage.cacheReadTokens },
            ...usage.cacheWriteTokens === undefined || usage.cacheWriteTokens <= 0
              ? {}
              : { cacheWriteTokens: usage.cacheWriteTokens },
            ...usage.reasoningTokens === undefined || usage.reasoningTokens <= 0
              ? {}
              : { reasoningTokens: usage.reasoningTokens },
          },
          ...costUsd === undefined ? {} : { costUsd },
          ...record.requestBytes === undefined ? {} : { requestBytes: record.requestBytes },
          ...detail.imageBytes === undefined ? {} : { imageBytes: detail.imageBytes },
          durationMs: Math.max(0, endedAt - startedAt),
          ...firstTokenAt === undefined ? {} : { firstTokenMs: Math.max(0, firstTokenAt - startedAt) },
          ...decodeMs === undefined ? {} : { decodeMs },
          ...streamMs === undefined ? {} : { streamMs },
          ...tps === undefined ? {} : { tps },
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
        // Complete the running row in place: same sequence, no recount. A
        // row the ring already dropped (its slot went to newer starts) is
        // re-appended instead — the completion must not be lost with it.
        const at = this.entries.findIndex(candidate => candidate.seq === seq)
        if (at === -1) {
          this.insert(entry, false)
        } else {
          this.entries[at] = entry
        }
      },
    }
  }

  private insert(entry: RequestLogEntry, count: boolean): void {
    if (count) this.totalRecords += 1
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
