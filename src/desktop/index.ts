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
export { OpencodeGoDesktopService } from './service.ts'
export { desktopRemote, parseDesktopReading } from './contract.ts'
