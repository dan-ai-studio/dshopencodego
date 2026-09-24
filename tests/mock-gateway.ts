/**
 * A real local HTTP server standing in for the OpenCode Go gateway.
 *
 * Tests drive the real adapter and the real pi-ai transports against this
 * server, so every assertion about a request header or body is made on bytes
 * that actually crossed a socket rather than on a stubbed fetch call.
 *
 * @module tests/mock-gateway
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One request the server received. */
export interface RecordedRequest {
  readonly method: string
  /** Pathname only, so a query string cannot hide a route. */
  readonly path: string
  /** The raw request target, including any query string. */
  readonly url: string
  readonly headers: IncomingMessage['headers']
  readonly body: unknown
}

/** What one streaming endpoint answers with. */
export interface MockGatewayOptions {
  /** Ids the `/models` listing advertises. */
  readonly listing?: readonly string[]
  /** Usage windows the `/usage` endpoint reports. */
  readonly usage?: unknown
  /** Answer the listing with this status instead of 200. */
  readonly listingStatus?: number
  /** Require this bearer token; a mismatch answers 401. */
  readonly apiKey?: string
  /** Stream one tool call instead of plain text on Chat Completions. */
  readonly toolCall?: boolean
  /** Answer every inference endpoint with this status and body. */
  readonly failInference?: { status: number; body: unknown }
}

/** A running mock gateway. */
export interface MockGateway {
  /** Base URL to configure the plugin with, ending in `/v1`. */
  readonly baseURL: string
  /** Every request received, in order. */
  readonly requests: RecordedRequest[]
  /** Replace the advertised ids for the next listing read. */
  setListing(ids: readonly string[]): void
  /**
   * Change the status the listing answers with. Failing a live server is the
   * deterministic way to test an outage: closing the socket instead races the
   * HTTP client's keep-alive pool, which may still complete one more request.
   */
  setListingStatus(status: number): void
  close(): Promise<void>
}

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }

/** Chat Completions SSE: text or one tool call, then a terminal usage chunk. */
function chatCompletionsStream(text: string, toolCall: boolean): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, unknown>): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: 'mock',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...usage === undefined ? {} : { usage },
    })}\n\n`
  const usage = { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14, prompt_tokens_details: { cached_tokens: 5 } }
  if (toolCall) {
    return chunk({ role: 'assistant', content: '' }, null)
      + chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] }, null)
      + chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, null)
      + chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, null)
      + chunk({}, 'tool_calls', usage)
      + 'data: [DONE]\n\n'
  }
  return chunk({ role: 'assistant', content: '' }, null)
    + chunk({ content: text }, null)
    + chunk({}, 'stop', usage)
    + 'data: [DONE]\n\n'
}

/** Anthropic Messages SSE: one text block, then a terminal message_delta. */
function anthropicStream(text: string): string {
  const event = (name: string, payload: Record<string, unknown>): string =>
    `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
  return event('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'mock', content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 2 },
    },
  })
    + event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    + event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    + event('content_block_stop', { type: 'content_block_stop', index: 0 })
    + event('message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 },
    })
    + event('message_stop', { type: 'message_stop' })
}

/** OpenAI Responses SSE: one assistant message, then a terminal usage event. */
function responsesStream(text: string): string {
  const event = (name: string, payload: Record<string, unknown>): string =>
    `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
  const message = (status: string, withContent: boolean): Record<string, unknown> => ({
    id: 'msg_1', type: 'message', status, role: 'assistant',
    content: withContent ? [{ type: 'output_text', text, annotations: [] }] : [],
  })
  return event('response.created', {
    type: 'response.created',
    response: { id: 'resp_1', object: 'response', status: 'in_progress', model: 'mock', output: [] },
  })
    + event('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: message('in_progress', false) })
    + event('response.output_text.delta', {
      type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text,
    })
    + event('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: message('completed', true) })
    + event('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_1', object: 'response', status: 'completed', model: 'mock',
        output: [message('completed', true)],
        usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13, input_tokens_details: { cached_tokens: 3 } },
      },
    })
}

/** Read a request body as JSON, tolerating an empty body. */
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Start the mock gateway on an ephemeral loopback port.
 * @param options - listing, usage, and credential expectations.
 * @returns the running gateway; call `close()` to stop it.
 */
export async function startMockGateway(options: MockGatewayOptions = {}): Promise<MockGateway> {
  let listing = [...options.listing ?? ['glm-5.3', 'kimi-k3', 'deepseek-v4.1-flash']]
  let listingStatus = options.listingStatus ?? 200
  const requests: RecordedRequest[] = []
  const server: Server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request)
      const url = request.url ?? '/'
      // Route on the pathname: real SDKs append query strings (the Anthropic
      // SDK sends `/v1/messages?beta=true`).
      const path = new URL(url, 'http://127.0.0.1').pathname
      requests.push({ method: request.method ?? 'GET', path, url, headers: request.headers, body })
      const authorization = request.headers.authorization
      if (options.apiKey !== undefined && authorization !== `Bearer ${options.apiKey}`) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'AuthError', message: 'Missing API key.' } }))
        return
      }
      if (path.endsWith('/models')) {
        response.writeHead(listingStatus, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          object: 'list',
          data: listing.map(id => ({ id, object: 'model', created: 0, owned_by: 'opencode' })),
        }))
        return
      }
      if (path.endsWith('/usage')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(options.usage ?? {
          usage: {
            rolling: { status: 'ok', percent: 12.5, resetsAt: '2026-09-24T20:00:00.000Z' },
            weekly: { status: 'ok', percent: 44, resetsAt: '2026-09-28T00:00:00.000Z' },
            monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-10-01T00:00:00.000Z' },
          },
        }))
        return
      }
      if (options.failInference !== undefined
        && (path.endsWith('/chat/completions') || path.endsWith('/messages') || path.endsWith('/responses'))) {
        response.writeHead(options.failInference.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(options.failInference.body))
        return
      }
      if (path.endsWith('/chat/completions')) {
        response.writeHead(200, SSE_HEADERS)
        response.end(chatCompletionsStream('hello from completions', options.toolCall === true))
        return
      }
      if (path.endsWith('/messages')) {
        response.writeHead(200, SSE_HEADERS)
        response.end(anthropicStream('hello from messages'))
        return
      }
      if (path.endsWith('/responses')) {
        response.writeHead(200, SSE_HEADERS)
        response.end(responsesStream('hello from responses'))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `no mock for ${path}` } }))
    })()
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    setListing: (ids) => { listing = [...ids] },
    setListingStatus: (status) => { listingStatus = status },
    close: () => new Promise<void>((resolve, reject) => {
      // The SDKs pool keep-alive sockets; waiting for them to drain would hang
      // teardown, so open connections are dropped before closing.
      server.closeAllConnections()
      server.close(error => { error === undefined ? resolve() : reject(error) })
    }),
  }
}

/** One models.dev document with the entries a test needs. */
export function modelsDevDocument(
  models: Record<string, Record<string, unknown>>,
  providerNpm = '@ai-sdk/openai-compatible',
): unknown {
  return { 'opencode-go': { id: 'opencode-go', npm: providerNpm, api: 'https://opencode.ai/zen/go/v1', models } }
}

/**
 * Intercept `fetch` for the models.dev URL only, leaving every other request
 * (including the mock gateway's) on the real implementation.
 * @param document - the document to answer with, or a status to fail with.
 * @returns the recorded metadata requests, and a restore function.
 */
export function stubModelsDev(document: unknown, status = 200): { requests: Request[]; restore: () => void } {
  const requests: Request[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!url.startsWith('https://models.dev/')) return real(input as RequestInfo, init)
    requests.push(new Request(url, init))
    if (status !== 200) return new Response('nope', { status })
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: '"v1"' },
    })
  }) as typeof fetch
  return { requests, restore: () => { globalThis.fetch = real } }
}
