/**
 * Raising this package's own LLM failures.
 *
 * `LlmError`'s constructor narrowed `code` to DSH's built-in union in
 * `0.2.2-rc.2`, and that release added `LlmError.fromFailure` for a code any
 * provider may have chosen. This package's side-channel codes
 * (`USAGE_UNAVAILABLE`, `DOCUMENT_UNAVAILABLE`, `MODEL_METADATA_UNAVAILABLE`)
 * are deliberately outside that union: they describe a usage probe or a
 * document fetch, not a model request, and the built-in taxonomy has no word
 * for them.
 *
 * Both paths are tried, because the declared peer range reaches back before
 * `fromFailure` existed: the running build's method wins when present, and the
 * constructor otherwise — its runtime check only requires a non-empty string,
 * which is what `0.2.0-rc.1` through `0.2.2-rc.1` relied on.
 *
 * @module @dan-ai-studio/dshopencodego/llm-error
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/** The `fromFailure` static, absent before DSH `0.2.2-rc.2`. */
interface LlmErrorRaiser {
  fromFailure?: (failure: { message: string; code: string }, options?: ErrorOptions) => LlmError
}

/**
 * Build an {@link LlmError} carrying a code this package chose.
 * @param message - human-readable failure text.
 * @param code - this package's stable machine code.
 * @param options - optional cause.
 * @returns the error to throw.
 */
export function llmFailure(message: string, code: string, options?: ErrorOptions): LlmError {
  const raise = (LlmError as unknown as LlmErrorRaiser).fromFailure
  if (typeof raise === 'function') return raise.call(LlmError, { message, code }, options)
  // Before `fromFailure` the constructor accepted any non-empty string; the
  // cast is the one place that older signature is still needed.
  return new LlmError(message, code as never, options)
}
