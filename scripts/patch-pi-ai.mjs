/**
 * Port of DSH's `patches/@earendil-works__pi-ai@0.87.1.patch` for npm installs.
 *
 * Upstream re-parses the whole accumulated tool-call argument JSON on every
 * stream delta (`O(n^2)` on multi-megabyte arguments and stalls the event
 * loop). DSH removes those per-delta parses via pnpm `patchedDependencies`;
 * this package is npm-installed, so the same removals are applied here,
 * idempotently, to the installed copy.
 *
 * Only the per-delta occurrences are removed — each is anchored on its
 * distinctive preceding accumulation line, exactly matching the upstream
 * hunks. The final parses (toolcall_end / done handlers, which strip the
 * scratch buffers so replay carries parsed arguments) are kept.
 *
 * The adapter only reads delta strings plus the finalized arguments (see
 * `src/conversion/stream.ts`), so dropping the intermediate `arguments`
 * assignments changes no wire behaviour — until `toolcall_end` the partials
 * stay `{}`, exactly like the patched DSH runtime.
 *
 * Best-effort: a missing tree or a newer pi-ai that already dropped the lines
 * only warns; it never fails the install.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** Locate the installed pi-ai root without crossing its `exports` map. */
function findPiRoot() {
  try {
    const main = require.resolve('@earendil-works/pi-ai')
    if (basenameIsDist(dirname(main))) return dirname(dirname(main))
  } catch {
    // Fall through to the layout probe below.
  }
  const probe = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@earendil-works', 'pi-ai')
  return existsSync(`${probe}/package.json`) ? probe : undefined
}

/** True when `dir` is the package's `dist` directory. */
function basenameIsDist(dir) {
  return dir.endsWith('/dist') || dir.endsWith('\\dist')
}

/**
 * One hunk: `before` (kept) immediately followed by `removed`.
 * Whitespace between them is flexible; nothing else is touched.
 */
const HUNKS = [
  ['dist/api/anthropic-messages.js',
    'block.partialJson += event.delta.partial_json;',
    'block.arguments = parseStreamingJson(block.partialJson);'],
  ['dist/api/bedrock-converse-stream.js',
    'block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");',
    'block.arguments = parseStreamingJson(block.partialJson);'],
  ['dist/api/mistral-conversations.js',
    'block.partialArgs = (block.partialArgs || "") + argsDelta;',
    'block.arguments = parseStreamingJson(block.partialArgs);'],
  ['dist/api/openai-completions.js',
    'block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;',
    'block.arguments = parseStreamingJson(block.partialArgs);'],
  ['dist/api/openai-responses-shared.js',
    'slot.block.partialJson += event.delta;',
    'slot.block.arguments = parseStreamingJson(slot.block.partialJson);'],
]

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const piRoot = findPiRoot()
if (piRoot === undefined) {
  console.warn('[dshopencodego] patch-pi-ai: pi-ai not installed, skipping')
  process.exit(0)
}

let version = 'unknown'
try {
  version = JSON.parse(readFileSync(`${piRoot}/package.json`, 'utf8')).version ?? 'unknown'
} catch (error) {
  console.warn(`[dshopencodego] patch-pi-ai: cannot read pi-ai version, skipping (${String(error)})`)
  process.exit(0)
}
if (version !== '0.87.1') {
  console.warn(`[dshopencodego] patch-pi-ai: pi-ai ${version} is not 0.87.1, skipping (re-check upstream pi#9265)`)
  process.exit(0)
}

let patched = 0
let files = 0
for (const [rel, before, removed] of HUNKS) {
  const path = `${piRoot}/${rel}`
  if (!existsSync(path)) continue
  files += 1
  const pattern = new RegExp(`(${escapeRegExp(before)}\\n)(\\s*${escapeRegExp(removed)}\\n)`)
  const text = readFileSync(path, 'utf8')
  if (!pattern.test(text)) continue
  writeFileSync(path, text.replace(pattern, '$1'))
  patched += 1
}

// pi-messages.js spans the delta assignment over two lines.
{
  const path = `${piRoot}/dist/api/pi-messages.js`
  if (existsSync(path)) {
    files += 1
    const pattern = /partial\.content\[event\.contentIndex\]\.arguments =\s*\n?\s*parseStreamingJson\(json\);\n/
    const text = readFileSync(path, 'utf8')
    if (pattern.test(text)) {
      writeFileSync(path, text.replace(pattern, ''))
      patched += 1
    }
  }
}
console.log(`[dshopencodego] patch-pi-ai: ${patched} hunks applied across ${files} files (idempotent)`)
