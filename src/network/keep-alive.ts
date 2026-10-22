/**
 * How long a gateway connection is kept between requests.
 *
 * These two numbers are declared apart from `config.ts` on purpose. The
 * configuration module imports the Harness' own packages — a schema library
 * and the retry policy type — and the settings page must not drag those into
 * the browser bundle: the page is shipped to a page, and a package that
 * reaches for `node:module` cannot be bundled for one.
 *
 * @module @dan-ai-studio/dshopencodego/network/keep-alive
 */

/**
 * Default idle time a gateway connection is kept between requests, in seconds.
 *
 * Undici's own default is four seconds, and a conversation pauses for longer
 * than that all the time: a person reads the answer, thinks, and types the
 * next question. A connection dropped during such a pause has to be built
 * again — a TCP and a TLS handshake, roughly a fifth of a second from here
 * to the gateway — and that cost lands on the first token of the next turn.
 *
 * The timer is reset by every response, so this bounds only the silence
 * between two requests: a connection that is used often is never dropped.
 *
 * The unit is seconds because that is what the settings page shows and
 * accepts; a number of milliseconds is not readable at a glance. The
 * millisecond value below is derived from it, never written separately, so
 * the two can never disagree.
 */
export const DEFAULT_KEEP_ALIVE_TIMEOUT_SECONDS = 600

/**
 * Largest idle time a connection may be kept, in seconds.
 *
 * A connection held for hours belongs to a machine that never talks to the
 * gateway, and a socket that outlives the server's own idea of the address
 * it is talking to is a socket that fails on first use rather than on the
 * one that mattered. Half an hour is longer than any conversation and short
 * enough that the address is re-checked often.
 */
export const MAX_KEEP_ALIVE_TIMEOUT_SECONDS = 1_800

/**
 * The ceiling Node's timers can hold, in milliseconds.
 *
 * A value above this does not become a longer timer: it overflows and
 * becomes **one millisecond**, so the connection would be dropped at once —
 * and silently, because the warning goes to stderr and nothing else. This
 * is the reason the maximum below is far smaller than the ceiling.
 */
export const TIMER_CEILING_MS = 2_147_483_647

/** Default idle time a gateway connection is kept between requests, in milliseconds. */
export const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = DEFAULT_KEEP_ALIVE_TIMEOUT_SECONDS * 1000

/** Largest idle time a connection may be kept, in milliseconds. */
export const MAX_KEEP_ALIVE_TIMEOUT_MS = MAX_KEEP_ALIVE_TIMEOUT_SECONDS * 1000
