/**
 * Seed builder entry, bundled and run by `scripts/seed-catalog.mjs`.
 *
 * Not part of any tsconfig and never shipped: esbuild compiles it on the fly
 * for one seed refresh. It reuses the real catalog build, so the seed can
 * never drift out of the file shape the runtime validates.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpencodeGoCatalog } from '../src/catalog/index.ts'
import { DEFAULT_BASE_URL } from '../src/catalog/constants.ts'
import { parseSnapshotFile } from '../src/catalog/snapshot-cache.ts'
import type { ModelDefaults } from '../src/catalog/metadata.ts'

/** Route defaults, kept in step with `OpencodeGoAdapter.catalogOf`. */
const ROUTE_DEFAULTS: ModelDefaults = {
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  input: ['text'],
}

/**
 * Build a live catalog and write it as the bundled seed.
 * @param outPath - where to write `seed.snapshot.json`.
 */
export async function main(outPath: string): Promise<void> {
  const cacheDir = mkdtempSync(join(tmpdir(), 'dshopencodego-seed-'))
  const catalog = new OpencodeGoCatalog({
    baseURL: DEFAULT_BASE_URL,
    refreshMs: 60_000,
    defaults: ROUTE_DEFAULTS,
    overrides: {},
    cacheDir,
  })
  const snapshot = await catalog.snapshot(true)
  await catalog.settled()
  const raw = JSON.parse(readFileSync(join(cacheDir, 'catalog-snapshot.json'), 'utf8')) as Record<string, unknown>
  // Allowances are deliberately not seeded: they change without notice, and
  // a stale allowance misleads where a missing one simply falls back to the
  // frozen seed. The file keeps facts and protocols only.
  delete raw.quotas
  const out = { ...raw, baseURL: DEFAULT_BASE_URL }
  const parsed = parseSnapshotFile(out)
  if (parsed === undefined || parsed.facts.size === 0) {
    throw new Error('seed build produced no usable facts; refusing to write an empty seed')
  }
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`)
  console.log(`seed: ${parsed.facts.size} models from ${DEFAULT_BASE_URL} -> ${outPath}`)
  for (const degradation of snapshot.degradations ?? []) {
    console.warn(`seed: degraded source ${degradation.source}: ${degradation.reason}`)
  }
}
