/**
 * Pinning a name to an address.
 *
 * A name that the system resolves may reach an edge that is far away, and
 * a far edge costs every request. Pinning the name to another address of the
 * same network sends it to a different edge instead.
 *
 * The certificate is still checked against the name: only the resolution
 * changes, never the name the server is asked to prove. That is why this
 * is a lookup and not a redirect.
 *
 * Only the gateway's own name is pinned. Every other name — the metadata
 * registry, the provider's documentation — keeps the system's own
 * resolution, including its fallback, its cache, and whatever the host's
 * resolver decides.
 *
 * A pin that cannot be reached is not the end of the request. The address may
 * be gone, and the name may still be served perfectly well by the address the
 * system would have chosen — so the request is sent again, that way, and the
 * answer is the one the caller gets. A wrong address must never cost more
 * than no address at all, so the pin is remembered as spent and the rest of
 * the requests go straight to the system's resolution.
 *
 * @module @dan-ai-studio/dshopencodego/network/pinning
 */

import { isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import type { Dispatcher } from 'undici'

/** A name and the address it should be sent to. */
export type PinnedAddresses = Readonly<Record<string, string>>

/**
 * npm undici's own fetch, typed as the global one.
 *
 * The dispatcher has to come from the same undici that performs the request:
 * Node's built-in fetch carries its own copy, and a dispatcher built by
 * another copy speaks a protocol the built-in one does not answer. The two
 * implementations agree on everything this plugin reads — the status, the
 * headers, and a body stream — so this is a naming convenience rather than
 * a behaviour change.
 */
const dispatchingFetch = undiciFetch as unknown as typeof globalThis.fetch

/**
 * The gateway's own name and the address it is pinned to.
 *
 * An absent address is the whole point of the type: nothing is pinned, and
 * every request goes to the system's own resolution, untouched.
 */
export interface GatewayPin {
  /** The gateway's name, lowercased. */
  readonly host: string
  /** The address the name is sent to; absent when nothing is pinned. */
  readonly address?: string
}

/**
 * The name of a host, in the form a lookup is keyed by.
 *
 * A name is case-insensitive, and a resolver may hand it over in any
 * case, so a pin that was written in one case must still be found.
 * @param host - the host a lookup is for.
 * @returns the lowercased host.
 */
function normalize(host: string): string {
  return host.trim().toLowerCase()
}

/**
 * The gateway's own name, as the configured endpoint states it.
 *
 * The endpoint is where every request of this plugin goes, so its name is
 * the only one worth pinning: a name nobody here asks for has no request to
 * redirect.
 * @param baseURL - the configured gateway base.
 * @returns the lowercased host, or an empty string when the endpoint is not
 *   a URL this plugin can parse.
 */
export function gatewayHostOf(baseURL: string): string {
  try {
    const host = new URL(baseURL).hostname
    // A URL names an IPv6 literal in brackets; a pin is written as the
    // address itself, so the brackets are not part of the name. Without this
    // the two spellings of the same address would be two different keys.
    return normalize(host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host)
  } catch {
    return ''
  }
}

/**
 * The pin that applies to the configured gateway.
 *
 * A pin for another name is not this plugin's business: the endpoint is what
 * this plugin asks for, and a name that is not the endpoint's is never on
 * the path of a request. An address that is not an address is a typo worth
 * ignoring rather than a crash in the middle of a request, and ignoring it
 * means the request goes to the system's resolution — which is exactly what
 * an unconfigured plugin does.
 * @param pins - the configured pins.
 * @param baseURL - the configured gateway base.
 * @returns the gateway's name and, when one is configured and usable, the
 *   address it is pinned to.
 */
export function resolveGatewayPin(pins: PinnedAddresses, baseURL: string): GatewayPin {
  const host = gatewayHostOf(baseURL)
  if (host.length === 0) return { host }
  const configured = pins[host] ?? Object.entries(pins).find(([name]) => normalize(name) === host)?.[1]
  if (configured === undefined) return { host }
  const address = configured.trim()
  if (address.length === 0 || isIP(address) === 0) return { host }
  return { host, address }
}

/**
 * The address a name is pinned to, looked up in the socket.
 *
 * The name is what the certificate is checked against and what the host
 * header carries; only the address in the socket is decided here.
 * @param address - the address to send the name to.
 * @returns the lookup function.
 */
function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address)
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address, family }])
      return
    }
    callback(null, address, family)
  }
}

/** The dispatcher in force, and the pin it was built for. */
let current: { key: string; agent: Dispatcher } | undefined

/**
 * The dispatcher that sends the gateway's name to one address.
 *
 * The agent is kept while the pin is unchanged: an agent owns a connection
 * pool, and a new one for every request would throw that pool away and pay a
 * handshake each time. When the pin changes, the old pool is closed — its
 * sockets point at addresses that are no longer wanted.
 * @param host - the gateway's name.
 * @param address - the address it is pinned to.
 * @returns the dispatcher.
 */
function dispatcherFor(host: string, address: string): Dispatcher {
  const key = `${host}@${address}`
  if (current?.key === key) return current.agent
  void current?.agent.close()
  const agent = new Agent({ connect: { lookup: pinnedLookup(address) } })
  current = { key, agent }
  return agent
}

/**
 * Close the dispatcher, if one is open.
 *
 * The plugin's own lifetime is the host's, so this is only for a test or
 * a shutdown that wants the sockets gone now.
 */
export async function closeDispatcher(): Promise<void> {
  const agent = current?.agent
  current = undefined
  if (agent !== undefined) await agent.close()
}

/**
 * The failures that mean "this address is gone", as error codes.
 *
 * Every code here describes a connection that was never established, or a
 * handshake that never completed: the request was not sent, so sending it
 * again to another address cannot duplicate it.
 *
 * A timeout *after* the headers were expected is deliberately absent. The
 * request may have reached the server, and a body sent twice is a body the
 * provider bills twice.
 */
const SPENT_ADDRESS_CODES: ReadonlySet<string> = new Set([
  // The socket never came up.
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'ETIMEDOUT', 'EADDRNOTAVAIL', 'EAI_AGAIN',
  // undici's own names for the same two moments.
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  // The handshake never completed: the address belongs to somebody else.
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'CERT_REVOKED', 'CERT_UNTRUSTED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG', 'EPROTO',
])

/**
 * Find the error code of a failure, wherever it ended up.
 *
 * Every layer that wraps a request adds its own envelope: undici nests the
 * socket error under `cause`, and the provider SDK nests that under its own
 * `cause` again. The code is the same in all of them, so the chain is walked
 * rather than assumed.
 * @param error - the failure.
 * @returns the first code found, or undefined.
 */
function codeOf(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== 'object') return undefined
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Whether a failure means the pinned address is gone.
 *
 * Only a failure that happened before the request was sent qualifies: such a
 * request may be sent again, to the address the system would have chosen,
 * and the answer is the one the caller gets.
 * @param error - the failure.
 * @returns true when the request was never sent.
 */
function addressIsGone(error: unknown): boolean {
  const code = codeOf(error)
  return code !== undefined && SPENT_ADDRESS_CODES.has(code)
}

/**
 * The pins whose address was found to be gone.
 *
 * The key carries the address, so a pin that is edited into a different one
 * is tried again: the failure of an old address says nothing about a new
 * one.
 */
const spent = new Set<string>()

/**
 * The key a pin is remembered under.
 * @param pin - the pin.
 * @returns the key.
 */
function spentKey(pin: GatewayPin): string {
  return `${pin.host}@${pin.address ?? ''}`
}

/**
 * Whether the pinned address was already found to be gone.
 *
 * A spent address is not tried again: the request that proved it gone is
 * the one that paid for it, and every later request would pay the same price
 * for the same answer.
 * @param pin - the pin.
 * @returns true when the address was found to be gone.
 */
export function isPinSpent(pin: GatewayPin): boolean {
  return pin.address !== undefined && spent.has(spentKey(pin))
}

/**
 * The name a request is for.
 *
 * A request names its host in one of three shapes: a string, a `URL`, or a
 * `Request` that already carries one. All three answer the same question.
 * @param input - the request's target.
 * @returns the lowercased host, or undefined when it cannot be read.
 */
function hostOf(input: string | URL | Request): string | undefined {
  try {
    if (typeof input === 'string') return normalize(new URL(input).hostname)
    if (input instanceof URL) return normalize(input.hostname)
    return normalize(new URL(input.url).hostname)
  } catch {
    return undefined
  }
}

/**
 * A fetch that sends the gateway's name to the pinned address.
 *
 * A request for another name is sent exactly as it would have been: the
 * dispatcher only answers the name it was given, and the rest keep the
 * system's own resolution.
 *
 * A pinned address that cannot be reached is not the end of the request.
 * The address may be gone, and the name may still be served perfectly well
 * by the address the system would have chosen — so the request is sent
 * again, that way, and the answer is the one the caller gets.
 * @param pin - the gateway's name and its pinned address.
 * @returns the fetch to use.
 */
export function gatewayFetch(pin: GatewayPin): typeof fetch {
  const address = pin.address
  // Nothing is pinned: the system's own fetch, with nothing added to it.
  if (address === undefined) return globalThis.fetch
  return async (input, init) => {
    const host = hostOf(input)
    // Another name, or no readable name at all: not this pin's business.
    if (host !== pin.host) return globalThis.fetch(input, init)
    // The address is known to be gone: do not pay for it twice.
    if (isPinSpent(pin)) return globalThis.fetch(input, init)
    try {
      const dispatcher = dispatcherFor(pin.host, address)
      return await dispatchingFetch(input, {
        ...init,
        dispatcher,
      } as unknown as RequestInit)
    } catch (error: unknown) {
      // A request that was sent must not be sent again; a request that was
      // not sent may be, and the only question is whether the address or the
      // network is at fault.
      if (!addressIsGone(error)) throw error
      // The caller's own deadline owns the answer now: sending it again
      // would race the same clock.
      if (init?.signal?.aborted === true) throw error
      spent.add(spentKey(pin))
      // The pinned address did not take. Say so, and let the system resolve.
      return globalThis.fetch(input, init)
    }
  }
}
