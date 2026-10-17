/**
 * The README states the versions the manifest actually declares.
 *
 * The compatibility table is what a reader uses to decide whether the plugin
 * fits their runtime, so a stale cell is not cosmetic: it told readers the
 * bundled pi-ai was `0.87.1` three major versions after the manifest moved to
 * `~1.0.2`, and omitted the `cordis` prerelease branches that DSH
 * `0.2.1-alpha.3`+ actually runs.
 *
 * Each assertion is scoped to the specific table row, not to the document: a
 * whole-document `toContain` passed even with a stale cell, because the same
 * version string also appeared in the troubleshooting section.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  engines: Record<string, string>
  devDependencies: Record<string, string>
  peerDependencies: Record<string, string>
}

/** Markdown escapes table pipes; compare against the text a reader sees. */
function readmeText(file: string): string {
  return readFileSync(file, 'utf8').replace(/\\\|/g, '|')
}

/** The one table row that names `needle`, or a failure naming the file. */
function tableRow(text: string, file: string, needle: string): string {
  const row = text.split('\n').find(line => line.startsWith('|') && line.includes(needle))
  if (row === undefined) throw new Error(`${file}: no compatibility table row mentions ${needle}`)
  return row
}

describe('README consistency', () => {
  it.each(['README.md', 'README.en.md'])('states the real versions in %s', (file) => {
    const text = readmeText(file)
    const rows: Array<[string, string]> = [
      ['@deepseek-ai/cordis', manifest.peerDependencies['@deepseek-ai/cordis']!],
      ['engines.dsh', manifest.engines['dsh']!],
      ['engines.node', manifest.engines['node']!],
      // Bundled, so they live in devDependencies: the published package ships
      // them inside `lib/`, and an installer pulls no runtime dependencies.
      ['@earendil-works/pi-ai', manifest.devDependencies['@earendil-works/pi-ai']!],
      ['@deepseek-ai/schemastery', manifest.devDependencies['@deepseek-ai/schemastery']!],
    ]
    for (const [needle, declared] of rows) {
      expect(tableRow(text, file, needle), `${file}: the ${needle} row`).toContain(declared)
    }
  })

  it('states the peer count the manifest declares', () => {
    const text = readmeText('README.md')
    const dshPeers = Object.keys(manifest.peerDependencies).filter(name => name.startsWith('@deepseek-ai/dsh-'))
    expect(dshPeers.length).toBeGreaterThan(0)
    // The Chinese README spells the count in the table's first cell.
    expect(text).toContain(`${String(dshPeers.length)} 个 \`@deepseek-ai/dsh-*\``)
  })

  it('states the test file count the tests directory holds', () => {
    // This number was `24 files / 148 cases` long after the suite had grown to
    // 33 files and 229 cases: prose counts drift because nothing reads them.
    // Hold it to the directory instead of trusting the paragraph.
    const files = readdirSync('tests').filter(name => /\.spec\.tsx?$/.test(name))
    expect(files.length).toBeGreaterThan(0)
    expect(readmeText('README.md')).toContain(`${String(files.length)} 个测试文件`)
    expect(readmeText('README.en.md')).toContain(`${String(files.length)} test files`)
  })
})
