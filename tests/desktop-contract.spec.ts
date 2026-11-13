/**
 * Desktop Remote: the wire codec for a feed reading, and the service that
 * answers from it. The reading is advisory — the address is shown, never
 * downloaded — so there is no install path to test here.
 */
import { describe, expect, it, vi } from 'vitest'
import { parseDesktopReading } from '../src/desktop/contract.ts'
import { OpencodeGoDesktopService } from '../src/desktop/service.ts'
import { desktopRemote } from '../src/desktop/contract.ts'

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

describe('desktopRemote', () => {
  it('declares the read and refresh pair under one namespace', () => {
    expect(desktopRemote.package).toBe('@dan-ai-studio/dshopencodego')
    expect(desktopRemote.descriptors.map(descriptor => descriptor.id)).toEqual([
      '@dan-ai-studio/dshopencodego#opencodeGoDesktop/readDesktop',
      '@dan-ai-studio/dshopencodego#opencodeGoDesktop/refreshDesktop',
    ])
  })

  it('declares no business parameters, so neither method takes a force flag', () => {
    for (const descriptor of desktopRemote.descriptors) {
      expect(descriptor.parameters).toEqual([])
    }
  })

  it('carries the reading codec, which refuses a malformed payload', () => {
    // The contribution declares a strict codec; the union type also allows a
    // `src-json` variant that has no schema, so narrow to the one mounted here.
    const result = desktopRemote.descriptors[0]?.result as unknown as {
      schema: { parse: (value: unknown) => unknown }
    }
    expect(result.schema.parse(READING)).toEqual(READING)
    expect(() => result.schema.parse({})).toThrow(/invalid desktop reading/)
  })
})

describe('OpencodeGoDesktopService', () => {
  it('answers read and refresh from one cached feed reader', async () => {
    // The reader captures `fetch` when the service is constructed, so the stub
    // has to be in place first — a stub installed afterwards would be ignored.
    const fetchMock = vi.fn(async () => new Response('version: 0.2.2-rc.3\npath: https://example.test/a.exe\n', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const service = new OpencodeGoDesktopService(CTX)
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
    const service = new OpencodeGoDesktopService(CTX)
    await expect(service.readDesktop()).resolves.toMatchObject({ checked: false })
  })
})
