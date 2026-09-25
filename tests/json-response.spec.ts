/**
 * Bounded JSON reads: caps are enforced before parsing, and every failure
 * mode surfaces as a named error rather than memory growth or a bare throw.
 */
import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { readBoundedJson } from '../src/catalog/json-response.ts'

function response(body: string | null, contentLength?: number): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...contentLength === undefined ? {} : { 'content-length': String(contentLength) },
    },
  })
}

describe('readBoundedJson', () => {
  it('parses a document inside the cap', async () => {
    await expect(readBoundedJson(response('{"a":1}'), 'https://x.test/doc', 1024)).resolves.toEqual({ a: 1 })
  })

  it('refuses a body whose declared length already exceeds the cap', async () => {
    const error = await readBoundedJson(response('{"a":1}', 10_000), 'https://x.test/doc', 16).catch(error => error)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('DISCOVERY_FAILED')
    expect(String((error as LlmError).message)).toMatch(/over the .* cap/)
  })

  it('aborts a body that grows past the cap while streaming', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":"'))
        controller.enqueue(new TextEncoder().encode('x'.repeat(64)))
        controller.enqueue(new TextEncoder().encode('"}'))
        controller.close()
      },
    })
    const error = await readBoundedJson(new Response(stream), 'https://x.test/doc', 16).catch(error => error)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('DISCOVERY_FAILED')
  })

  it('names invalid JSON instead of throwing a bare SyntaxError', async () => {
    const error = await readBoundedJson(response('not json'), 'https://x.test/doc', 1024).catch(error => error)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('DISCOVERY_FAILED')
    expect(String((error as LlmError).message)).toMatch(/did not answer with JSON/)
  })
})
