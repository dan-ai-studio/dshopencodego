/**
 * Best-effort cache writes that never block the event loop.
 *
 * Cache files are written on a catalog build, which can happen while a model
 * request is streaming. A synchronous `writeFileSync` on a multi-megabyte cache
 * file stalls the process for the duration of the write; the document cache is
 * the worst case. Writes here are serialized per file and handed to the
 * filesystem asynchronously, while the latest contents stay visible to a
 * synchronous read in this process until they land — so a write followed by a
 * read, on which the cache tests and the conditional-request path rely, still
 * observes the new value immediately.
 *
 * A cache that cannot be written costs a refetch, never a failed request, so
 * write errors are swallowed just as they were with `writeFileSync`.
 *
 * @module @dan-ai-studio/dshopencodego/catalog/cache-write
 */

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const pending = new Map<string, string>()
const queues = new Map<string, Promise<void>>()

/**
 * Read a cache file synchronously, preferring the newest unflushed write.
 * @param cacheDir - the plugin's cache directory.
 * @param file - the cache file's name.
 * @returns the file's text, or undefined when it is absent or unreadable.
 */
export function readCacheFileSync(cacheDir: string | undefined, file: string): string | undefined {
  if (cacheDir === undefined) return undefined
  const target = join(cacheDir, file)
  const fresh = pending.get(target)
  if (fresh !== undefined) return fresh
  try {
    return readFileSync(target, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Hand a cache write to the filesystem without waiting for it.
 *
 * Writes to the same file are serialized so an older snapshot cannot land
 * after a newer one. The contents remain visible to {@link readCacheFileSync}
 * until the write settles, then are dropped from memory.
 * @param cacheDir - the plugin's cache directory; no cache when absent.
 * @param file - the cache file's name.
 * @param contents - the full text to write.
 */
export function writeCacheFile(cacheDir: string | undefined, file: string, contents: string): void {
  if (cacheDir === undefined) return
  const target = join(cacheDir, file)
  pending.set(target, contents)
  const previous = queues.get(target) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(cacheDir, { recursive: true })
      await writeFile(target, contents, 'utf8')
    })
    .catch(() => undefined)
    .then(() => {
      if (pending.get(target) === contents) pending.delete(target)
      if (queues.get(target) === next) queues.delete(target)
    })
  queues.set(target, next)
}
