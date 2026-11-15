/**
 * Resolving the feed the installed desktop app would consult.
 *
 * The address is sealed into `app-update.yml` at install time and can be
 * overridden by the channel the user picks in the desktop settings. Reading
 * both is what keeps the download panel pointed at the same feed the app's own
 * updater follows — a hard-coded `win-x64/nightly.yml` only happens to be right
 * for one platform and one channel.
 */
import { describe, expect, it } from 'vitest'
import { DESKTOP_FEED_FALLBACK_URL, resolveDesktopFeedSource } from '../src/desktop/source.ts'

/** A `resources` directory holding one `app-update.yml`. */
function installed(options: {
  readonly root?: string
  readonly channel?: string
  readonly settings?: string
} = {}) {
  const root = options.root ?? 'https://download.deepseek.com/dsh-desk/feeds/win-x64/'
  const channel = options.channel ?? 'nightly'
  const updateYml = `provider: generic\nurl: ${root}\nchannel: ${channel}\nupdaterCacheDirName: '@deepseek-aidsh-desktop-updater'\n`
  const files = new Map<string, string>([
    ['C:/app/resources/app-update.yml', updateYml],
  ])
  if (options.settings !== undefined) {
    files.set('C:/Users/me/AppData/Roaming/@deepseek-ai/dsh-desktop/desktop/settings.json', options.settings)
  }
  return {
    env: { DSH_INSTALL_DIR: 'C:/app/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh', APPDATA: 'C:/Users/me/AppData/Roaming' },
    execPath: 'C:/app/DeepSeek Harness.exe',
    readText: (path: string): string | undefined => files.get(path.replaceAll('\\', '/')),
  }
}

describe('resolveDesktopFeedSource', () => {
  it('reads the address the installer sealed in', () => {
    expect(resolveDesktopFeedSource(installed())).toEqual({
      url: 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml',
      platform: 'win-x64',
      channel: 'nightly',
      origin: 'app-update.yml',
    })
  })

  it('follows the channel the user selected over the sealed one', () => {
    // The shell applies the user's choice after the packaged channel, so the
    // panel must do the same or it reports a feed the app will never read.
    const source = resolveDesktopFeedSource(installed({
      channel: 'nightly',
      settings: JSON.stringify({ updates: { channel: 'stable' } }),
    }))
    expect(source).toMatchObject({
      url: 'https://download.deepseek.com/dsh-desk/feeds/win-x64/stable.yml',
      channel: 'stable',
    })
  })

  it('ignores a settings document it cannot understand', () => {
    for (const settings of ['not json', '{}', '{"updates":{}}', '{"updates":{"channel":7}}']) {
      expect(resolveDesktopFeedSource(installed({ settings })).channel).toBe('nightly')
    }
  })

  it('accepts a feed root without a trailing slash', () => {
    const source = resolveDesktopFeedSource(installed({ root: 'https://example.test/feeds/darwin-arm64' }))
    expect(source.url).toBe('https://example.test/feeds/darwin-arm64/nightly.yml')
    expect(source.platform).toBe('darwin-arm64')
  })

  it('derives the platform from the feed root rather than assuming one', () => {
    const source = resolveDesktopFeedSource(installed({ root: 'https://example.test/feeds/linux-x64/' }))
    expect(source.platform).toBe('linux-x64')
  })

  it('falls back to the shipped address when nothing is installed', () => {
    // A CLI profile has no desktop configuration at all; the panel still has to
    // render something rather than disappear.
    const source = resolveDesktopFeedSource({
      env: {},
      execPath: '/usr/local/bin/node',
      readText: () => undefined,
    })
    expect(source).toEqual({
      url: DESKTOP_FEED_FALLBACK_URL,
      platform: 'win-x64',
      channel: 'nightly',
      origin: 'fallback',
    })
  })

  it('finds resources beside the executable when the install directory is absent', () => {
    const files = new Map<string, string>([
      ['/opt/dsh/resources/app-update.yml', 'url: https://example.test/feeds/linux-x64/\nchannel: stable\n'],
    ])
    const source = resolveDesktopFeedSource({
      env: {},
      execPath: '/opt/dsh/bin/dsh',
      readText: (path: string): string | undefined => files.get(path.replaceAll(String.fromCharCode(92), "/")),
    })
    expect(source).toMatchObject({ url: 'https://example.test/feeds/linux-x64/stable.yml', platform: 'linux-x64' })
  })

  it('ignores an app-update.yml without a url', () => {
    const source = resolveDesktopFeedSource({
      env: { DSH_INSTALL_DIR: 'C:/app/resources/app.asar/dsh/x' },
      execPath: 'C:/app/DeepSeek Harness.exe',
      readText: (path: string) => (path.endsWith('app-update.yml') ? 'provider: generic\nchannel: nightly\n' : undefined),
    })
    expect(source.origin).toBe('fallback')
  })

  it('pins a channel over both the sealed one and the desktop setting', () => {
    // The panel's selector wins over everything, but it only changes which
    // feed the panel reads — never the app's own update channel.
    const source = resolveDesktopFeedSource({
      ...installed({ channel: 'nightly', settings: JSON.stringify({ updates: { channel: 'stable' } }) }),
      channel: 'nightly',
    })
    expect(source).toMatchObject({ channel: 'nightly', url: 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml' })
  })

  it('treats auto as "follow the app" rather than as a channel name', () => {
    const source = resolveDesktopFeedSource({ ...installed(), channel: 'auto' })
    expect(source.channel).toBe('nightly')
    expect(source.url).toBe('https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml')
  })

  it('applies a pinned channel even when nothing is installed', () => {
    const source = resolveDesktopFeedSource({
      env: {},
      execPath: '/usr/local/bin/node',
      readText: () => undefined,
      channel: 'stable',
    })
    // The fallback root still names win-x64; only the channel is pinned.
    expect(source.channel).toBe('stable')
    expect(source.url).toBe('https://download.deepseek.com/dsh-desk/feeds/win-x64/stable.yml')
  })
})
