/**
 * The desktop app's download feed (advisory only).
 *
 * @module @dan-ai-studio/dshopencodego/desktop
 */

export {
  DESKTOP_CACHE_MS,
  DESKTOP_FEED_CHANNEL,
  DESKTOP_FEED_PLATFORM,
  DESKTOP_FEED_URL,
  DESKTOP_TIMEOUT_MS,
} from './feed.ts'
export type { DesktopReading, DesktopRelease } from './feed.ts'
export { createDesktopFeedReader, parseDesktopFeed } from './feed.ts'
export {
  DESKTOP_FEED_FALLBACK_CHANNEL,
  DESKTOP_FEED_FALLBACK_PLATFORM,
  DESKTOP_FEED_FALLBACK_URL,
  resolveDesktopFeedSource,
} from './source.ts'
export type { DesktopFeedSource, DesktopFeedSourceDeps } from './source.ts'
