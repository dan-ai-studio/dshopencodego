/**
 * Self update check: version comparison, the cached registry reading, and the
 * wire codec. The check only reads; applying an update stays a user click on
 * the host's own package manager, so there is no install path to test here.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CHECK_CACHE_MS,
  compareVersions,
  createUpdateChecker,
  isUpdateAvailable,
  parseLatestVersion,
  parseVersion,
} from '../src/update/check.ts'
import { parseUpdateStatus } from '../src/update/contract.ts'
import { OpencodeGoUpdateService } from '../src/update/service.ts'

/** A Cordis context stub: the service base only registers through `reflect`. */
const CTX = { reflect: { provide: () => {} } } as never

function fetchOk(version: string): typeof fetch {
  return (async () => new Response(JSON.stringify({ name: '@dan-ai-studio/dshopencodego', version }))) as never
}

describe('parseVersion', () => {
  it('splits releases, prereleases, and build metadata', () => {
    expect(parseVersion('0.1.23')).toEqual({ core: [0, 1, 23], prerelease: undefined })
    expect(parseVersion('0.2.1-alpha.4')).toEqual({ core: [0, 2, 1], prerelease: ['alpha', '4'] })
    expect(parseVersion('1.0.0+x.build')).toEqual({ core: [1, 0, 0], prerelease: undefined })
  })

  it('rejects non-versions', () => {
    for (const bad of ['', 'latest', '1.2', 'v1.2.3', '1.2.3.4', '  ']) {
      expect(parseVersion(bad)).toBeUndefined()
    }
  })
})

describe('compareVersions', () => {
  it('orders by numeric core', () => {
    expect(compareVersions('0.1.23', '0.1.22')).toBeGreaterThan(0)
    expect(compareVersions('0.1.22', '0.1.23')).toBeLessThan(0)
    expect(compareVersions('0.2.0', '0.1.99')).toBeGreaterThan(0)
    expect(compareVersions('0.1.22', '0.1.22')).toBe(0)
  })

  it('ranks any prerelease below its release', () => {
    expect(compareVersions('0.2.1-alpha.4', '0.2.1')).toBeLessThan(0)
    expect(compareVersions('0.2.1', '0.2.1-alpha.4')).toBeGreaterThan(0)
    expect(compareVersions('0.2.1-alpha.3', '0.2.1-alpha.4')).toBeLessThan(0)
  })

  it('refuses unparsable input instead of guessing', () => {
    expect(() => compareVersions('latest', '0.1.22')).toThrow(/cannot compare/)
  })
})

describe('isUpdateAvailable', () => {
  it('is true only for a newer parsable release', () => {
    expect(isUpdateAvailable('0.1.22', '0.1.23')).toBe(true)
    expect(isUpdateAvailable('0.1.22', '0.1.22')).toBe(false)
    expect(isUpdateAvailable('0.1.23', '0.1.22')).toBe(false)
    expect(isUpdateAvailable('0.1.22', undefined)).toBe(false)
    expect(isUpdateAvailable('0.1.22', 'latest')).toBe(false)
    expect(isUpdateAvailable('dev', '0.1.23')).toBe(false)
  })
})

describe('parseLatestVersion', () => {
  it('reads the version field and rejects the rest', () => {
    expect(parseLatestVersion({ version: '0.1.23' })).toBe('0.1.23')
    expect(parseLatestVersion({ version: 'latest' })).toBeUndefined()
    expect(parseLatestVersion({})).toBeUndefined()
    expect(parseLatestVersion(null)).toBeUndefined()
  })
})

describe('createUpdateChecker', () => {
  it('reports a newer release and caches the answer', async () => {
    const fetchImpl = vi.fn(fetchOk('0.1.23'))
    let at = 1_000
    const checker = createUpdateChecker({ currentVersion: '0.1.22', fetchImpl, now: () => at })
    const first = await checker.check()
    expect(first).toMatchObject({ current: '0.1.22', latest: '0.1.23', available: true, checkedAt: 1_000 })
    const second = await checker.check()
    expect(second).toBe(first)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    at += CHECK_CACHE_MS
    await checker.check()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('shares one lookup between concurrent callers', async () => {
    const fetchImpl = vi.fn(fetchOk('0.1.22'))
    const checker = createUpdateChecker({ currentVersion: '0.1.22', fetchImpl })
    const [left, right] = await Promise.all([checker.check(), checker.check()])
    expect(left.available).toBe(false)
    expect(right).toBe(left)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('answers `checked: false` when the registry is unreachable', async () => {
    // The lookup failing is not the same fact as "already latest", so the
    // status must say the registry never answered.
    const failing = vi.fn(async () => { throw new Error('offline') })
    const checker = createUpdateChecker({ currentVersion: '0.1.22', fetchImpl: failing as never })
    const status = await checker.check()
    expect(status).toMatchObject({ current: '0.1.22', latest: undefined, available: false, checked: false })
  })

  it('answers `checked: false` on a non-200 answer', async () => {
    const notFound = vi.fn(async () => new Response('nope', { status: 404 }))
    const checker = createUpdateChecker({ currentVersion: '0.1.22', fetchImpl: notFound as never })
    const status = await checker.check()
    expect(status).toMatchObject({ available: false, checked: false })
  })
})

describe('parseUpdateStatus', () => {
  it('accepts a reading with and without a latest version', () => {
    expect(parseUpdateStatus({ current: '0.1.22', latest: '0.1.23', available: true, checkedAt: 7, checked: true }))
      .toEqual({ current: '0.1.22', latest: '0.1.23', available: true, checkedAt: 7, checked: true })
    expect(parseUpdateStatus({ current: '0.1.22', available: false, checkedAt: 7, checked: false }))
      .toEqual({ current: '0.1.22', latest: undefined, available: false, checkedAt: 7, checked: false })
  })

  it('rejects malformed readings', () => {
    // A reading that omits `checked` cannot be trusted to distinguish an
    // unanswered lookup from a confirmed up-to-date one.
    const bad = [
      null, {}, { current: '0.1.22' },
      { current: '0.1.22', available: 'yes', checkedAt: 7, checked: true },
      { current: '0.1.22', available: false, checkedAt: 7 },
      { current: '0.1.22', available: false, checkedAt: 7, checked: 'yes' },
    ]
    for (const value of bad) expect(() => parseUpdateStatus(value)).toThrow(/invalid update reading/)
  })
})

describe('OpencodeGoUpdateService', () => {
  it('answers from the registry through the injected build version', async () => {
    vi.stubGlobal('fetch', fetchOk('0.2.0'))
    try {
      const service = new OpencodeGoUpdateService(CTX, { currentVersion: '0.1.22' })
      const status = await service.readUpdate()
      expect(status).toMatchObject({ current: '0.1.22', latest: '0.2.0', available: true })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
