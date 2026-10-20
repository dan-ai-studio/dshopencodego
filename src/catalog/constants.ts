/** Shared identities and endpoints for the OpenCode Go route. */

/** DSH provider route this plugin owns. */
export const PROVIDER_ID = 'opencode-go'

/** Selector label for the route. */
export const DISPLAY_NAME = 'OpenCode Go'

/** Gateway base URL; `/models` and `/usage` hang off it. */
export const DEFAULT_BASE_URL = 'https://opencode.ai/inference/go/v1'

/** Console base URL (on-demand / free models, pay-as-you-go). */
export const CONSOLE_BASE_URL = 'https://opencode.ai/inference/v1'

/** Online model metadata: capability, lifecycle, and pricing per model id. */
export const MODEL_METADATA_URL = 'https://models.dev/api.json'

/** The models.dev provider key this plugin reads. */
export const MODEL_METADATA_PROVIDER = 'opencode-go'

/** Timeout for the two metadata GETs. */
export const METADATA_FETCH_TIMEOUT_MS = 10_000

/** Response caps: the listing is tiny, the metadata document is not. */
export const MODEL_LISTING_MAX_BYTES = 1024 * 1024
export const MODEL_METADATA_MAX_BYTES = 16 * 1024 * 1024

/**
 * How long one unknown model id waits before it may revalidate the catalog
 * again.
 *
 * An id the catalog has never seen forces one revalidation, because "this
 * build has not seen it" and "it was just published" look the same from here.
 * Without a cooldown, an id that will never resolve — a mistyped id, a model
 * the gateway retired, a stale entry in a session — makes every single model
 * resolution refetch the whole metadata document, which is megabytes. The
 * host resolves a model on every list and on every new session, so that cost
 * is paid over and over for an id whose answer will not change.
 *
 * Five minutes is short enough that a genuinely new model still shows up
 * without a restart, and long enough that a bad id costs one fetch.
 */
export const UNKNOWN_MODEL_PROBE_COOLDOWN_MS = 5 * 60_000
