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
import { describe, expect, it } from 'vitest'
import packageJson from '../package.json' with { type: 'json' }

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
})
