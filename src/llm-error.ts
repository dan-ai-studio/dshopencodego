/**
 * Raising this package's own LLM failures.
 *
 * `LlmError`'s constructor narrows `code` to DSH's built-in union, so the
 * codes this package chooses for a usage probe or a document fetch
 * (`USAGE_UNAVAILABLE`, `DOCUMENT_UNAVAILABLE`, `MODEL_METADATA_UNAVAILABLE`)
 * cannot use it. `LlmError.fromFailure` accepts any code, which is the path
 * this package takes for every failure it defines itself.
 *
 * @module @dan-ai-studio/dshopencodego/llm-error
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * Build an {@link LlmError} carrying a code this package chose.
 * @param message - human-readable failure text.
 * @param code - this package's stable machine code.
 * @param options - optional cause.
 * @returns the error to throw.
 */
export function llmFailure(message: string, code: string, options?: ErrorOptions): LlmError {
  return LlmError.fromFailure({ message, code }, options)
}
