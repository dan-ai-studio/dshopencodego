/**
 * The published tarball must contain every file the manifest points at.
 *
 * npm strips everything outside `files` (plus a few defaults the packer
 * always keeps), so a file the whitelist forgets is not a build error here:
 * it surfaces on the installer's machine. 0.1.18 shipped exactly that —
 * `postinstall` ran `node scripts/patch-pi-ai.mjs` while `scripts` stayed
 * outside `files`, and every install died with MODULE_NOT_FOUND.
 *
 * 0.1.20 removed that hook (see adr/0005-drop-pi-ai-patch.md); the hook
 * check stays as a guard so a hook added later must land in `files` in the
 * same change. Build-side entry points (`build`/`prepare`) are exempt — they
 * run only where the full source tree is present.
 */
import { statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import packageJson from '../package.json' with { type: 'json' }
import en from '../locale/en.json' with { type: 'json' }
import zh from '../locale/zh.json' with { type: 'json' }

/** Local Node entry points a hook command runs, e.g. `node scripts/foo.mjs`. */
function nodeEntries(command: string): string[] {
  return [...command.matchAll(/(?:^|[;&|]\s*|\s)node\s+((?:\.\/)?[\w./-]+\.(?:mjs|cjs|js))\b/g)]
    .map(([, path]) => path!)
}

/** npm's `files` semantics: an exact path, or a directory prefix of one. */
function packedByFiles(path: string, files: readonly string[]): boolean {
  const normalized = path.replace(/^\.\//, '')
  return files.some((entry) => {
    const base = entry.replace(/^\.\//, '').replace(/\/$/, '')
    return normalized === base || normalized.startsWith(`${base}/`)
  })
}

describe('pack contents', () => {
  const scripts = packageJson.scripts as Record<string, string>
  const files = packageJson.files as readonly string[]

  it('includes every script the installer runs', () => {
    const hooks = [scripts.postinstall, scripts.install].filter((command): command is string => Boolean(command))
    const missing = hooks.flatMap(nodeEntries).filter(path => !packedByFiles(path, files))
    expect(missing).toEqual([])
  })

  it('includes the bundle patch the manifest points at', () => {
    const patch = (packageJson.dsh as { bundle?: { patch?: string } }).bundle?.patch
    expect(patch).toBeDefined()
    expect(packedByFiles(patch!, files)).toBe(true)
  })

  it('packs the display metadata the Host reads without evaluating code', () => {
    // The Host resolves `<specifier>/package.json`, `<specifier>/locale/*.json`
    // and the declared icon through Node's exports map, so an omission here
    // shows up as the panel's default artwork rather than as a build failure.
    // `package.json` is deliberately absent from this list: the packer always
    // ships it, which is also why the manifest's own fields cannot be fixed by
    // adding it to `files`.
    for (const resource of ['icon.svg', 'locale/en.json', 'locale/zh.json']) {
      expect(packedByFiles(resource, files), resource).toBe(true)
    }
    const exports = packageJson.exports as Record<string, unknown>
    expect(exports['./package.json']).toBeDefined()
    expect(exports['./locale/*.json']).toBeDefined()
  })

  it('declares an icon the Host can embed', () => {
    const icon = (packageJson as { icon?: unknown }).icon
    // A bare relative filename is the only form the Host resolves against the
    // manifest directory; anything else leaves the package or fails to embed.
    expect(typeof icon).toBe('string')
    expect(icon).toMatch(/^\.\/[^/]+$/)
    expect(packedByFiles(icon as string, files)).toBe(true)
    expect(['.svg', '.png', '.jpg', '.jpeg', '.webp']).toContain(extname(icon as string))
    expect(statSync(resolve(import.meta.dirname, '..', icon as string)).size).toBeLessThanOrEqual(256 * 1024)
  })

  it.each([
    ['en', en],
    ['zh', zh],
  ])('carries display text in the %s dictionary', (_language, dictionary) => {
    for (const field of ['title', 'description'] as const) {
      expect(typeof dictionary.meta[field]).toBe('string')
      expect((dictionary.meta[field] as string).trim().length).toBeGreaterThan(0)
    }
  })
})
