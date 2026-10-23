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
import { vi } from 'vitest'
import type { GoDoc } from '../src/catalog/go-doc.ts'
import type { WireProtocol } from '../src/catalog/protocol.ts'
import type { GoQuota } from '../src/go-limits.ts'
import { MODELS_DEV_FIXTURE } from './fixtures/models-dev.ts'

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
  /** Answer the usage endpoint with this status instead of 200. */
  readonly usageStatus?: number
  /** Require this bearer token; a mismatch answers 401. */
  readonly apiKey?: string
  /** Stream one tool call instead of plain text on Chat Completions. */
  readonly toolCall?: boolean
  /** Answer every inference endpoint with this status and body. */
  readonly failInference?: { status: number; body: unknown }
  /**
   * Answer every inference endpoint with a 200 and this raw stream body.
   *
   * A gateway failure that arrives *inside* an open stream carries no status
   * code at all, which is why it needs its own door: `failInference` always
   * sets one, and a status code alone would classify the failure before the
   * text is ever read.
   */
  readonly streamBody?: string
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
 * Ports the fetch specification refuses, within the ephemeral range.
 *
 * The specification blocks a list of ports for the sake of the services
 * that usually live on them; undici enforces it, so a request to one of
 * them fails with `bad port` before it is sent. The operating system's
 * ephemeral range overlaps that list, and a mock that lands on one of these
 * fails every request it was started to serve.
 */
const BLOCKED_PORTS = new Set([
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697,
])

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
        response.writeHead(options.usageStatus ?? 200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(options.usage ?? {
          usage: {
            rolling: { status: 'ok', percent: 12.5, resetsAt: '2026-09-24T20:00:00.000Z' },
            weekly: { status: 'ok', percent: 44, resetsAt: '2026-09-28T00:00:00.000Z' },
            monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-10-01T00:00:00.000Z' },
          },
        }))
        return
      }
      if (options.streamBody !== undefined
        && (path.endsWith('/chat/completions') || path.endsWith('/messages') || path.endsWith('/responses'))) {
        response.writeHead(200, SSE_HEADERS)
        response.end(options.streamBody)
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
  let address = server.address() as AddressInfo
  // The operating system hands out any free port, and some of them are
  // ports the fetch specification refuses: 6697 is IRC over TLS, and
  // undici rejects it with `bad port` before a byte is sent. A mock that
  // lands there fails every request it is meant to serve, for a reason that
  // has nothing to do with what is being tested. The list is the subset of
  // the specification's blocked ports that falls inside the ephemeral range.
  for (let attempt = 0; attempt < 10 && BLOCKED_PORTS.has(address.port); attempt += 1) {
    await new Promise<void>(resolve => {
      server.closeAllConnections()
      server.close(() => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    })
    address = server.address() as AddressInfo
  }
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    setListing: (ids) => { listing = [...ids] },
    setListingStatus: (status) => { listingStatus = status },
    close: () => new Promise<void>((resolve, reject) => {
      // The SDKs pool keep-alive sockets; waiting for them to drain would hang
      // teardown, so open connections are dropped before closing.
      server.closeAllConnections()
      server.close(error => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}

/**
 * A documentation reader that never touches the network.
 *
 * Tests pass this through `CatalogOptions.readDocument`; the real fetch is
 * exercised only by the parser's own suite, against a stubbed `fetch`.
 */
export function offlineDocument(
  quotas: Record<string, GoQuota> = {},
  protocols: Record<string, WireProtocol> = {},
): () => Promise<GoDoc> {
  return async () => ({
    quotas: new Map(Object.entries(quotas)),
    protocols: new Map(Object.entries(protocols)) as ReadonlyMap<string, WireProtocol>,
  })
}

/** One models.dev document with the entries a test needs. */
export function modelsDevDocument(
  models: Record<string, Record<string, unknown>>,
  providerNpm = '@ai-sdk/openai-compatible',
): unknown {
  return { 'opencode-go': { id: 'opencode-go', npm: providerNpm, api: 'https://opencode.ai/zen/go/v1', models } }
}

// 缓存 Node.js 系统原生最底层的 fetch 通信函数，只抓取一次，防止被测试中途篡改
// 就像存一个"绝对真实的原版印章"，发给本地测试服务器的请求永远用它
const realNativeFetch = globalThis.fetch

/**
 * 默认的全局离线拦截器函数：
 * 如果有人请求 models.dev，直接用本地录制好的样本数据回复，绝不打外网；
 * 如果请求的是本地测试网关（http://127.0.0.1:*），直接放行给原生网络通信。
 */
export function defaultOfflineFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (!url.startsWith('https://models.dev/')) {
    return realNativeFetch(input as RequestInfo, init)
  }
  return Promise.resolve(new Response(JSON.stringify(MODELS_DEV_FIXTURE), {
    status: 200,
    headers: { 'content-type': 'application/json', etag: '"v1"' },
  }))
}

/** 在每个测试运行前，通过 vitest 的 vi.stubGlobal 安装默认的离线守卫 */
export function installDefaultModelsDevMock(): void {
  installed = undefined
  vi.stubGlobal('fetch', defaultOfflineFetch)
}

/**
 * Intercept `fetch` for the models.dev URL only, leaving every other request
 * (including the mock gateway's) on the real implementation.
 *
 * 【原英文注释】
 * Only one stub may be installed at a time: a nested stub would save the outer
 * stub as its "real" fetch and chain restores, which turns a forgotten
 * `restore()` into a silently stale global.
 *
 * 【初二小白详细通俗讲解】
 * 这里是一个专门给单个测试用例用的"精准伪装器"：
 * 比如某个用例想测试"如果 models.dev 网站突然挂了返回 500 怎么办"，
 * 它就会调用这个函数传一个 500。
 * 我们现在改用 vitest 官方推荐的 `vi.stubGlobal('fetch', ...)` 来做全局替换，
 * 它能和 `tests/setup.ts` 里的 `vi.unstubAllGlobals()` 完美配对，
 * 再也不会在 28 个测试文件并行跑的时候因为"谁动了全局变量"而互相打架了！
 *
 * @param document - 想要返回给测试的伪造数据
 * @param status - HTTP 状态码，比如 200 代表成功，500 代表失败
 * @returns 包含被拦截的请求列表 requests，以及一个恢复原状的函数 restore
 */
let installed: ((...args: Parameters<typeof fetch>) => Promise<Response>) | undefined

export function stubModelsDev(document: unknown, status = 200): { requests: Request[]; restore: () => void } {
  const requests: Request[] = []
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    // 不是发给 models.dev 的请求（例如本地 mock gateway 的请求），直接走原生网络通讯
    if (!url.startsWith('https://models.dev/')) return realNativeFetch(input as RequestInfo, init)
    requests.push(new Request(url, init))
    if (status !== 200) return new Response('nope', { status })
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: '"v1"' },
    })
  }) as typeof fetch

  // 关键加固：改用 vitest 官方的 vi.stubGlobal 注入全局变量，与 setup.ts 中的 unstub 配对
  vi.stubGlobal('fetch', stub)
  installed = stub

  return {
    requests,
    restore: () => {
      // 幂等恢复：只有当前生效的确实是自己时，才清理并切回默认离线兜底拦截器
      if (installed !== stub) return
      installed = undefined
      vi.stubGlobal('fetch', defaultOfflineFetch)
    },
  }
}

