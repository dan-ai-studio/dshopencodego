/** Shared identities and endpoints for the OpenCode Go route. */

/** DSH provider route this plugin owns. */
export const PROVIDER_ID = 'opencode-go'

/** Selector label for the route. */
export const DISPLAY_NAME = 'OpenCode Go'

/** Gateway base URL; `/models` and `/usage` hang off it. */
export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'

/** Online model metadata: capability, lifecycle, and pricing per model id. */
export const MODEL_METADATA_URL = 'https://models.dev/api.json'

/** The models.dev provider key this plugin reads. */
export const MODEL_METADATA_PROVIDER = 'opencode-go'

/** Timeout for the two metadata GETs. */
export const METADATA_FETCH_TIMEOUT_MS = 10_000

/** Response caps: the listing is tiny, the metadata document is not. */
export const MODEL_LISTING_MAX_BYTES = 1024 * 1024
export const MODEL_METADATA_MAX_BYTES = 16 * 1024 * 1024
