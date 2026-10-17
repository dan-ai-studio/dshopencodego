/**
 * Self update check: is a newer release of this package published?
 *
 * This module only *reads*: it asks the npm registry for the latest published
 * version and compares it with the running build. It never downloads,
 * installs, or replaces anything — the actual update stays with the host's
 * `pluginManager` (`removeBundle` + `installBundle`), driven by an explicit
 * user click on the settings page. Automatic self-replacement would bypass
 * the host's manifest lock, peer-compatibility checks, build approvals, and
 * HMR lifecycle, so it is deliberately not implemented here.
 *
 * The check runs only when the settings page asks (page open or manual
 * refresh), never on the model-request path. An unreachable registry is
 * reported as exactly that: `UpdateStatus.checked` stays false so the page
 * says the lookup failed instead of presenting it as "already up to date".
 *
 * @module @dan-ai-studio/dshopencodego/update/check
 */

/** This package as addressed on the registry. */
export const PACKAGE_NAME = '@dan-ai-studio/dshopencodego'

/** The GitHub repository, used to link a release's own notes. */
export const REPOSITORY = 'dan-ai-studio/dshopencodego'

/** Document address answering `{ "version": "x.y.z", ... }`. */
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`

/** How long one lookup answers for before the registry is asked again. */
export const CHECK_CACHE_MS = 6 * 60 * 60 * 1000

/** Bound on one registry round trip; expiry fails silent, never throws. */
export const CHECK_TIMEOUT_MS = 10_000

/** What the settings page renders. */
export interface UpdateStatus {
  /** Version of the running build. */
  readonly current: string
  /** Latest published version, when the registry answered. */
  readonly latest: string | undefined
  /** True when the registry answered and `latest` is newer than `current`. */
  readonly available: boolean
  /** Milliseconds since the epoch of the lookup backing this reading. */
  readonly checkedAt: number
  /**
   * Whether the registry actually answered.
   *
   * `false` means the reading is a placeholder for a failed lookup: "no update
   * known", which is not the same fact as "up to date". The page must not
   * render the two alike — reporting an unreachable registry as a current
   * version is a silent lie of exactly the kind that hid the update panel.
   */
  readonly checked: boolean
}

interface ParsedVersion {
  readonly core: readonly number[]
  /** Absent for a release; present (lower precedence) for `1.2.3-tag.4`. */
  readonly prerelease: readonly string[] | undefined
}

/** Split `1.2.3-tag.4+build` into comparable parts; invalid input yields undefined. */
export function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-zA-Z.-]+))?(?:\+[0-9a-zA-Z.-]+)?$/.exec(value.trim())
  if (match === undefined || match === null) return undefined
  const [, major, minor, patch, prerelease] = match as unknown as [string, string, string, string, string | undefined]
  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease === undefined ? undefined : prerelease.split('.'),
  }
}

/**
 * Order one pair of dotted prerelease identifiers, per semver §11.
 *
 * Numeric identifiers compare numerically and alphanumeric ones compare in
 * ASCII order, and a numeric identifier always ranks below an alphanumeric
 * one. A plain string comparison got the numeric case backwards — `rc.10` was
 * read as older than `rc.9` — and this project's own peer ranges carry
 * `rc`/`alpha` prereleases, so that decision reaches real update notices.
 */
function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined
  const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber
  if (leftNumber !== undefined) return -1
  if (rightNumber !== undefined) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Compare two version strings.
 * @returns negative when `left` is older, positive when newer, zero when equal.
 * @throws {Error} when either side is not a version.
 */
export function compareVersions(left: string, right: string): number {
  const ours = parseVersion(left)
  const theirs = parseVersion(right)
  if (ours === undefined || theirs === undefined) throw new Error(`dshopencodego: cannot compare versions "${left}" and "${right}"`)
  for (let index = 0; index < 3; index += 1) {
    const difference = (ours.core[index] ?? 0) - (theirs.core[index] ?? 0)
    if (difference !== 0) return difference
  }
  if (ours.prerelease === undefined && theirs.prerelease === undefined) return 0
  if (ours.prerelease === undefined) return 1
  if (theirs.prerelease === undefined) return -1
  const width = Math.max(ours.prerelease.length, theirs.prerelease.length)
  for (let index = 0; index < width; index += 1) {
    const oursPart = ours.prerelease[index]
    const theirsPart = theirs.prerelease[index]
    if (oursPart === undefined) return -1
    if (theirsPart === undefined) return 1
    const difference = comparePrereleaseIdentifier(oursPart, theirsPart)
    if (difference !== 0) return difference
  }
  return 0
}

/** True when `latest` is a newer release than `current`. Unparsable input is never an update. */
export function isUpdateAvailable(current: string, latest: string | undefined): boolean {
  if (latest === undefined) return false
  try {
    return compareVersions(latest, current) > 0
  } catch {
    return false
  }
}

/** Read the `version` field out of a registry `latest` document. */
export function parseLatestVersion(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const version = (body as Record<string, unknown>)['version']
  return typeof version === 'string' && parseVersion(version) !== undefined ? version : undefined
}

/** Dependencies the check needs, injectable for tests. */
interface UpdateCheckDeps {
  /** Running build's version (build-time constant in production). */
  readonly currentVersion: string
  /** Fetch implementation; defaults to the global one. */
  readonly fetchImpl?: typeof fetch
  /** Clock; defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * Ask the registry for the latest published version, cached per process.
 *
 * Concurrent callers share one in-flight lookup. A lookup that fails for any
 * reason — network, timeout, malformed document — resolves as "no update
 * known" rather than rejecting, so the settings page never breaks because
 * the registry is unreachable.
 */
export function createUpdateChecker(deps: UpdateCheckDeps): {
  check(force?: boolean): Promise<UpdateStatus>
} {
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetchImpl ?? fetch
  let cached: UpdateStatus | undefined
  let inflight: Promise<UpdateStatus> | undefined

  async function lookup(): Promise<UpdateStatus> {
    const checkedAt = now()
    try {
      const response = await fetchImpl(REGISTRY_LATEST_URL, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`registry answered ${response.status}`)
      const latest = parseLatestVersion(await response.json())
      return {
        current: deps.currentVersion,
        latest,
        available: isUpdateAvailable(deps.currentVersion, latest),
        checkedAt,
        checked: true,
      }
    } catch {
      // The lookup failed, so no version is known. `checked: false` keeps that
      // distinguishable from a confirmed "already latest" reading.
      return { current: deps.currentVersion, latest: undefined, available: false, checkedAt, checked: false }
    }
  }

  return {
    check(force = false): Promise<UpdateStatus> {
      if (!force && cached !== undefined && now() - cached.checkedAt < CHECK_CACHE_MS) return Promise.resolve(cached)
      inflight ??= lookup().then((status) => {
        cached = status
        inflight = undefined
        return status
      })
      return inflight
    },
  }
}
