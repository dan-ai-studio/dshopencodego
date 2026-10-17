/**
 * A recording reverse proxy in front of the real OpenCode Go gateway.
 *
 * Verification needs two things at once that a mock cannot give: the real
 * gateway's answers, and a record of the exact bytes a real Harness process
 * sent. This forwards every request unchanged and appends the received headers
 * to a JSONL file, so the session-header claim is checked on a live run rather
 * than asserted from the adapter's own view of itself.
 *
 * The log is an evidence record, not a credential store: credential-bearing
 * headers are redacted before they are written (see `loggableHeaders`). Only
 * the copy on disk is masked — the upstream request still carries the real
 * values, so the proxy keeps working exactly as before. Without this the log
 * held `authorization: Bearer oc_sk_…` in clear text for as long as the file
 * survived, and the docs recommended running it as a matter of course.
 *
 * Usage: node tools/verify/recording-proxy.mjs <port> <logfile> [target]
 */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 8787)
const logfile = process.argv[3] ?? 'proxy-log.jsonl'
const target = process.argv[4] ?? 'https://opencode.ai'

/** Headers a proxy must not copy verbatim. */
const HOP_BY_HOP = new Set([
  'connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'host',
  // Node's fetch decodes the body, so the upstream framing headers no longer
  // describe what this proxy sends back.
  'content-encoding', 'content-length',
])

/** Headers whose value is a credential and must never reach the log in clear. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
])

/**
 * Mask one header value, keeping only what makes two runs comparable.
 *
 * The auth scheme (`Bearer`, `Basic`, …) and the total length survive; every
 * character of the credential itself is dropped. A scheme plus a length is
 * enough to tell "the adapter sent a key" from "it sent none", and to tell one
 * run from another, while a bare key with no scheme is reduced to its length.
 */
function redactHeaderValue(value) {
  const text = Array.isArray(value) ? value.join(', ') : String(value ?? '')
  const scheme = /^([A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*) /.exec(text)?.[1]
  return `${scheme === undefined ? '' : `${scheme} `}<redacted len=${text.length}>`
}

/** A copy of the received headers that is safe to persist. */
function loggableHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    SENSITIVE_HEADERS.has(name.toLowerCase()) ? redactHeaderValue(value) : value,
  ]))
}

const server = createServer((request, response) => {
  void (async () => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const url = `${target}${request.url ?? '/'}`
    let upstream
    try {
      upstream = await fetch(url, {
        method: request.method,
        headers: Object.fromEntries(Object.entries(request.headers)
          .filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase()))
          .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value ?? ''])),
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
        redirect: 'error',
      })
    } catch (error) {
      appendFileSync(logfile, `${JSON.stringify({ at: Date.now(), method: request.method, url: request.url, error: String(error) })}\n`)
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `proxy could not reach ${url}: ${String(error)}` } }))
      return
    }
    appendFileSync(logfile, `${JSON.stringify({
      at: Date.now(),
      method: request.method,
      url: request.url,
      status: upstream.status,
      headers: loggableHeaders(request.headers),
      bodyBytes: body.byteLength,
      bodyHead: body.toString('utf8').slice(0, 300),
    })}\n`)
    const headers = {}
    upstream.headers.forEach((value, name) => { if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value })
    response.writeHead(upstream.status, headers)
    if (upstream.body !== null) {
      for await (const chunk of upstream.body) response.write(chunk)
    }
    response.end()
  })()
})

server.listen(port, '127.0.0.1', () => {
  console.log(`recording proxy on http://127.0.0.1:${port} -> ${target} (log: ${logfile})`)
})
