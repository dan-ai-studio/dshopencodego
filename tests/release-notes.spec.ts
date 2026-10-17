/**
 * The changelog extractor must survive the section it is most often asked for.
 *
 * `release.yml` prints one version's CHANGELOG section as the release body, and
 * the version being released is normally the **last** section in the file. The
 * lookahead that delimits a section used to end in `\Z`, which JavaScript's
 * RegExp does not define: in a non-unicode pattern an unrecognized escape is the
 * literal character, so the alternation was really `|Z` and a final section
 * matched only when a capital `Z` happened to follow it. `0.1.20` — the last
 * section at the time — therefore made the script exit 1 for the wrong reason.
 *
 * These cases are run against the real script as a child process, because the
 * defect lived in the regex literal rather than in any function it exports.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const versions = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map(match => match[1]!)
const packaged = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

/** Run the real script, with `GITHUB_REF_NAME` cleared so only argv decides. */
function releaseNotes(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['scripts/release-notes.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF_NAME: '' },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('release-notes.mjs', () => {
  it('emits the packaged version section', () => {
    const { status, stdout } = releaseNotes([packaged])
    expect(status).toBe(0)
    expect(stdout.startsWith(`## ${packaged}`)).toBe(true)
    expect(stdout.trim().length).toBeGreaterThan(`## ${packaged}`.length)
  })

  it('emits the last section in the changelog', () => {
    // The regression this file exists for: the final section has no following
    // `## [` heading, so only the end-of-input alternative can delimit it.
    expect(versions.length).toBeGreaterThan(1)
    const last = versions[versions.length - 1]!
    const { status, stdout } = releaseNotes([last])
    expect(status, `last section is ${last}`).toBe(0)
    expect(stdout.startsWith(`## ${last}`)).toBe(true)
    expect(stdout.trim().length).toBeGreaterThan(`## ${last}`.length)
  })

  it('stops at the next version heading instead of leaking the rest of the file', () => {
    const newest = versions[0]!
    const next = versions[1]
    expect(next).toBeDefined()
    const { stdout } = releaseNotes([newest])
    expect(stdout).not.toContain(`## [${next}]`)
  })

  it('refuses a version the changelog never mentions', () => {
    const { status, stderr } = releaseNotes(['9.9.9'])
    expect(status).toBe(1)
    expect(stderr).toContain('refusing to emit an empty description')
  })

  it('refuses an argument that is not a version', () => {
    expect(releaseNotes(['nonsense']).status).toBe(1)
  })

  it('refuses to guess when nothing names a version', () => {
    expect(releaseNotes([]).status).toBe(1)
  })
})
