/**
 * Where the desktop updater would look for its feed.
 *
 * The address is not a constant of this package. The installed desktop app
 * seals it into `app-update.yml` (`url` + `channel`), and a user may switch the
 * channel in the desktop settings file. Reading both keeps the download panel
 * pointed at the feed the app itself follows, instead of at a path that only
 * happens to be right for one platform and one channel.
 *
 * The host process is not Electron, so `process.resourcesPath` is usually
 * absent. The resources directory is therefore derived from `DSH_INSTALL_DIR`,
 * which the desktop shell passes into the runtime it starts, with the
 * executable's own layout as the fallback.
 *
 * @module @dan-ai-studio/dshopencodego/desktop/source
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The feed used when no installed desktop configuration can be read.
 *
 * This is the address this package shipped before it resolved the real one; it
 * stays as the last resort so the panel keeps working in a CLI profile, where
 * no `app-update.yml` exists at all.
 */
export const DESKTOP_FEED_FALLBACK_URL = 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml'

/** Channel the fallback address names. */
export const DESKTOP_FEED_FALLBACK_CHANNEL = 'nightly'

/** Platform directory the fallback address names. */
export const DESKTOP_FEED_FALLBACK_PLATFORM = 'win-x64'

/** The desktop application's directory name under the user-data root. */
const DESKTOP_APP_DIRECTORY = '@deepseek-ai/dsh-desktop'

/** The feed the running desktop app would consult. */
export interface DesktopFeedSource {
  /** Absolute address of the channel document. */
  readonly url: string
  /** Platform directory the feed lives under, e.g. `win-x64`. */
  readonly platform: string
  /** Channel the app follows, e.g. `nightly`. */
  readonly channel: string
  /** Where the address came from, so a reading can explain itself. */
  readonly origin: 'app-update.yml' | 'fallback'
}

/** Inputs the resolver accepts, injectable for tests. */
export interface DesktopFeedSourceDeps {
  /** Process environment; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Executable path; defaults to `process.execPath`. */
  readonly execPath?: string
  /** File reader; defaults to `readFileSync` returning `undefined` on failure. */
  readonly readText?: (path: string) => string | undefined
}

/** Read one top-level scalar out of the small YAML documents here. */
function scalar(text: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(text)
  const value = match?.[1]?.trim()
  if (value === undefined || value.length === 0) return undefined
  return value.replace(/^['"]|['"]$/g, '')
}

/** Candidate `resources` directories, most specific first. */
function resourcesCandidates(env: NodeJS.ProcessEnv, execPath: string): string[] {
  const candidates: string[] = []
  // The desktop shell points this inside `resources/app.asar/…`.
  const install = env['DSH_INSTALL_DIR']
  if (install !== undefined) {
    const marker = install.indexOf('app.asar')
    if (marker >= 0) candidates.push(install.slice(0, marker).replace(/[\\/]+$/, ''))
  }
  // `resources` sits beside the executable on Windows, one level above it in
  // the usual `<install>/bin/dsh` layout, and inside `Contents` on macOS.
  const beside = dirname(execPath)
  candidates.push(join(beside, 'resources'))
  candidates.push(join(beside, '..', 'resources'))
  candidates.push(join(beside, '..', 'Resources'))
  return candidates
}

/** The desktop settings document, when one is readable. */
function settingsText(env: NodeJS.ProcessEnv, readText: (path: string) => string | undefined): string | undefined {
  const roots = [env['APPDATA'], env['XDG_CONFIG_HOME'], env['HOME'] === undefined ? undefined : join(env['HOME'], '.config')]
  for (const root of roots) {
    if (root === undefined || root.length === 0) continue
    const text = readText(join(root, DESKTOP_APP_DIRECTORY, 'desktop', 'settings.json'))
    if (text !== undefined) return text
  }
  return undefined
}

/** Read `updates.channel` out of a settings document without trusting its shape. */
function userChannel(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return undefined
    const updates = (parsed as Record<string, unknown>)['updates']
    if (updates === null || typeof updates !== 'object') return undefined
    const channel = (updates as Record<string, unknown>)['channel']
    return typeof channel === 'string' && channel.length > 0 ? channel : undefined
  } catch {
    return undefined
  }
}

/** Platform directory named by a feed root such as `…/feeds/win-x64/`. */
function platformOf(feedRoot: string): string | undefined {
  const match = /\/feeds\/([^/]+)\/?$/.exec(feedRoot)
  return match?.[1]
}

/**
 * Resolve the feed the running desktop app would consult.
 *
 * Order: the channel the user selected in the desktop settings wins over the
 * one sealed at install time, because that is the order the shell itself
 * applies. Anything unreadable falls back to the address this package shipped
 * before, so a CLI profile — which has no desktop configuration at all — still
 * renders a working panel.
 *
 * @param deps - environment, executable path, and file reader; all optional.
 * @returns the resolved address together with the platform and channel it names.
 */
export function resolveDesktopFeedSource(deps: DesktopFeedSourceDeps = {}): DesktopFeedSource {
  const env = deps.env ?? process.env
  const execPath = deps.execPath ?? process.execPath
  const readText = deps.readText ?? ((path: string): string | undefined => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  })

  for (const resources of resourcesCandidates(env, execPath)) {
    const text = readText(join(resources, 'app-update.yml'))
    if (text === undefined) continue
    const root = scalar(text, 'url')
    if (root === undefined) continue
    const sealed = scalar(text, 'channel') ?? DESKTOP_FEED_FALLBACK_CHANNEL
    const settings = settingsText(env, readText)
    const channel = settings === undefined ? sealed : userChannel(settings) ?? sealed
    const platform = platformOf(root) ?? DESKTOP_FEED_FALLBACK_PLATFORM
    const base = root.endsWith('/') ? root : `${root}/`
    return { url: `${base}${channel}.yml`, platform, channel, origin: 'app-update.yml' }
  }

  return {
    url: DESKTOP_FEED_FALLBACK_URL,
    platform: DESKTOP_FEED_FALLBACK_PLATFORM,
    channel: DESKTOP_FEED_FALLBACK_CHANNEL,
    origin: 'fallback',
  }
}
