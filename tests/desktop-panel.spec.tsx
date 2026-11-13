// @vitest-environment jsdom
/**
 * The desktop download panel: the automatic read, the explicit check, the
 * copy button, and the three facts the page must not conflate — a published
 * installer, a feed that answered without one, and a feed that did not answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { Section, SectionController } from '../src/client/Section.tsx'
import type { SectionServices } from '../src/client/Section.tsx'
import { en } from '../src/client/locales.ts'
import type { DesktopReading } from '../src/update/contract.ts'

const RELEASE = {
  version: '0.2.2-rc.3',
  url: 'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.3-win-x64.exe',
  size: 299_595_752,
  sha512: 'GiJf8kx+C7eoiZ0xQSYBcTyh5xmXQl+vh63U6uSm963McK1AkMgB8PydzuekWdUY7hyURvhVMHANM4pn+tCKzQ==',
  stagingPercentage: 30,
  releaseDate: '2026-11-13T07:31:42.937Z',
}

const READY: DesktopReading = {
  checked: true,
  checkedAt: 1_000,
  platform: 'win-x64',
  channel: 'nightly',
  release: RELEASE,
}

const ok = <T,>(value: T): never => ({ ok: true, value }) as never

function services(desktop: Partial<Record<'readDesktop' | 'refreshDesktop', () => Promise<never>>> = {}): SectionServices {
  return {
    remote: {
      opencodeGoCatalog: { read: async () => ok(undefined), refresh: async () => ok(undefined) },
      opencodeGoUpdate: {
        readUpdate: async () => ok({ current: '0.1.22', latest: '0.1.22', available: false, checkedAt: 0, checked: true }),
        refreshUpdate: async () => ok({ current: '0.1.22', latest: '0.1.22', available: false, checkedAt: 0, checked: true }),
        // The desktop methods ride this namespace, so they are read here rather
        // than from a namespace of their own.
        readDesktop: desktop.readDesktop ?? (async () => ok(READY)),
        refreshDesktop: desktop.refreshDesktop ?? (async () => ok(READY)),
      },
      credentials: {
        describe: async () => ok({}),
        set: async () => ok(undefined),
        unset: async () => ok(undefined),
      },
    },
    scope: undefined,
  }
}

/** The settings page as the component tree renders it. */
function page(controller: SectionController): React.JSX.Element {
  return <Section controller={controller} t={(key: string) => (en as Record<string, string>)[key] ?? key} />
}

/** Let the constructor's reads settle. */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve()
}

afterEach(() => { cleanup() })

describe('desktop panel controller', () => {
  it('reads the published installer when the page opens', async () => {
    const controller = new SectionController(services())
    await settle()
    expect(controller.snapshot().desktop).toMatchObject({ phase: 'ready', reading: READY })
  })

  it('routes the explicit check through the zero-arg refresh method', async () => {
    // Every descriptor declares no business parameters, and the gateway client
    // rejects a call whose positional arity differs — a `force` flag must
    // never ride `readDesktop`.
    let refreshed = 0
    const tracking = services({
      refreshDesktop: (async (...args: unknown[]) => {
        if (args.length > 0) throw new Error('client api: opencodeGoDesktop/refreshDesktop expected 0 argument(s)')
        refreshed += 1
        return ok(READY)
      }) as never,
    })
    const controller = new SectionController(tracking)
    await settle()
    await controller.checkDesktop(true)
    expect(refreshed).toBe(1)
    expect(controller.snapshot().desktop.phase).toBe('ready')
  })

  it('reports an unanswered feed as a failure, not as an empty channel', async () => {
    // `checked: false` is the Host saying the download host did not answer.
    // Rendering that as "nothing published" would invent a fact.
    const controller = new SectionController(services({
      readDesktop: async () => ok({ checked: false, checkedAt: 1, platform: 'win-x64', channel: 'nightly' }),
    }))
    await settle()
    expect(controller.snapshot().desktop).toMatchObject({ phase: 'failed', message: 'feed-unreachable' })
  })

  it('reports a feed that answered without an installer as empty, with its own copy', async () => {
    const controller = new SectionController(services({
      readDesktop: async () => ok({ checked: true, checkedAt: 1, platform: 'win-x64', channel: 'nightly' }),
    }))
    await settle()
    expect(controller.snapshot().desktop).toMatchObject({ phase: 'empty' })
  })

  it('keeps a failed check visible with its message', async () => {
    const controller = new SectionController(services({
      readDesktop: (async () => { throw new Error('feed exploded') }) as never,
    }))
    await settle()
    expect(controller.snapshot().desktop).toMatchObject({ phase: 'failed' })
    expect(controller.snapshot().desktop.message).toContain('feed exploded')
  })

  it('degrades when the Host offers no desktop methods', async () => {
    // The desktop calls ride `opencodeGoUpdate`, so a Host older than 0.1.97
    // answers the update methods and neither desktop one. The row must say so
    // and the rest of the page must keep rendering.
    const tracking = services()
    Object.defineProperty(tracking.remote, 'opencodeGoUpdate', {
      configurable: true,
      value: {
        readUpdate: async () => ok({ current: '0.1.22', latest: '0.1.22', available: false, checkedAt: 0, checked: true }),
        refreshUpdate: async () => ok({ current: '0.1.22', latest: '0.1.22', available: false, checkedAt: 0, checked: true }),
      },
    })
    const controller = new SectionController(tracking)
    await settle()
    expect(controller.snapshot().desktop).toMatchObject({ phase: 'failed', message: 'remote-not-mounted' })
    render(page(controller))
    expect(screen.getByText(en.desktopFailed)).toBeTruthy()
    // The panels the main injection owns are still there.
    expect(screen.getByText(en.keyTitle)).toBeTruthy()
  })

  it('copies the address and confirms it', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const controller = new SectionController(services())
    await settle()
    await controller.copyDesktopAddress()
    expect(writeText).toHaveBeenCalledWith(RELEASE.url)
    expect(controller.snapshot().desktop.copied).toBe(true)
  })

  it('says to copy by hand when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied') } } })
    const controller = new SectionController(services())
    await settle()
    await controller.copyDesktopAddress()
    expect(controller.snapshot().desktop).toMatchObject({ copied: false, message: 'copy-failed' })
  })

  it('does nothing when there is no address to copy', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const controller = new SectionController(services({
      readDesktop: async () => ok({ checked: true, checkedAt: 1, platform: 'win-x64', channel: 'nightly' }),
    }))
    await settle()
    await controller.copyDesktopAddress()
    expect(writeText).not.toHaveBeenCalled()
    expect(controller.snapshot().desktop.copied).toBe(false)
  })
})

describe('desktop panel rendering', () => {
  it('shows the version, size, publication date, and address', async () => {
    const controller = new SectionController(services())
    await settle()
    render(page(controller))
    await waitFor(() => { expect(screen.getByText(`${en.desktopVersion} ${RELEASE.version}`)).toBeTruthy() })
    expect(screen.getByText(`${en.desktopSize} 286 MB`)).toBeTruthy()
    expect(screen.getByText(RELEASE.url)).toBeTruthy()
    expect(screen.getByText(en.desktopCopy)).toBeTruthy()
    expect(screen.getByText(en.desktopOpen)).toBeTruthy()
    expect(screen.getByText(`SHA-512 ${RELEASE.sha512}`)).toBeTruthy()
  })

  it('shows the checking hint while the first lookup is in flight', async () => {
    // `idle` only exists before the constructor runs: the page asks on open, so
    // the first paint is always `checking` — never a silently blank row.
    let release: (value: never) => void = () => {}
    const pending = new Promise<never>((resolve) => { release = resolve })
    const controller = new SectionController(services({ readDesktop: (() => pending) as never }))
    render(page(controller))
    expect(screen.getByText(en.desktopChecking)).toBeTruthy()
    release(ok(READY))
    await settle()
  })

  it('shows the unreachable hint rather than an empty channel', async () => {
    const controller = new SectionController(services({
      readDesktop: async () => ok({ checked: false, checkedAt: 1, platform: 'win-x64', channel: 'nightly' }),
    }))
    await settle()
    render(page(controller))
    await waitFor(() => { expect(screen.getByText(en.desktopUnavailable)).toBeTruthy() })
    expect(screen.queryByText(en.desktopNoRelease)).toBeNull()
  })

  it('shows the copy-failed hint when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied') } } })
    const controller = new SectionController(services())
    await settle()
    render(page(controller))
    await waitFor(() => { expect(screen.getByText(en.desktopCopy)).toBeTruthy() })
    screen.getByText(en.desktopCopy).click()
    await waitFor(() => { expect(screen.getByText(en.desktopCopyFailed)).toBeTruthy() })
  })
})
