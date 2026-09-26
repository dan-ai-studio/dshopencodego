/**
 * Bounded body reads shared by the catalog, the usage endpoint, and the Go
 * documentation fetch.
 *
 * Every outbound metadata read is capped before parsing: the documents are
 * third-party, and a truncated or oversized reply must surface as a named
 * failure rather than as memory growth.
 *
 * @module @dan-ai-studio/dshopencodego/catalog/json-response
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * Read a response body as JSON without trusting its length.
 * @param response - an OK response whose body is the document.
 * @param url - the URL, for diagnostics.
 * @param maxBytes - hard cap on the decoded document.
 * @returns the parsed JSON value.
 * @throws {LlmError} `DISCOVERY_FAILED` on a transport fault, an over-cap body,
 *   or invalid JSON.
 */
export async function readBoundedJson(response: Response, url: string, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new LlmError(`${url} declares ${declared} bytes, over the ${maxBytes}-byte cap`, 'DISCOVERY_FAILED')
  }
  let text: string
  try {
    text = await readBoundedText(response, maxBytes)
  } catch (error: unknown) {
    if (error instanceof LlmError) throw error
    throw new LlmError(`could not read ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  try {
    return JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
}

/** Decode a body as text, aborting once it passes the cap. */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new LlmError(`response exceeds the ${maxBytes}-byte cap`, 'DISCOVERY_FAILED')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}
