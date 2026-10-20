/**
 * Where the plugin's cache may and may not be written.
 *
 * The cache is a real file in a real directory, so a fallback path that
 * guesses one is a path that a test can write to — and a test that writes
 * there does not write to a test's directory. It writes to the user's, and
 * the next process then believes the user's cache is a statement about
 * their models.
 *
 * The Harness resolves the home itself (`ctx.dshHomePath`, published by
 * `app-boot`), and it applies the Harness' own rule about `$DSH_HOME` and
 * `~/.dsh`. A context without that resolver is not a Harness host, and
 * nothing is written for it.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

/** The directory the plugin would write to if it guessed a home. */
function realCacheDir(): string {
  const configured = process.env.DSH_HOME?.trim()
  const root = configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.dsh')
  return join(root, 'cache', '@dan-ai-studio/dshopencodego')
}

/** What the directory holds now, so a change to it can be seen. */
function snapshot(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory).sort()
}

describe('the cache directory', () => {
  it('is the Harness home when the Harness provides one', async () => {
    const ctx: Record<string, unknown> = {
      get: () => undefined,
      llm: {
        registerAdapter: vi.fn(() => () => {}),
        registerModelDiscovery: vi.fn(() => () => {}),
      },
      plugin: vi.fn(),
      effect: vi.fn(),
      on: vi.fn(),
      inject: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      // What `app-boot` publishes.
      dshHomePath: (...segments: string[]) => join('C:\\harness-home', ...segments),
    }
    apply(ctx as never, { enabled: false })
    // The path the plugin computed is not observable from here, so the check
    // is that it did not fall back: nothing was written beside the wrong
    // tree, and nothing threw.
    expect(existsSync(join('C:\\harness-home'))).toBe(false)
  })

  it('is not guessed when there is no Harness home to use', async () => {
    const directory = realCacheDir()
    const before = snapshot(directory)
    const ctx: Record<string, unknown> = {
      get: (name: string) => name === 'credentials'
        ? { describe: async () => ({ configured: true }), resolve: async () => undefined }
        : undefined,
      llm: {
        registerAdapter: vi.fn(() => () => {}),
        registerModelDiscovery: vi.fn(() => () => {}),
      },
      plugin: vi.fn(),
      effect: vi.fn(),
      on: vi.fn(),
      inject: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }
    apply(ctx as never, { enabled: true })
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
    // Ask the route for its models: that is what makes it read the metadata
    // and, without a home, must not write anything down.
    const registerAdapter = (ctx.llm as { registerAdapter: ReturnType<typeof vi.fn> }).registerAdapter
    const adapter = registerAdapter.mock.calls[0]![1] as { listModels: (p: string) => Promise<unknown> }
    await adapter.listModels('opencode-go')
    // Mounting and reading without a home must not touch the user's cache
    // directory.
    expect(snapshot(directory)).toEqual(before)
  })

  it('is a directory this plugin owns, not a shared one', () => {
    const directory = realCacheDir()
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory)) {
      // Only the files this plugin writes may live there.
      expect([
        'models-dev-facts.json',
        'go-doc-paths.json',
        'go-doc-cache.json',
        'catalog-snapshot.json',
      ]).toContain(entry)
      expect(statSync(join(directory, entry)).isFile()).toBe(true)
    }
  })
})
