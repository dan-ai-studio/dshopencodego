/**
 * Pinning: the address a name is sent to, and what happens when that
 * address is gone.
 *
 * The servers are real sockets on the loopback interface, and the two of
 * them answer differently, so a request that reached the pinned address can
 * be told apart from one that reached the system's own resolution. Nothing
 * here leaves the machine: the names used are either loopback addresses or
 * names that resolve nowhere.
 */
import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDispatcher, gatewayFetch, isPinSpent, observePool, resetSpentAddresses, resolveGatewayPin } from '../src/network/pinning.ts'
import { parseNetworkReading } from '../src/network/contract.ts'

/**
 * The idle time these tests give a kept connection.
 *
 * Long enough that a connection survives between two requests in a test, and
 * the same value the plugin ships by default.
 */
const KEEP_ALIVE_MS = 600_000

/**
 * One server on the loopback interface, answering with a fixed word.
 *
 * The address may be a name the system resolves, so the request can be told
 * apart from one that reached the pin; the port may be zero, which asks for
 * any free one.
 */
interface Loop {
  readonly port: number
  /** How many requests the server has answered. */
  readonly hits: () => number
  readonly close: () => Promise<void>
}

/**
 * A server on one address.
 * @param address - the address to bind.
 * @param port - the port to bind, or zero for any.
 * @param word - what the server answers with.
 * @returns the running server.
 */
async function serveOn(address: string, port: number, word: string): Promise<Loop> {
  let hits = 0
  const server = createServer((_request, response) => {
    hits += 1
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(word)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, address, () => { resolve() })
  })
  return {
    port: (server.address() as AddressInfo).port,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

/**
 * A server that refuses, the way an edge refuses a name it does not serve.
 * @param address - the address to bind.
 * @param port - the port to bind.
 * @param body - what the refusal says.
 * @returns the running server.
 */
async function serveRefusing(address: string, port: number, body: string): Promise<Loop> {
  let hits = 0
  const server = createServer((_request, response) => {
    hits += 1
    response.writeHead(403, { 'content-type': 'application/json' })
    response.end(body)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, address, () => { resolve() })
  })
  return {
    port: (server.address() as AddressInfo).port,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

/** The servers this file opened, closed after each case. */
const opened: Loop[] = []

afterEach(async () => {
  // The dispatcher goes first: it owns the sockets, and a server that is
  // still holding an open connection waits for the peer to let go. Closing
  // them in the other order hangs until the connection is timed out.
  await closeDispatcher()
  await Promise.all(opened.splice(0).map(loop => loop.close()))
  // The memory of a spent address belongs to the process, so it outlives
  // every request — and every test.
  resetSpentAddresses()
})

describe('pinning', () => {
  it('sends the request to the pinned address', async () => {
    // The name the plugin asks for is a name, and the address it is pinned to
    // is another: the two servers differ only in where the request lands.
    const pinned = await serveOn('127.0.0.2', 0, 'pinned')
    opened.push(pinned)

    const base = `http://localhost:${pinned.port}`
    const request = gatewayFetch(resolveGatewayPin({ localhost: '127.0.0.2' }, base), KEEP_ALIVE_MS)
    const response = await request(`${base}/`)

    expect(await response.text()).toBe('pinned')
    expect(pinned.hits()).toBe(1)
  })

  it('leaves the request to the system resolver when nothing is pinned', async () => {
    // Bound to the IPv6 loopback alone, so the IPv4 addresses stay free for
    // a pin to be gone on.
    const system = await serveOn('::1', 0, 'system')
    opened.push(system)
    const base = `http://localhost:${system.port}`

    const request = gatewayFetch(resolveGatewayPin({}, base), KEEP_ALIVE_MS)
    // Nothing is added to the system's own fetch: no pin, no dispatcher, no
    // second attempt.
    expect(request).toBe(globalThis.fetch)

    const response = await request(`${base}/`)
    expect(await response.text()).toBe('system')
  })

  it('ignores a pin for another name', async () => {    const system = await serveOn('::1', 0, 'system')
    opened.push(system)
    const base = `http://localhost:${system.port}`

    // The pin names a host this plugin never asks for, so it says nothing
    // about the gateway's own name.
    const pin = resolveGatewayPin({ 'other.test': '127.0.0.2' }, base)
    expect(pin.address).toBeUndefined()
    expect(gatewayFetch(pin, KEEP_ALIVE_MS)).toBe(globalThis.fetch)

    const response = await gatewayFetch(pin, KEEP_ALIVE_MS)(`${base}/`)
    expect(await response.text()).toBe('system')
  })

  it('names an IPv6 endpoint without the brackets a URL uses', () => {
    // A URL writes an IPv6 literal in brackets and the pin is written as the
    // address itself; the two spellings must be one key.
    expect(resolveGatewayPin({}, 'https://[2606:4700:78::90:0:143]:443/v1').host)
      .toBe('2606:4700:78::90:0:143')
  })

  it('ignores an address that is not an address', async () => {
    const system = await serveOn('::1', 0, 'system')
    opened.push(system)
    const base = `http://localhost:${system.port}`

    // A typo is worth ignoring rather than crashing in the middle of a
    // request: the request then goes to the system's own resolution.
    const pin = resolveGatewayPin({ localhost: '127.0.0.256' }, base)
    expect(pin.address).toBeUndefined()
    expect(gatewayFetch(pin, KEEP_ALIVE_MS)).toBe(globalThis.fetch)

    const response = await gatewayFetch(pin, KEEP_ALIVE_MS)(`${base}/`)
    expect(await response.text()).toBe('system')
  })

  it('falls back to the system resolver when the pinned address is gone', async () => {
    const system = await serveOn('::1', 0, 'system')
    opened.push(system)
    const base = `http://localhost:${system.port}`

    // Nothing listens on that loopback address, so the connection is
    // refused — the shape an address that is gone takes.
    const pin = resolveGatewayPin({ localhost: '127.0.0.3' }, base)
    const request = gatewayFetch(pin, KEEP_ALIVE_MS)
    const response = await request(`${base}/`)

    // The answer is the one the caller gets: the request was sent again, to
    // the address the system would have chosen.
    expect(await response.text()).toBe('system')
    expect(system.hits()).toBe(1)
    // And the address is remembered, so the next request does not pay for it
    // a second time.
    expect(isPinSpent(pin)).toBe(true)
  })

  it('falls back when the edge refuses the name', async () => {
    const system = await serveOn('::1', 0, 'system')
    opened.push(system)
    // The edge answers a name it does not serve with its own document.
    const refusing = await serveRefusing(
      '127.0.0.2',
      system.port,
      '{"type":"https://developers.cloudflare.com/errors/1000"}',
    )
    opened.push(refusing)

    const base = `http://localhost:${system.port}`
    const pin = resolveGatewayPin({ localhost: '127.0.0.2' }, base)
    const response = await gatewayFetch(pin, KEEP_ALIVE_MS)(`${base}/`)

    // The edge said "this name is not mine", so the request went again, to
    // the address the system would have chosen.
    expect(await response.text()).toBe('system')
    expect(refusing.hits()).toBe(1)
    expect(system.hits()).toBe(1)
    // And the address is remembered, so the next request does not pay for
    // the refusal again.
    expect(isPinSpent(pin)).toBe(true)
  })

  it('does not fall back when the gateway itself refuses', async () => {
    const system = await serveOn('::1', 0, 'system')
    opened.push(system)
    // A refusal in the gateway's own words: another address will not change
    // it, so it is the caller's answer.
    const refusing = await serveRefusing('127.0.0.3', system.port, '{"error":"invalid api key"}')
    opened.push(refusing)

    const base = `http://localhost:${system.port}`
    const pin = resolveGatewayPin({ localhost: '127.0.0.3' }, base)
    const response = await gatewayFetch(pin, KEEP_ALIVE_MS)(`${base}/`)

    expect(response.status).toBe(403)
    expect(refusing.hits()).toBe(1)
    expect(system.hits()).toBe(0)
    expect(isPinSpent(pin)).toBe(false)
  })

  it('does not spend an address that answered', async () => {
    const pinned = await serveOn('127.0.0.2', 0, 'pinned')
    opened.push(pinned)
    const base = `http://localhost:${pinned.port}`

    const pin = resolveGatewayPin({ localhost: '127.0.0.2' }, base)
    await gatewayFetch(pin, KEEP_ALIVE_MS)(`${base}/`)
    expect(isPinSpent(pin)).toBe(false)
  })

  it('keeps the name in the TLS handshake', async () => {    const key = readFileSync(new URL('./fixtures/pinned-test-key.pem', import.meta.url))
    const cert = readFileSync(new URL('./fixtures/pinned-test-cert.pem', import.meta.url))
    // The name the client asks for, as the server sees it.
    let seen: string | undefined
    const server = createTlsServer({
      key,
      cert,
      SNICallback: (servername, callback) => {
        seen = servername
        callback(null)
      },
    }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('over-tls')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { resolve() })
    })
    const port = (server.address() as AddressInfo).port
    opened.push({
      port,
      hits: () => 0,
      close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
    })

    // The certificate is signed for `pinned.test` and is not trusted by the
    // machine, so the handshake fails — but only after the name has been
    // offered, which is the point: the address is pinned, the name is not.
    const base = `https://pinned.test:${port}`
    const pin = resolveGatewayPin({ 'pinned.test': '127.0.0.1' }, base)
    await expect(gatewayFetch(pin, KEEP_ALIVE_MS)(`${base}/`)).rejects.toThrow()
    expect(seen).toBe('pinned.test')
  })
})

describe('the connection kept between requests', () => {
  it('survives a pause longer than the pool would otherwise allow', async () => {
    // Undici's own default lets an idle connection go after four seconds, and
    // a conversation pauses for longer than that all the time. A connection
    // dropped in the pause is one that has to be built again — a TCP and a
    // TLS handshake, about a fifth of a second from here to the gateway — and
    // that cost lands on the first token of the next turn.
    //
    // The server is a raw socket rather than an HTTP one, and the reason is
    // the `Keep-Alive` header. A server that states its own timeout has its
    // value used in preference to the client's, so an HTTP server would
    // answer with `Keep-Alive: timeout=60` and this would measure the
    // server's patience instead of the pool's. The gateway sends no such
    // header, and this server sends none either: the number that governs is
    // the pool's own.
    let connections = 0
    const server = createNetServer(socket => {
      socket.on('data', () => {
        socket.write('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 4\r\n\r\nkept')
      })
    })
    server.on('connection', () => { connections += 1 })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.2', () => { resolve() })
    })
    const port = (server.address() as AddressInfo).port
    opened.push({
      port,
      hits: () => 0,
      close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
    })

    const base = `http://localhost:${port}`
    const pin = resolveGatewayPin({ localhost: '127.0.0.2' }, base)
    const request = gatewayFetch(pin, KEEP_ALIVE_MS)

    const first = await request(`${base}/`)
    expect(await first.text()).toBe('kept')
    expect(connections).toBe(1)

    // Longer than the four seconds the pool would otherwise wait.
    await new Promise(resolve => { setTimeout(resolve, 4_500) })

    const second = await request(`${base}/`)
    expect(await second.text()).toBe('kept')
    // One connection for two requests: the socket was still there.
    expect(connections).toBe(1)
  })

  it('uses the timeout it was given, not a fixed one', async () => {
    // The idle time is a setting, so the pool has to obey the number it is
    // handed. A short one has to drop the connection — otherwise the setting
    // is a label over a constant, and a reader of the page would be misled
    // about what their value does.
    let connections = 0
    const server = createNetServer(socket => {
      socket.on('data', () => {
        socket.write('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 4\r\n\r\nkept')
      })
    })
    server.on('connection', () => { connections += 1 })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.2', () => { resolve() })
    })
    const port = (server.address() as AddressInfo).port
    opened.push({
      port,
      hits: () => 0,
      close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
    })

    const base = `http://localhost:${port}`
    const pin = resolveGatewayPin({ localhost: '127.0.0.2' }, base)
    // A second is short enough to be observed and long enough not to race.
    const request = gatewayFetch(pin, 1_000)

    await (await request(`${base}/`)).text()
    expect(connections).toBe(1)

    await new Promise(resolve => { setTimeout(resolve, 1_500) })

    await (await request(`${base}/`)).text()
    // The idle time elapsed, so the connection was let go and a new one was
    // made — the setting was obeyed.
    expect(connections).toBe(2)
  })

  it('lets go of its sockets when the plugin lets go of it', async () => {
    // The pool belongs to the plugin, and the plugin's life is the host's.
    // When the plugin is unloaded — a profile edit that reloads it, a
    // shutdown — the sockets should go with it rather than linger on the
    // machine until the process ends.
    const sockets: import('node:net').Socket[] = []
    const server = createNetServer(socket => {
      sockets.push(socket)
      socket.on('data', () => {
        socket.write('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 4\r\n\r\nkept')
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.2', () => { resolve() })
    })
    const port = (server.address() as AddressInfo).port
    opened.push({
      port,
      hits: () => 0,
      close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
    })

    const base = `http://localhost:${port}`
    const pin = resolveGatewayPin({ localhost: '127.0.0.2' }, base)
    const request = gatewayFetch(pin, KEEP_ALIVE_MS)

    await (await request(`${base}/`)).text()
    expect(sockets.length).toBe(1)

    await closeDispatcher()
    // Closing is graceful: the pool stops taking new work, finishes what it
    // has, and then lets the idle sockets go. The server sees the close, but
    // not the instant the close is asked for.
    await new Promise(resolve => { setTimeout(resolve, 500) })
    expect(sockets.every(socket => socket.destroyed)).toBe(true)
  })

  it('opens a new pool after the old one was closed', async () => {
    // Closing the pool must not leave the plugin pointing at a dead one: the
    // next request has to build a fresh pool and work.
    let connections = 0
    const server = createNetServer(socket => {
      socket.on('data', () => {
        socket.write('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 4\r\n\r\nkept')
      })
    })
    server.on('connection', () => { connections += 1 })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.2', () => { resolve() })
    })
    const port = (server.address() as AddressInfo).port
    opened.push({
      port,
      hits: () => 0,
      close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
    })

    const base = `http://localhost:${port}`
    const pin = resolveGatewayPin({ localhost: '127.0.0.2' }, base)
    const request = gatewayFetch(pin, KEEP_ALIVE_MS)

    await (await request(`${base}/`)).text()
    await closeDispatcher()
    await new Promise(resolve => { setTimeout(resolve, 200) })

    const response = await request(`${base}/`)
    expect(await response.text()).toBe('kept')
    // A new socket: the old pool was gone, so this one was built again.
    expect(connections).toBe(2)
  })
})

describe('pool observation', () => {
  it('reports pool creation and closure to its observer', async () => {
    // The request log watches pool lifecycle in debug mode. The events are
    // rare by construction — one per pool lifetime — so observing them
    // costs nothing on the request path.
    const events: Array<{ type: 'create' | 'close'; key: string }> = []
    observePool({
      create: (key) => { events.push({ type: 'create', key }) },
      close: (key) => { events.push({ type: 'close', key }) },
    })
    try {
      const server = createNetServer(socket => {
        socket.on('data', () => {
          socket.write('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 4\r\n\r\nkept')
        })
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.2', () => { resolve() })
      })
      const port = (server.address() as AddressInfo).port
      opened.push({
        port,
        hits: () => 0,
        close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
      })

      const base = `http://localhost:${port}`
      const pin = resolveGatewayPin({ localhost: '127.0.0.2' }, base)
      const request = gatewayFetch(pin, KEEP_ALIVE_MS)

      await (await request(`${base}/`)).text()
      expect(events.map(event => event.type)).toEqual(['create'])
      expect(events[0]?.key).toBe(`localhost@127.0.0.2@${KEEP_ALIVE_MS}`)

      await closeDispatcher()
      expect(events.map(event => event.type)).toEqual(['create', 'close'])
      expect(events[1]?.key).toBe(events[0]?.key)
    } finally {
      // The module-level observer outlives the test: unset it so no later
      // case records into a dead array.
      observePool(undefined)
    }
  })
})

describe('the pin on the wire', () => {
  it('keeps the address and the failure it reported', () => {
    expect(parseNetworkReading({ host: 'opencode.ai', address: '1.2.3.4', failed: true })).toEqual({
      host: 'opencode.ai',
      address: '1.2.3.4',
      failed: true,
    })
  })

  it('drops an address that is not one', () => {
    expect(parseNetworkReading({ host: 'opencode.ai', address: '' })).toEqual({ host: 'opencode.ai' })
  })

  it('refuses a reading without a host', () => {
    expect(() => parseNetworkReading({})).toThrow()
    expect(() => parseNetworkReading(null)).toThrow()
  })
})
