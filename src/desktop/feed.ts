/**
 * The desktop app's release feed.
 *
 * The Harness desktop build publishes one small YAML document per platform and
 * channel under `download.deepseek.com/dsh-desk/feeds/`. Reading it answers a
 * single question — which installer is the newest one published right now, and
 * where does it live? — without asking the user to curl the feed by hand.
 *
 * This module only *reads*. It never downloads, verifies, or runs the
 * installer: the address is surfaced so the page can show, copy, or open it,
 * and the decision to install stays with the human. Verifying the published
 * `sha512` would mean fetching a ~286 MB payload, which is not something a
 * settings-page click may do unasked.
 *
 * Only `win-x64/nightly` exists today — every other platform directory answers
 * 404 — so platform and channel are constants rather than a matrix. A feed that
 * starts publishing elsewhere gets its own constant here.
 *
 * @module @dan-ai-studio/dshopencodego/desktop/feed
 */

/** Platform directory of the published feed. */
export const DESKTOP_FEED_PLATFORM = 'win-x64'

/** Release channel of the published feed. */
export const DESKTOP_FEED_CHANNEL = 'nightly'

/** Document answering the newest installer for that platform and channel. */
export const DESKTOP_FEED_URL =
  `https://download.deepseek.com/dsh-desk/feeds/${DESKTOP_FEED_PLATFORM}/${DESKTOP_FEED_CHANNEL}.yml`

/** How long one reading answers for before the feed is asked again. */
export const DESKTOP_CACHE_MS = 6 * 60 * 60 * 1000

/** Bound on one feed round trip; expiry fails silent, never throws. */
export const DESKTOP_TIMEOUT_MS = 10_000

/** One published installer, as the feed describes it. */
export interface DesktopRelease {
  /** Version the installer carries, e.g. `0.2.2-rc.3`. */
  readonly version: string
  /** Absolute address of the installer. */
  readonly url: string
  /** Size in bytes, when the feed states one. */
  readonly size?: number
  /** Base64 SHA-512 of the payload, when the feed states one. */
  readonly sha512?: string
  /** Share of clients this build is offered to, when the feed states one. */
  readonly stagingPercentage?: number
  /** ISO timestamp of the publication, when the feed states one. */
  readonly releaseDate?: string
}

/** What the settings page renders. */
export interface DesktopReading {
  /**
   * Whether the feed actually answered.
   *
   * `false` means the reading is a placeholder for a failed lookup: "no
   * installer known", which is not the same fact as "nothing published". The
   * page must not render the two alike.
   */
  readonly checked: boolean
  /** Milliseconds since the epoch of the lookup backing this reading. */
  readonly checkedAt: number
  /** Platform the reading describes. */
  readonly platform: string
  /** Channel the reading describes. */
  readonly channel: string
  /** The newest installer, when the feed answered with one. */
  readonly release?: DesktopRelease
}

/** One YAML line after folded block scalars have been joined onto its key. */
interface FeedLine {
  readonly indent: number
  readonly text: string
}

/** A `files:` entry while it is being filled in. */
interface MutableFile {
  url?: string
  size?: number
  sha512?: string
}

/** Leading whitespace of one line, in characters. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** Strip one pair of matching quotes off a scalar. */
function unquote(raw: string): string {
  const value = raw.trim()
  const quoted = value.length >= 2
    && (value.startsWith("'") && value.endsWith("'") || value.startsWith('"') && value.endsWith('"'))
  return quoted ? value.slice(1, -1) : value
}

/** Read an unsigned integer scalar; anything else is absent. */
function toNumber(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Join every folded/literal block scalar onto its own key.
 *
 * The published feed writes long values as `key: >-` followed by an indented
 * line — the installer address and its digest are both spelled that way. A
 * line-oriented reader that only looks at `key: value` would therefore read
 * the two fields that matter most as empty strings, which is exactly the
 * failure mode this function exists to prevent.
 */
function foldBlocks(source: string): FeedLine[] {
  const lines = source.split(/\r?\n/)
  const out: FeedLine[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const open = /^([ \t]*)([A-Za-z][\w-]*):[ \t]*(>-?|>|\|-?|\|)[ \t]*$/.exec(line)
    if (open === null) {
      out.push({ indent: indentOf(line), text: line.trim() })
      continue
    }
    const [, leading = '', key = '', marker = ''] = open
    const indent = leading.length
    const parts: string[] = []
    let cursor = index + 1
    for (; cursor < lines.length; cursor += 1) {
      const next = lines[cursor] ?? ''
      if (next.trim().length === 0) continue
      if (indentOf(next) <= indent) break
      parts.push(next.trim())
    }
    // `|` keeps its line breaks; `>` folds them into spaces.
    out.push({ indent, text: `${key}: ${parts.join(marker.startsWith('|') ? '\n' : ' ')}` })
    index = cursor - 1
  }
  return out
}

/** Record one `key: value` pair on a `files:` entry. */
function assignFile(target: MutableFile, text: string): void {
  const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(text)
  if (match === null) return
  const [, key = '', raw = ''] = match
  const value = unquote(raw)
  if (key === 'url') target.url = value
  else if (key === 'sha512') target.sha512 = value
  else if (key === 'size') {
    const size = toNumber(value)
    if (size !== undefined) target.size = size
  }
}

/**
 * Read the newest installer out of one feed document.
 *
 * The top-level `path`/`sha512` pair is what the updater itself follows, so it
 * wins over the `files:` list; that list is the fallback for a feed that only
 * spells the payload out there. A document without both a version and an
 * address is not a release this page can offer, and reads as `undefined`
 * rather than as a half-filled row.
 *
 * @param source - the feed document as served.
 * @returns the release it describes, or `undefined` when it describes none.
 */
export function parseDesktopFeed(source: string): DesktopRelease | undefined {
  let version: string | undefined
  let path: string | undefined
  let digest: string | undefined
  let stagingPercentage: number | undefined
  let releaseDate: string | undefined
  const files: MutableFile[] = []
  let section: 'top' | 'files' = 'top'

  for (const line of foldBlocks(source)) {
    const text = line.text
    if (text.length === 0 || text.startsWith('#')) continue
    if (line.indent === 0) {
      const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(text)
      if (match === null) continue
      const [, key = '', raw = ''] = match
      section = key === 'files' ? 'files' : 'top'
      if (section === 'files') continue
      const value = unquote(raw)
      if (key === 'version') version = value
      else if (key === 'path') path = value
      else if (key === 'sha512') digest = value
      else if (key === 'releaseDate') releaseDate = value
      else if (key === 'stagingPercentage') stagingPercentage = toNumber(value)
      continue
    }
    if (section !== 'files') continue
    if (text.startsWith('-')) {
      files.push({})
      const rest = text.slice(1).trim()
      const target = files[files.length - 1]
      if (target !== undefined && rest.length > 0) assignFile(target, rest)
      continue
    }
    const target = files[files.length - 1]
    if (target !== undefined) assignFile(target, text)
  }

  const first = files[0]
  const url = path ?? first?.url
  if (version === undefined || version.length === 0) return undefined
  if (url === undefined || url.length === 0) return undefined
  const sha512 = digest ?? first?.sha512
  return {
    version,
    url,
    ...first?.size === undefined ? {} : { size: first.size },
    ...sha512 === undefined ? {} : { sha512 },
    ...stagingPercentage === undefined ? {} : { stagingPercentage },
    ...releaseDate === undefined ? {} : { releaseDate },
  }
}

/** Dependencies the reader needs, injectable for tests. */
interface DesktopFeedDeps {
  /** Fetch implementation; defaults to the global one. */
  readonly fetchImpl?: typeof fetch
  /** Clock; defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * Ask the feed for the newest installer, cached per process.
 *
 * Concurrent callers share one in-flight lookup. A lookup that fails for any
 * reason — network, timeout, a 404, a document without a release — resolves as
 * "no installer known" rather than rejecting, so the settings page never
 * breaks because the download host is unreachable.
 */
export function createDesktopFeedReader(deps: DesktopFeedDeps = {}): {
  read(force?: boolean): Promise<DesktopReading>
} {
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetchImpl ?? fetch
  let cached: DesktopReading | undefined
  let inflight: Promise<DesktopReading> | undefined

  async function lookup(): Promise<DesktopReading> {
    const checkedAt = now()
    const identity = { checkedAt, platform: DESKTOP_FEED_PLATFORM, channel: DESKTOP_FEED_CHANNEL }
    try {
      const response = await fetchImpl(DESKTOP_FEED_URL, {
        signal: AbortSignal.timeout(DESKTOP_TIMEOUT_MS),
        headers: { accept: 'text/yaml, text/plain, */*' },
      })
      if (!response.ok) throw new Error(`feed answered ${response.status}`)
      const release = parseDesktopFeed(await response.text())
      if (release === undefined) throw new Error('feed carried no release')
      return { ...identity, checked: true, release }
    } catch {
      // The lookup failed, so no installer is known. `checked: false` keeps
      // that distinguishable from a confirmed reading.
      return { ...identity, checked: false }
    }
  }

  return {
    read(force = false): Promise<DesktopReading> {
      if (!force && cached !== undefined && now() - cached.checkedAt < DESKTOP_CACHE_MS) {
        return Promise.resolve(cached)
      }
      inflight ??= lookup().then((reading) => {
        cached = reading
        inflight = undefined
        return reading
      })
      return inflight
    },
  }
}
