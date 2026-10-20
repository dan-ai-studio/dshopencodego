/**
 * The provider's documentation URL is a moving target, and nothing else in
 * the suite would notice it moving.
 *
 * Every other case in this file injects a document, so the parser can only be
 * proven against a document that still exists. When the provider restructured
 * its site, both sources answered 404 and the plugin fell back to a guessed
 * protocol for every model the installed catalog does not describe — a
 * degradation no test saw, because the tests never left the machine.
 *
 * These cases are read-only GETs of a public document. They cost nothing and
 * bill nothing. What they buy is a red build the day the path moves again,
 * instead of a page that quietly says "protocol inferred".
 */
import { describe, expect, it } from 'vitest'
import { fetchGoDocument, GO_DOC_URLS } from '../src/catalog/go-doc.ts'

/** The read has to cross the network; the default timeout is too tight. */
const NETWORK_TIMEOUT_MS = 30_000

describe('the provider document sources', () => {
  it('answers 200 at every source', async () => {
    for (const url of GO_DOC_URLS) {
      const response = await fetch(url, { headers: { accept: 'text/plain' } })
      expect(response.status, `${url} answered ${response.status}`).toBe(200)
      await response.body?.cancel().catch(() => {})
    }
  }, NETWORK_TIMEOUT_MS)

  it('carries the endpoint table this plugin reads', async () => {
    const document = await fetchGoDocument()
    // The provider's own statement of each model's protocol: the most
    // authoritative evidence the plugin has, and the one that disappears
    // silently when the path moves.
    expect(document.protocols.size).toBeGreaterThan(0)
    expect(document.protocols.get('minimax-m3.1-flash-free')).toBe('openai-completions')
  }, NETWORK_TIMEOUT_MS)
})
