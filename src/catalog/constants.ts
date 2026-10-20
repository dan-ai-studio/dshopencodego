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

/** Timeout for the two small metadata GETs. */
export const METADATA_FETCH_TIMEOUT_MS = 10_000

/**
 * Timeout for the model metadata document.
 *
 * It is the one read measured in megabytes — 5.9 MB for the whole of
 * models.dev, of which this plugin uses one provider — and the host that
 * fetches it is not always a plain Node process. The desktop build fetches
 * over the browser's network stack, where the same document a shell reads in
 * half a second can outrun a budget set for kilobyte-sized documents. The
 * longer budget costs nothing when the read succeeds; it is the difference
 * between a catalog and a degraded one.
 */
export const MODEL_METADATA_TIMEOUT_MS = 30_000

/**
 * How long to wait before the one retry of the metadata read.
 *
 * Long enough for the host to finish whatever it was doing — a plugin
 * reload, a package unpack — and short enough that a genuinely unreachable
 * document still fails inside the catalog build.
 */
export const METADATA_RETRY_DELAY_MS = 1_500

/**
 * How long a failed background refresh waits before it is tried again.
 *
 * A refresh that fails leaves the catalog's age where it was, so every call
 * sees it as past its TTL and starts another. Without a back-off, a service
 * that is down turns every model request into a full download attempt.
 *
 * Five minutes is short enough that a service that comes back is picked up
 * soon, and long enough that a service that stays down is asked once, not
 * once per request.
 */
export const BACKGROUND_RETRY_BACKOFF_MS = 5 * 60_000

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
