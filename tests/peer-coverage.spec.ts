/**
 * Every DSH package the source reaches must be a declared peer.
 *
 * DSH's compatibility gate reads only `peerDependencies`, so a package the
 * source imports but the manifest omits is one the gate cannot see: a rename
 * or removal on the host side then surfaces as a runtime failure instead of a
 * load-time refusal. Type-only imports and `declare module` augmentations count
 * — they bind the host's Context and SlotMap shapes just as much.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import packageJson from '../package.json' with { type: 'json' }

const SOURCE_ROOT = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function packagesUsedInSource(): Set<string> {
  const used = new Set<string>()
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const text = readFileSync(file, 'utf8')
    const specifiers = [
      ...text.matchAll(/(?:from|declare\s+module)\s*'(@deepseek-ai\/[^']+)'/g),
    ]
    for (const [, specifier] of specifiers) {
      // `@deepseek-ai/dsh-foo/client` and `@deepseek-ai/dsh-foo` are one package.
      const [scope, name] = specifier!.split('/')
      const packageName = `${scope}/${name}`
      // schemastery is an ordinary dependency; the host seam is what the
      // compatibility gate governs.
      if (packageName.startsWith('@deepseek-ai/dsh-') || packageName === '@deepseek-ai/cordis') {
        used.add(packageName)
      }
    }
  }
  return used
}

describe('peer coverage', () => {
  it('declares every DSH package the source imports', () => {
    const peers = Object.keys(packageJson.peerDependencies)
    const undeclared = [...packagesUsedInSource()].filter(name => !peers.includes(name)).sort()
    expect(undeclared).toEqual([])
  })

  it('declares no peer the source never reaches', () => {
    const used = packagesUsedInSource()
    const unused = Object.keys(packageJson.peerDependencies)
      .filter(name => name.startsWith('@deepseek-ai/'))
      .filter(name => !used.has(name))
      .sort()
    expect(unused).toEqual([])
  })
})
