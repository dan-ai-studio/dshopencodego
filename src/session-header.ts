/**
 * The session header the OpenCode Go gateway requires.
 *
 * Every inference request must carry `x-opencode-session`; the gateway answers
 * `400 MissingSessionID` without it and routes plus caches by its value. Two
 * rules make that useful rather than merely accepted:
 *
 * 1. The value is the conversation's stable Harness session id, verbatim — the
 *    same string the session log records — so one conversation keeps one
 *    routing bucket and one prompt cache across turns, resume, compaction,
 *    retries, and subagents.
 * 2. A request that carries no session id gets a fresh random value rather than
 *    a shared constant, because a constant would merge unrelated traffic into a
 *    single cache bucket and evict itself.
 *
 * @module @dan-ai-studio/dshopencodego/session-header
 */

import { randomUUID } from 'node:crypto'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'

/** Header name the gateway requires. */
export const SESSION_HEADER = 'x-opencode-session'

/**
 * The header value for one request.
 * @param sessionId - the request's session id, if it names one.
 * @returns the exact session id, or a fresh UUID when there is none.
 */
export function opencodeSessionValue(sessionId: string | undefined): string {
  return sessionId !== undefined && sessionId.length > 0 ? sessionId : randomUUID()
}

/**
 * Every header one provider request carries.
 *
 * The attribution `user-agent` is Harness-owned and always present; the session
 * header is added on top of it. A caller-supplied header of the same name can
 * never win, because the gateway's routing decision must follow the session,
 * not a deployment string.
 * @param sessionId - the request's session id, if it names one.
 * @returns headers for the pi-ai request options.
 */
export function providerHeaders(sessionId: string | undefined): Record<string, string> {
  return {
    [SESSION_HEADER]: opencodeSessionValue(sessionId),
    ...attributionHeaders(),
  }
}
