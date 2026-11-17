/**
 * Refuse a release whose bundled catalog seed has gone stale.
 *
 * The seed is what a fresh install answers with before its first background
 * refresh, so its age is the age of the first screen a new user sees: a seed
 * from two months ago lists models the gateway has since retired and misses
 * the ones it added. Refreshing it is one command (`npm run seed`), and the
 * only reason it went stale for 18 days was that nothing asked.
 *
 * The threshold is deliberately generous — a month — because the runtime
 * treats the seed as a stale cache and refreshes behind it either way. What
 * this catches is drift, not a missing day.
 *
 * Usage: `node scripts/check-seed.mjs [--max-age <days>]`
 * Exits non-zero with the age and the command that fixes it.
 */
import { readFileSync } from 'node:fs'

/** Days a seed may be old before a release is refused. */
const DEFAULT_MAX_AGE_DAYS = 30

const flag = process.argv.indexOf('--max-age')
const requested = flag >= 0 ? Number(process.argv[flag + 1]) : DEFAULT_MAX_AGE_DAYS
if (!Number.isFinite(requested) || requested <= 0) {
  console.error('check-seed: --max-age needs a positive number of days')
  process.exit(2)
}

const seed = JSON.parse(readFileSync(new URL('../src/catalog/seed.snapshot.json', import.meta.url), 'utf8'))
if (typeof seed.updatedAt !== 'number') {
  console.error('check-seed: the seed carries no `updatedAt`; refusing to guess its age')
  process.exit(1)
}

const ageDays = Math.floor((Date.now() - seed.updatedAt) / 86_400_000)
const models = Object.keys(seed.facts ?? {}).length
const when = new Date(seed.updatedAt).toISOString().slice(0, 10)

if (ageDays > requested) {
  console.error(
    `check-seed: the bundled seed is ${ageDays} days old (${when}, ${models} models), past the ${requested}-day limit.\n`
    + 'Run `npm run seed` and commit the refreshed src/catalog/seed.snapshot.json before releasing.',
  )
  process.exit(1)
}

console.log(`check-seed: the bundled seed is ${ageDays} days old (${when}, ${models} models; limit ${requested})`)
