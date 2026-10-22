/**
 * Request-log bounds, shared by the schema and the settings page.
 *
 * These live apart from `config.ts` on purpose: the settings page must not
 * drag the configuration module (and its Harness-only imports) into the
 * browser bundle. Import from here on both sides instead.
 *
 * @module @dan-ai-studio/dshopencodego/request-log/limits
 */

/** Default request-log retention: enough to debug a session, small enough to never matter. */
export const DEFAULT_REQUEST_LOG_MAX_ENTRIES = 200

/** Fewest request-log entries a profile may keep. */
export const MIN_REQUEST_LOG_MAX_ENTRIES = 50

/** Most request-log entries a profile may keep; the buffer is bounded by design. */
export const MAX_REQUEST_LOG_MAX_ENTRIES = 500
