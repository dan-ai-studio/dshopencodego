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
 *
 * The entry is imported directly rather than bundled through esbuild. Node
 * strips the types itself (the `engines` floor is a version that has it on by
 * default), and third-party imports then resolve from the package's own
 * node_modules exactly as they do at runtime — the guarantee the bundle was
 * there to preserve. The esbuild step could not write its output directory on
 * Windows (`mkdir` and Node both could; it failed with `Access is denied`), and
 * a release script that runs on the machine cutting the release is worth more
 * than a bundle nobody reads.
 */
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const entry = join(packageRoot, 'scripts', 'seed-catalog.entry.ts')
const outPath = resolve(packageRoot, process.argv[2] ?? join('src', 'catalog', 'seed.snapshot.json'))

const { main } = await import(pathToFileURL(entry).href)
await main(outPath)
