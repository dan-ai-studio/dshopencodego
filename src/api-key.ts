/**
 * The one definition of a well-formed provider API key.
 *
 * The Host owns this check, but it has moved between releases: DSH
 * 0.2.2-rc.5 exports `assertUsableApiKey` from `@deepseek-ai/dsh-llm`, while a
 * later master commit (`0ab4c8305c`, "take the API key check from
 * dsh-credentials") removes it there and keeps `normalizeApiKey` in
 * `@deepseek-ai/dsh-credentials` instead. A plugin that imports either export
 * crashes on the other release — the bare `llm.assertUsableApiKey is not a
 * function` that this module exists to prevent — and `dsh-credentials` at
 * rc.5 has no `api-key.ts` at all, so there is no single module to import
 * from. The two definitions are byte-for-byte the same policy, so the plugin
 * carries the policy itself and depends on neither release's export.
 *
 * @module @dan-ai-studio/dshopencodego/api-key
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * Characters an HTTP header value carries verbatim and every known provider
 * key uses: printable ASCII, space excluded. A key outside this set cannot
 * reach any provider — `fetch` refuses to build the header — so this is a
 * transport invariant rather than one provider's policy. Latin-1 is excluded
 * deliberately: a header could carry it, but no provider issues it, and
 * admitting it trades a local explained refusal for an opaque 401.
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/** Why a supplied API key cannot be used. */
export type ApiKeyRejection = 'empty' | 'illegalCharacters'

/** The verdict on one supplied API key. */
export type ApiKeyCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: ApiKeyRejection }

/**
 * Judge one *supplied* API key, trimming surrounding whitespace first.
 *
 * Trimming is silent because a padded key has one unambiguous reading; every
 * other defect is reported. Absence is a configuration state the caller owns:
 * a profile naming no credential authenticates through the provider's own
 * ambient discovery or OAuth, so the caller decides whether a value was
 * supplied before asking.
 * @param raw - the key exactly as configured, stored, or typed.
 * @returns the trimmed key, or why it cannot be used.
 */
export function normalizeApiKey(raw: string): ApiKeyCheck {
  const value = raw.trim()
  if (value.length === 0) return { ok: false, reason: 'empty' }
  if (!LEGAL_API_KEY.test(value)) return { ok: false, reason: 'illegalCharacters' }
  return { ok: true, value }
}

/**
 * Resolve one credential reference to a usable key, or fail with the Host's
 * wording and code.
 *
 * The messages match `dsh-llm`'s removed `assertUsableApiKey` and the
 * `llm-pi-ai` replacement that succeeded it, so a key rejected here reads the
 * same on every release. The key itself never enters the text.
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
