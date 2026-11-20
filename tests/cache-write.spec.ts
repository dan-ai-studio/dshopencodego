/**
 * Best-effort cache writes: readable at once in-process, and really flushed
 * to disk afterwards without blocking the caller. The pending view must not
 * hide a write that never landed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCacheFileSync, writeCacheFile } from '../src/catalog/cache-write.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function cacheDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dshopencodego-cache-'))
  directories.push(directory)
  return directory
}

async function waitForDisk(path: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (readFileSync(path, 'utf8') === expected) return
    } catch {
      // The file may not exist until the first flush completes.
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`cache file ${path} was never flushed with ${expected}`)
}

describe('cache writes', () => {
  it('is readable immediately and then really lands on disk', async () => {
    const directory = cacheDir()
    writeCacheFile(directory, 'one.json', '{"a":1}\n')
    // A write followed by a read observes the new value without waiting.
    expect(readCacheFileSync(directory, 'one.json')).toBe('{"a":1}\n')
    await waitForDisk(join(directory, 'one.json'), '{"a":1}\n')
    expect(readCacheFileSync(directory, 'one.json')).toBe('{"a":1}\n')
  })

  it('serializes writes to one file so the newest wins', async () => {
    const directory = cacheDir()
    writeCacheFile(directory, 'two.json', 'first\n')
    writeCacheFile(directory, 'two.json', 'second\n')
    expect(readCacheFileSync(directory, 'two.json')).toBe('second\n')
    await waitForDisk(join(directory, 'two.json'), 'second\n')
  })

  it('treats an absent directory as no cache', () => {
    expect(readCacheFileSync(undefined, 'one.json')).toBeUndefined()
    expect(() => writeCacheFile(undefined, 'one.json', 'x')).not.toThrow()
  })
})
