/**
 * The one definition of a usable provider API key.
 *
 * The Host owns the policy: `@deepseek-ai/dsh-credentials` exports
 * `normalizeApiKey`, and this module only turns its verdict into the
 * `LlmError` a provider raises. Reading the check from the Host instead of
 * restating it means the key this plugin accepts can never drift from the key
 * every other provider on the same release accepts.
 *
 * @module @dan-ai-studio/dshopencodego/api-key
 */

import { normalizeApiKey } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * Resolve one credential reference to a usable key, or fail with the Host's
 * wording and code.
 *
 * The messages match the `llm-pi-ai` check this seam replaces, so a key
 * rejected here reads the same as one rejected there. The key itself never
 * enters the text.
 * @param raw - the key exactly as the credential seam returned it.
 * @param pkg - the plugin name, as the Host's own diagnostics prefix it.
 * @param ref - the credential reference the value was resolved from.
 * @returns the trimmed key.
 * @throws {LlmError} `INVALID_CREDENTIAL` when the key is blank or carries
 * characters no HTTP header can transport.
 */
export function assertUsableApiKey(raw: string, pkg: string, ref: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  // The Models page is named as the writer it usually is, not as the only one:
  // the same value can arrive from a hand-edited .env or a shell export in a
  // composition that mounts no credentials seam at all, where directing the
  // user to a page that deployment does not serve would be a dead end.
  throw new LlmError(
    checked.reason === 'empty'
      ? `${pkg}: the API key resolved from ${ref} is blank; set ${ref} to the raw key`
        + ' (the web Models page writes it) or export it in the launching environment'
      : `${pkg}: the API key resolved from ${ref} contains characters no HTTP header can carry;`
        + ` set ${ref} to the raw key alone (the web Models page writes it)`,
    'INVALID_CREDENTIAL',
  )
}
