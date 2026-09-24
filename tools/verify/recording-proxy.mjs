/**
 * A recording reverse proxy in front of the real OpenCode Go gateway.
 *
 * Verification needs two things at once that a mock cannot give: the real
 * gateway's answers, and a record of the exact bytes a real Harness process
 * sent. This forwards every request unchanged and appends the received headers
 * to a JSONL file, so the session-header claim is checked on a live run rather
 * than asserted from the adapter's own view of itself.
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
      headers: request.headers,
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
