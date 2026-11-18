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
import { REPOSITORY } from '../src/update/check.ts'

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

/**
 * The comparison table under the "why this plugin" heading, not the version
 * tables: its header is the only one that names both the plugin and stock DSH.
 */
function capabilityTable(text: string, file: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.startsWith('|') && (line.includes('| 能力 |') || line.includes('| Capability |')))
  if (start < 0) throw new Error(`${file}: no capability table`)
  const rows: string[] = []
  for (const line of lines.slice(start)) {
    if (!line.startsWith('|')) break
    rows.push(line)
  }
  return rows.join('\n')
}

/**
 * Capabilities once advertised but deliberately removed. A reader deciding
 * whether to install uses this table, so a retired feature left behind as a
 * ✅ is a false promise — the same class of prose drift the version rows guard.
 * Keep the pair as it appears in each README so both translations stay honest.
 */
const RETIRED_CAPABILITIES: ReadonlyArray<readonly [string, string]> = [
  ['花费估算', 'Estimated spend'],
]

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

  it.each(['README.md', 'README.en.md'])('does not advertise retired capabilities in %s', (file) => {
    const table = capabilityTable(readmeText(file), file)
    for (const [zh, en] of RETIRED_CAPABILITIES) {
      expect(table, `${file}: retired capability "${zh}"/"${en}"`).not.toContain(zh)
      expect(table, `${file}: retired capability "${zh}"/"${en}"`).not.toContain(en)
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

  it('keeps the repository constant in step with the manifest', () => {
    // The constant builds the release-notes link, so a drift here sends users
    // to a 404 rather than to the notes.
    const url = (manifest as { repository?: { url?: string } }).repository?.url ?? ''
    const slug = url.replace(/^git\+/, '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')
    expect(slug).not.toBe('')
    expect(REPOSITORY).toBe(slug)
  })

  it('points the update-notes link at the release, not the package page', () => {
    // npm renders the README, which carries no changelog, so the old npmjs
    // link could not answer what changed in the version being offered.
    const section = readFileSync('src/client/Section.tsx', 'utf8')
    expect(section).toContain('/releases/tag/v')
    expect(section).not.toContain('npmjs.com/package')
  })
})
