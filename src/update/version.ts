/**
 * The running build's own version.
 *
 * `scripts/build.mjs` replaces `__DSHOPENCODEGO_VERSION__` with the package
 * version at bundle time, so the Host knows what it is without reading its
 * own files back from disk. Outside the bundle (tests, source runs) the
 * constant is absent and the value reads as a development placeholder; the
 * update check treats an unparsable current version as "no update known"
 * rather than erroring.
 *
 * @module @dan-ai-studio/dshopencodego/update/version
 */

declare const __DSHOPENCODEGO_VERSION__: string | undefined

/** Version of this build, or a placeholder outside the bundle. */
export const PLUGIN_VERSION: string = typeof __DSHOPENCODEGO_VERSION__ === 'string'
  ? __DSHOPENCODEGO_VERSION__
  : '0.0.0-dev'
