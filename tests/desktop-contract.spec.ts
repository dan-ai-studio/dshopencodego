/**
 * Desktop download readings on the update Remote.
 *
 * The feed's parsing and caching live in `desktop/feed.ts` (covered by
 * `desktop-feed.spec.ts`); what this file pins is the wire contract and the
 * service that exposes it. The two desktop methods ride the `opencodeGoUpdate`
 * namespace on purpose — a separate namespace would have to be listed in both
 * the Host contribution and the Client's `$mount`, and getting that wrong once
 * (0.1.92) removed the whole settings section.
 */
import { describe, expect, it, vi } from 'vitest'
import { parseDesktopReading, updateRemote } from '../src/update/contract.ts'
import { OpencodeGoUpdateService } from '../src/update/service.ts'

/** A Cordis context stub: the service base only registers through `reflect`. */
const CTX = { reflect: { provide: () => {} } } as never

const READING = {
  checked: true,
  checkedAt: 1_000,
  platform: 'win-x64',
  channel: 'nightly',
  release: {
    version: '0.2.2-rc.3',
    url: 'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.3-win-x64.exe',
    size: 299595752,
    sha512: 'GiJf8kx+C7eoiZ0xQSYBcTyh5xmXQl+vh63U6uSm963McK1AkMgB8PydzuekWdUY7hyURvhVMHANM4pn+tCKzQ==',
    stagingPercentage: 30,
    releaseDate: '2026-11-13T07:31:42.937Z',
  },
}

describe('parseDesktopReading', () => {
  it('accepts a reading with and without a release', () => {
    expect(parseDesktopReading(READING)).toEqual(READING)
    expect(parseDesktopReading({ checked: false, checkedAt: 7, platform: 'win-x64', channel: 'nightly' }))
      .toEqual({ checked: false, checkedAt: 7, platform: 'win-x64', channel: 'nightly' })
  })

  it('drops optional release fields that are the wrong type', () => {
    expect(parseDesktopReading({
      ...READING,
      release: { version: '1.0.0', url: 'https://example.test/a.exe', size: 'big', sha512: 7, stagingPercentage: 'x', releaseDate: null },
    })).toEqual({
      checked: true,
      checkedAt: 1_000,
      platform: 'win-x64',
      channel: 'nightly',
      release: { version: '1.0.0', url: 'https://example.test/a.exe' },
    })
  })

  it('rejects malformed readings', () => {
    // A reading that omits `checked` cannot be trusted to distinguish an
    // unanswered feed from a confirmed empty channel.
    const bad = [
      null, {}, { checked: true, checkedAt: 1, platform: 'win-x64' },
      { checked: 'yes', checkedAt: 1, platform: 'win-x64', channel: 'nightly' },
      { checked: true, checkedAt: Number.NaN, platform: 'win-x64', channel: 'nightly' },
      { checked: true, checkedAt: 1, platform: 7, channel: 'nightly' },
      { checked: true, checkedAt: 1, platform: 'win-x64', channel: 'nightly', release: {} },
      { checked: true, checkedAt: 1, platform: 'win-x64', channel: 'nightly', release: { version: '', url: 'https://a' } },
      { checked: true, checkedAt: 1, platform: 'win-x64', channel: 'nightly', release: { version: '1.0.0', url: '' } },
    ]
    for (const value of bad) expect(() => parseDesktopReading(value)).toThrow(/invalid desktop (reading|release)/)
  })
})

describe('updateRemote descriptors', () => {
  it('declares the update and desktop pairs under one namespace', () => {
    expect(updateRemote.descriptors.map(descriptor => descriptor.id)).toEqual([
      '@dan-ai-studio/dshopencodego#opencodeGoUpdate/readUpdate',
      '@dan-ai-studio/dshopencodego#opencodeGoUpdate/refreshUpdate',
      '@dan-ai-studio/dshopencodego#opencodeGoUpdate/readDesktop',
      '@dan-ai-studio/dshopencodego#opencodeGoUpdate/refreshDesktop',
    ])
    // One namespace, so the Host contribution and the Client's `$mount` cannot
    // disagree about which namespaces exist.
    expect(new Set(updateRemote.descriptors.map(descriptor => descriptor.namespace))).toEqual(
      new Set(['opencodeGoUpdate']),
    )
  })

  it('declares no business parameters, so no method takes a force flag', () => {
    for (const descriptor of updateRemote.descriptors) {
      expect(descriptor.parameters).toEqual([])
    }
  })

  it('carries the desktop codec, which refuses a malformed payload', () => {
    const descriptor = updateRemote.descriptors.find(entry => entry.method === 'readDesktop')
    const result = descriptor?.result as unknown as { schema: { parse: (value: unknown) => unknown } }
    expect(result.schema.parse(READING)).toEqual(READING)
    expect(() => result.schema.parse({})).toThrow(/invalid desktop reading/)
  })
})

describe('OpencodeGoUpdateService desktop methods', () => {
  it('answers read and refresh from one cached feed reader', async () => {
    // The reader captures `fetch` when the service is constructed, so the stub
    // has to be in place first — a stub installed afterwards is ignored.
    const fetchMock = vi.fn(async () => new Response('version: 0.2.2-rc.3\npath: https://example.test/a.exe\n', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const service = new OpencodeGoUpdateService(CTX, { currentVersion: '0.1.97' })
    const first = await service.readDesktop()
    expect(first).toMatchObject({ checked: true, release: { version: '0.2.2-rc.3' } })
    // A cached read costs no second round trip; the forced refresh does.
    await service.readDesktop()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await service.refreshDesktop()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails silent when the feed is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const service = new OpencodeGoUpdateService(CTX, { currentVersion: '0.1.97' })
    await expect(service.readDesktop()).resolves.toMatchObject({ checked: false })
  })
})
