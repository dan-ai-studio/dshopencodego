/**
 * Build the Host ESM entry and the DSH browser module the Web UI loads.
 *
 * The Host half is one ESM bundle. Only the Harness's own packages stay
 * external (it supplies them at runtime); `pi-ai` and `schemastery` are
 * **compiled in**, which keeps the plugin free of runtime dependencies and
 * keeps Node's CommonJS interop out of the pi-ai load path. The Client half is
 * a CommonJS factory registered through `window.__ModuleLoader__`, with React
 * and the DSH Client packages left to the page, and CSS Modules compiled to a
 * scoped `<style>` tag at load.
 *
 * Every path is anchored to this file (see `packageRoot`), so `npm run build`
 * and `node D:\...\scripts\build.mjs` from any directory do the same thing.
 */
import { build } from 'esbuild'
import { transform } from 'lightningcss'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
// `require.resolve('typescript/bin/tsc')` throws ERR_PACKAGE_PATH_NOT_EXPORTED:
// TypeScript 7's `exports` map declares only `.` and `./package.json`. Go
// through the manifest's own `bin` entry instead — the same mapping npm uses
// to create the `tsc` shim.
const typescriptDir = dirname(require.resolve('typescript/package.json'))
const typescriptBin = JSON.parse(await readFile(join(typescriptDir, 'package.json'), 'utf8')).bin
const tsc = join(typescriptDir, typescriptBin.tsc)

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const libDir = join(packageRoot, 'lib')
// Absolute and package-rooted: a bare `rm('lib')` was relative to the caller's
// cwd, so running this script from another directory deleted that directory's
// `lib/` instead of this package's.
await rm(libDir, { recursive: true, force: true })
await mkdir(libDir, { recursive: true })

for (const face of ['host', 'client']) {
  execFileSync(process.execPath, [tsc, '-p', join(packageRoot, `tsconfig.${face}.json`)], { stdio: 'inherit', cwd: packageRoot })
}

await build({
  absWorkingDir: packageRoot,
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  // Only the Harness's own packages stay external; everything else is bundled.
  //
  // pi-ai used to be external too, resolved from this package's node_modules at
  // runtime. That made Node, not esbuild, resolve its named import of the
  // CommonJS `partial-json` — and CommonJS named-import resolution enumerates
  // the target's exports, which walks straight into that package's internal
  // circular require and prints
  // `Accessing non-existent property 'Allow' …` once per read. Bundling pi-ai
  // removes the interop step entirely: esbuild compiles the CommonJS graph
  // itself, so there is no runtime enumeration and no warning to filter.
  external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-*'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  define: { __DSHOPENCODEGO_VERSION__: JSON.stringify(pkg.version) },
  // A CommonJS dependency in an ESM bundle needs a `require` to call.
  //
  // `undici` ships no ESM entry, so esbuild compiles its CommonJS graph
  // itself and rewrites its `require('node:assert')` into the `__require`
  // shim — which, in an ESM file, has no `require` to forward to and throws
  // `Dynamic require of "node:assert" is not supported` the first time the
  // module is loaded. The banner gives that shim a real `require` to use:
  // Node's own `createRequire`, which resolves the built-in modules the
  // CommonJS graph asks for.
  banner: {
    js: "import { createRequire as __dshCreateRequire } from 'node:module';"
      + ' const require = __dshCreateRequire(import.meta.url);',
  },
})

/** Identities the DSH Web module table provides to every plugin bundle. */
const clientExternals = [
  'react',
  'react/jsx-runtime',
  // The next two are pre-provisioned rather than currently imported by
  // `src/client/**` (grep: 0 hits for both). They stay declared because the
  // shell has already seeded those identities: declaring them makes a future
  // import resolve to the shell's copy instead of bundling a second one.
  // Dropping `react-dom` would still build and then hand the page two React
  // runtimes (a hooks failure); `ui-primitives` is only correct as the shell's
  // own instance. Both are `PLATFORM_MODULES` members, so the subset assertion
  // below is what keeps them honest.
  'react-dom',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/**
 * The specifiers the DSH Web shell seeds into its frozen module table, copied
 * verbatim from `packages/client/web/src/platform.ts` (`PLATFORM_MODULES`) at
 * **DSH 0.2.1-rc.2** — the version this package's devDependencies pin and the
 * floor of its `dsh` peer range.
 *
 * Copied rather than imported on purpose: the assertion below must fail when
 * DSH renames or drops an identity. A specifier the shell no longer provides is
 * not a build error — esbuild is happy to mark anything external — it is a
 * `require()` failure inside the browser factory, which nothing else in this
 * repo could see. Re-check this list whenever the `dsh` peer range moves.
 */
const DSH_PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const notProvided = clientExternals.filter(specifier => !DSH_PLATFORM_MODULES.includes(specifier))
if (notProvided.length > 0) {
  throw new Error(
    `Unsupported DSH client external(s): ${notProvided.join(', ')}. `
    + 'The Web shell does not provide them (PLATFORM_MODULES @ DSH 0.2.1-rc.2), so the client factory '
    + 'would fail at require() time. Stop importing them, or update DSH_PLATFORM_MODULES together with '
    + 'the `dsh` peer range.',
  )
}

const cssModules = {
  name: 'plugin-css-modules',
  setup(build) {
    build.onResolve({ filter: /\.module\.css$/ }, args => ({
      path: resolve(args.resolveDir, args.path),
      namespace: 'plugin-css',
    }))
    build.onLoad({ filter: /.*/, namespace: 'plugin-css' }, async (args) => {
      const result = transform({
        filename: args.path,
        code: await readFile(args.path),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      // Sorted, because lightningcss hands back its export map in an order
      // that varies between runs. The scoped names themselves are stable (they
      // hash the filename and the local name), so only the emission order moved
      // — and that was enough to make this bundle differ byte for byte on every
      // build, which defeats any attempt to verify a release artifact by hash.
      const classes = Object.fromEntries(Object.entries(result.exports)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => [key,
          [value.name, ...value.composes.map((item) => {
            if (item.type === 'dependency') throw new Error(`External CSS composition is unsupported: ${item.name}`)
            return item.name
          })].join(' '),
        ]))
      const id = `${pkg.name}/${basename(args.path)}`
      return {
        loader: 'js',
        contents: `const id = ${JSON.stringify(id)};`
          + 'if (!document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(id) + \']\')) {'
          + ' const style = document.createElement(\'style\');'
          + ` style.dataset.plugin = ${JSON.stringify(pkg.name)};`
          + ' style.dataset.pluginCss = id;'
          + ` style.textContent = ${JSON.stringify(result.code.toString())};`
          + ' document.head.appendChild(style); }'
          + `export default ${JSON.stringify(classes)};`,
      }
    })
  },
}

const client = await build({
  absWorkingDir: packageRoot,
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: clientExternals,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [cssModules],
  metafile: true,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`
      + ' var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
})

// The other direction of the client contract: every specifier esbuild actually
// left external must be one this file declared. It cannot fail while `external`
// is exactly `clientExternals`, and it is kept as the pin for that assumption
// if `external` ever grows a pattern; the DSH-side rename check is the
// `notProvided` assertion above, which can fail.
for (const output of Object.values(client.metafile.outputs)) {
  for (const item of output.imports) {
    if (item.external && !clientExternals.includes(item.path)) {
      throw new Error(`Unsupported DSH client external: ${item.path}`)
    }
  }
}

await writeFile(join(libDir, 'build-info.json'), `${JSON.stringify({ clientExternals }, null, 2)}\n`)
