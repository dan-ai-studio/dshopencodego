/**
 * The README's claims about the host, checked against the host itself.
 *
 * The README used to say that `llm-pi-ai` "sends only static profile headers,
 * which cannot vary per conversation". That stopped being true when pi-ai
 * implemented the session-header injection (2026-09-09, `561a2e06`) — and
 * nothing noticed for two months. The suite guarded the manifest against the
 * prose (`readme-consistency.spec.ts`), but nothing guarded the prose against
 * the upstream it describes. The same blind spot is what made v0.1.44 declare
 * a configurable-provider key that `llm-pi-ai` already owned.
 *
 * These assertions read the installed upstream instead of trusting a
 * remembered version, so the next upstream change turns a stale paragraph
 * into a red test.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PI_AI_HEADERS = 'node_modules/@earendil-works/pi-ai/dist/providers/opencode-headers.js'
const PI_AI_MODELS = 'node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json'
const DSH_LLM_TYPES = 'node_modules/@deepseek-ai/dsh-llm/lib/types'

/** The Chinese and English wording of the claim that upstream invalidated. */
const OBSOLETE_CLAIM = /只发静态 profile headers|无法按会话取值|sends only static profile headers|cannot vary per conversation/
/** The wording that is only true while upstream injects the header. */
const CLAIM_UPSTREAM_COVERS = /原生 DSH 现在也不会缺会话头|stock DSH route does not miss the header/

function readmeText(file: string): string {
  return readFileSync(file, 'utf8')
}

/** Whether the installed pi-ai injects the per-conversation session header. */
function upstreamInjectsSessionHeader(): boolean {
  if (!existsSync(PI_AI_HEADERS)) return false
  return readFileSync(PI_AI_HEADERS, 'utf8').includes('x-opencode-session')
}

/** Every `.d.ts` the host ships, so a capability can be looked for by name. */
function hostTypeFiles(): string[] {
  if (!existsSync(DSH_LLM_TYPES)) return []
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.d.ts')) found.push(path)
    }
  }
  walk(DSH_LLM_TYPES)
  return found
}

describe('README claims about the upstream', () => {
  it('recognizes the obsolete wording it guards against', () => {
    // A guard whose pattern cannot match is not a guard: both phrasings were
    // live in the shipped README, and the Chinese one alone would have let
    // the English copy drift back.
    expect(OBSOLETE_CLAIM.test('`llm-pi-ai` 只发静态 profile headers，无法按会话取值')).toBe(true)
    expect(OBSOLETE_CLAIM.test('sends only static profile headers, which cannot vary per conversation')).toBe(true)
    expect(CLAIM_UPSTREAM_COVERS.test('因此原生 DSH 现在也不会缺会话头')).toBe(true)
    expect(CLAIM_UPSTREAM_COVERS.test('so a stock DSH route does not miss the header either')).toBe(true)
  })

  it.each(['README.md', 'README.en.md'])('states the session header the way upstream behaves in %s', (file) => {
    const text = readmeText(file)
    if (upstreamInjectsSessionHeader()) {
      // The upstream injects it, so the README must not claim the host cannot.
      expect(text, `${file} still claims the host cannot carry a per-conversation session header`).not.toMatch(OBSOLETE_CLAIM)
    } else {
      // The upstream does not inject it, so the README must not claim it does.
      expect(text, `${file} claims the host carries the session header, but the installed pi-ai does not`).not.toMatch(CLAIM_UPSTREAM_COVERS)
    }
  })

  it('keeps the upstream model table the catalog falls back to', () => {
    // The catalog's second-level fallback is pi-ai's own table; without it the
    // "four-level ladder" is three levels, and the README says four.
    expect(existsSync(PI_AI_MODELS), 'pi-ai ships no opencode-go model table').toBe(true)
    const source = readFileSync('src/catalog/index.ts', 'utf8')
    expect(source).toContain('OPENCODE_GO_MODELS')
  })

  it.each(['modelVisibility', 'usageWindow', 'rollingUsage', 'quotaWindow'])(
    'does not claim the host provides %s',
    (needle) => {
      // The comparison table says the host has none of these. If the host
      // grows one, the table is stale in the direction that overstates this
      // plugin's value — the failure mode worth catching.
      const found = hostTypeFiles().filter(file => readFileSync(file, 'utf8').includes(needle))
      expect(
        found,
        `the host now declares ${needle}; the README's comparison table is stale`,
      ).toEqual([])
    },
  )

  it.each(['README.md', 'README.en.md'])('keeps the capability comparison table in %s', (file) => {
    const text = readmeText(file)
    for (const needle of ['modelVisibility', 'TTL', 'x-opencode-session']) {
      expect(text, `${file} lost the ${needle} row`).toContain(needle)
    }
  })
})
