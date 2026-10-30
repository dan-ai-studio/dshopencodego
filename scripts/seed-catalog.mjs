/**
 * Refresh the bundled catalog seed (`src/catalog/seed.snapshot.json`).
 *
 * Usage: `npm run seed [-- <output path>]`
 *
 * The seed is what a fresh install serves while its first background refresh
 * is still running: without it, the first request after a restart waits on
 * the gateway listing, the models.dev document (megabytes), and the
 * provider's documentation page. With it, that request answers at once.
 *
 * Everything the seed contains is public: the listing, the metadata, and the
 * documentation are all fetched without credentials, and no API key,
 * session, or usage figure is ever written into the file. Run it before a
 * release so the bundled data stays young; the runtime treats the seed
 * exactly like a stale disk cache (served at once, refreshed behind it),
 * so an older seed costs one background refresh, never a wrong answer.
 */
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const entry = join(packageRoot, 'scripts', 'seed-catalog.entry.ts')
const outPath = resolve(packageRoot, process.argv[2] ?? join('src', 'catalog', 'seed.snapshot.json'))

// The bundle lives inside the package (not the temp dir) so bare imports
// keep resolving through the package's own node_modules at runtime. Only
// this repo's files are bundled; third-party packages stay external —
// which also keeps runtime `require('../package.json')` version sniffs
// inside their own packages working, instead of dangling off a bundle.
const workDir = join(packageRoot, 'scripts', '.seed-build')
try {
  const outfile = join(workDir, 'seed-build.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'warning',
  })
  const { main } = await import(pathToFileURL(outfile).href)
  await main(outPath)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
