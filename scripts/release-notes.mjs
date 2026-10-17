/**
 * Print one version's section of CHANGELOG.md, for use as a release body.
 *
 * `release.yml` used `gh release --generate-notes`, which produced a single
 * compare link — so a release page told a reader nothing about what changed,
 * even though the changelog right next to it did. This extracts that section
 * instead.
 *
 * Usage:
 *   node scripts/release-notes.mjs            # version from $GITHUB_REF_NAME (v-prefixed)
 *   node scripts/release-notes.mjs 0.1.41     # explicit
 *
 * Exits non-zero when the section is missing, so a release fails rather than
 * shipping an empty description.
 */
import { readFileSync } from 'node:fs'

const requested = process.argv[2] ?? process.env.GITHUB_REF_NAME?.replace(/^v/, '')
if (requested === undefined || requested === '') {
  console.error('usage: node scripts/release-notes.mjs <version>  (or set GITHUB_REF_NAME)')
  process.exit(1)
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requested)) {
  console.error(`release-notes: "${requested}" is not a version number`)
  process.exit(1)
}

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const escaped = requested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// The lookahead means "the next version heading, or the end of input".
// It used to end in `\Z`, which JavaScript's RegExp does not define: in a
// non-unicode pattern an unrecognized escape is the literal character, so the
// alternative was really `Z` and the section had to be followed by a capital Z.
// Any section that is last in the file — the normal case for the version being
// released — matched only if a `Z` happened to follow it.
const section = new RegExp(`^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, 'm').exec(changelog)

if (section === null) {
  console.error(`release-notes: CHANGELOG.md has no "## [${requested}]" section — refusing to emit an empty description`)
  process.exit(1)
}

const body = section[1].trim()
if (body === '') {
  console.error(`release-notes: the "## [${requested}]" section is empty`)
  process.exit(1)
}

process.stdout.write(`## ${requested}\n\n${body}\n`)
