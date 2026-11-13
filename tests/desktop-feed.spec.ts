/**
 * The desktop release feed: the folded-scalar document it serves, and the
 * cached reading the settings page asks for.
 *
 * The feed writes its two most important fields — the installer address and
 * its digest — as `key: >-` followed by an indented line, so a reader that
 * only understood `key: value` would report both as empty. That shape is the
 * first thing tested here.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_CACHE_MS,
  DESKTOP_FEED_CHANNEL,
  DESKTOP_FEED_PLATFORM,
  DESKTOP_FEED_URL,
  createDesktopFeedReader,
  parseDesktopFeed,
} from '../src/desktop/feed.ts'

/** The document `win-x64/nightly.yml` actually served, verbatim. */
const SERVED = `version: 0.2.2-rc.3
files:
  - url: >-
      https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.3-win-x64.exe
    size: 299595752
    sha512: >-
      GiJf8kx+C7eoiZ0xQSYBcTyh5xmXQl+vh63U6uSm963McK1AkMgB8PydzuekWdUY7hyURvhVMHANM4pn+tCKzQ==
path: >-
  https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.3-win-x64.exe
sha512: >-
  GiJf8kx+C7eoiZ0xQSYBcTyh5xmXQl+vh63U6uSm963McK1AkMgB8PydzuekWdUY7hyURvhVMHANM4pn+tCKzQ==
stagingPercentage: 30
releaseDate: '2026-11-13T07:31:42.937Z'
`

describe('feed constants', () => {
  it('addresses the platform and channel the download host publishes', () => {
    expect(DESKTOP_FEED_PLATFORM).toBe('win-x64')
    expect(DESKTOP_FEED_CHANNEL).toBe('nightly')
    expect(DESKTOP_FEED_URL).toBe('https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml')
  })
})

describe('parseDesktopFeed', () => {
  it('reads every field out of the document the host serves', () => {
    expect(parseDesktopFeed(SERVED)).toEqual({
      version: '0.2.2-rc.3',
      url: 'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.3-win-x64.exe',
      size: 299595752,
      sha512: 'GiJf8kx+C7eoiZ0xQSYBcTyh5xmXQl+vh63U6uSm963McK1AkMgB8PydzuekWdUY7hyURvhVMHANM4pn+tCKzQ==',
      stagingPercentage: 30,
      releaseDate: '2026-11-13T07:31:42.937Z',
    })
  })

  it('joins a folded block scalar onto its key instead of reading it as empty', () => {
    const release = parseDesktopFeed(SERVED)
    expect(release?.url).toContain('deepseek-harness-0.2.2-rc.3-win-x64.exe')
    expect(release?.sha512).toHaveLength(88)
  })

  it('falls back to the files list when the top level names no path', () => {
    const release = parseDesktopFeed(`version: 0.2.2-rc.4
files:
  - url: https://example.test/a.exe
    size: 12
    sha512: abc
`)
    expect(release).toEqual({
      version: '0.2.2-rc.4',
      url: 'https://example.test/a.exe',
      size: 12,
      sha512: 'abc',
    })
  })

  it('prefers the top-level path over the files list', () => {
    const release = parseDesktopFeed(`version: 0.2.2-rc.5
files:
  - url: https://example.test/list.exe
path: https://example.test/top.exe
`)
    expect(release?.url).toBe('https://example.test/top.exe')
  })

  it('strips one pair of quotes off a scalar', () => {
    const release = parseDesktopFeed(`version: "0.2.2-rc.6"
path: 'https://example.test/q.exe'
releaseDate: '2026-01-02T03:04:05.000Z'
`)
    expect(release?.version).toBe('0.2.2-rc.6')
    expect(release?.url).toBe('https://example.test/q.exe')
    expect(release?.releaseDate).toBe('2026-01-02T03:04:05.000Z')
  })

  it('ignores comments and blank lines', () => {
    const release = parseDesktopFeed(`# a comment
version: 0.2.2-rc.7

# another
path: https://example.test/c.exe
`)
    expect(release).toEqual({ version: '0.2.2-rc.7', url: 'https://example.test/c.exe' })
  })

  it('reads as undefined when the document names no release', () => {
    expect(parseDesktopFeed('')).toBeUndefined()
    expect(parseDesktopFeed('version: 0.2.2-rc.8\n')).toBeUndefined()
    expect(parseDesktopFeed('path: https://example.test/no-version.exe\n')).toBeUndefined()
    expect(parseDesktopFeed('<html>not a feed</html>')).toBeUndefined()
  })

  it('drops fields it cannot read rather than passing them on', () => {
    const release = parseDesktopFeed(`version: 0.2.2-rc.9
path: https://example.test/x.exe
size: not-a-number
stagingPercentage: half
`)
    expect(release).toEqual({ version: '0.2.2-rc.9', url: 'https://example.test/x.exe' })
  })
})

/** A fetch that answers one document and counts its calls. */
function fetchFeed(body: string, status = 200): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    return new Response(body, { status })
  }) as never
  return { fetchImpl, calls: () => calls }
}

describe('createDesktopFeedReader', () => {
  it('answers the published installer and marks the reading checked', async () => {
    const { fetchImpl } = fetchFeed(SERVED)
    const reader = createDesktopFeedReader({ fetchImpl, now: () => 1_000 })
    const reading = await reader.read()
    expect(reading).toMatchObject({
      checked: true,
      checkedAt: 1_000,
      platform: 'win-x64',
      channel: 'nightly',
      release: { version: '0.2.2-rc.3' },
    })
  })

  it('caches a reading for the cache window and revalidates on force', async () => {
    const { fetchImpl, calls } = fetchFeed(SERVED)
    let clock = 1_000
    const reader = createDesktopFeedReader({ fetchImpl, now: () => clock })
    await reader.read()
    clock += DESKTOP_CACHE_MS - 1
    await reader.read()
    expect(calls()).toBe(1)
    await reader.read(true)
    expect(calls()).toBe(2)
  })

  it('shares one in-flight lookup between concurrent callers', async () => {
    const { fetchImpl, calls } = fetchFeed(SERVED)
    const reader = createDesktopFeedReader({ fetchImpl, now: () => 1_000 })
    await Promise.all([reader.read(), reader.read(), reader.read()])
    expect(calls()).toBe(1)
  })

  it('reports an unreachable host as unchecked rather than as an empty channel', async () => {
    const fetchImpl = (async () => { throw new Error('offline') }) as never
    const reader = createDesktopFeedReader({ fetchImpl, now: () => 7 })
    const reading = await reader.read()
    expect(reading).toEqual({
      checked: false,
      checkedAt: 7,
      platform: 'win-x64',
      channel: 'nightly',
    })
  })

  it('treats a non-2xx answer and a document without a release as unchecked', async () => {
    for (const [body, status] of [['gone', 404], ['version: 1.0.0\n', 200]] as const) {
      const { fetchImpl } = fetchFeed(body, status)
      const reader = createDesktopFeedReader({ fetchImpl, now: () => 1 })
      expect((await reader.read()).checked).toBe(false)
    }
  })

  it('retries a failed lookup once the cache window has passed', async () => {
    let fail = true
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (fail) throw new Error('offline')
      return new Response(SERVED, { status: 200 })
    }) as never
    let clock = 0
    const reader = createDesktopFeedReader({ fetchImpl, now: () => clock })
    expect((await reader.read()).checked).toBe(false)
    fail = false
    clock += DESKTOP_CACHE_MS
    expect((await reader.read()).checked).toBe(true)
    expect(calls).toBe(2)
  })

  it('never rejects, whatever the host answers', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500 }) as Response) as never
    const reader = createDesktopFeedReader({ fetchImpl, now: () => 0 })
    await expect(reader.read()).resolves.toMatchObject({ checked: false })
  })

  it('asks the address the platform and channel resolve to', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(url)
      return new Response(SERVED, { status: 200 })
    }) as never
    await createDesktopFeedReader({ fetchImpl, now: () => 0 }).read()
    expect(seen).toEqual([DESKTOP_FEED_URL])
  })
})

describe('desktop feed module surface', () => {
  it('exposes no download or install path', async () => {
    // The whole point of the module is that it only reads. A future addition
    // that downloads the installer must not slip in unnoticed.
    const surface = await import('../src/desktop/feed.ts')
    expect(Object.keys(surface).sort()).toEqual([
      'DESKTOP_CACHE_MS',
      'DESKTOP_FEED_CHANNEL',
      'DESKTOP_FEED_PLATFORM',
      'DESKTOP_FEED_URL',
      'DESKTOP_TIMEOUT_MS',
      'createDesktopFeedReader',
      'parseDesktopFeed',
    ])
  })
})

describe('desktop feed logging', () => {
  it('stays silent: the reader reports failures as data, not as console noise', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = (async () => { throw new Error('offline') }) as never
    await createDesktopFeedReader({ fetchImpl, now: () => 0 }).read()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    warn.mockRestore()
    error.mockRestore()
  })
})
