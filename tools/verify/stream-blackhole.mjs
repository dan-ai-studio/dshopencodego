/**
 * A selective black hole in front of the real OpenCode Go gateway.
 *
 * The catalog and usage endpoints are proxied through to the real gateway so
 * a listing succeeds, while every inference endpoint accepts the request and
 * never answers. That is the only way to exercise a route's stream-idle
 * deadline against a transport that stops producing but does not close.
 *
 * Usage: node tools/verify/stream-blackhole.mjs <port> <logfile> [target]
 */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 18089)
const logfile = process.argv[3] ?? 'blackhole-proxy.jsonl'
const target = process.argv[4] ?? 'https://opencode.ai'

const HOP_BY_HOP = new Set(['connection', 'transfer-encoding', 'keep-alive', 'host', 'content-encoding', 'content-length'])

/** Endpoints that must reach the real gateway. */
const PASSTHROUGH = [/\/models$/, /\/usage$/]

const server = createServer((request, response) => {
  const url = request.url ?? '/'
  const path = new URL(url, 'http://127.0.0.1').pathname
  appendFileSync(logfile, `${JSON.stringify({ at: Date.now(), method: request.method, url })}\n`)
  if (!PASSTHROUGH.some(pattern => pattern.test(path))) {
    console.log(`${new Date().toISOString()} swallowed ${request.method} ${url}`)
    // Deliberately never answered: the socket stays open with no bytes back.
    return
  }
  void (async () => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const upstream = await fetch(`${target}${url}`, {
      method: request.method,
      headers: Object.fromEntries(Object.entries(request.headers)
        .filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase()))
        .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value ?? ''])),
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.concat(chunks),
      redirect: 'error',
    })
    response.writeHead(upstream.status, { 'content-type': 'application/json' })
    for await (const chunk of upstream.body) response.write(chunk)
    response.end()
  })().catch((error) => {
    response.writeHead(502, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: String(error) }))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`stream black hole on http://127.0.0.1:${port} -> ${target} (inference swallowed, log: ${logfile})`)
})
