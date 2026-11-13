/**
 * The Host and the Client must mount the *same* Remote descriptors.
 *
 * A Remote namespace exists on the Client only because the Client's own
 * `$mount` contribution names it. The Host registering a descriptor is not
 * enough — and the failure is silent: the page's `ctx.inject` simply never
 * resolves, so the settings section never registers and the plugin looks
 * installed but absent.
 *
 * That is exactly what 0.1.92 did. `opencodeGoDesktop` was added to
 * `src/remotes.ts` and forgotten in `src/client/index.ts`, and the settings
 * page vanished for two releases. 0.1.94 stopped the section from disappearing
 * by reading the namespace defensively, but the download row still said "not
 * ready" because the namespace genuinely did not exist. This spec pins the two
 * lists so the next descriptor cannot be added to one side only.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const HOST = 'src/remotes.ts'
const CLIENT = 'src/client/index.ts'

/** Remote modules whose descriptors one file mounts, in source order. */
function mountedRemotes(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(/\.\.\.([A-Za-z]+Remote)\.descriptors/g)].map(match => match[1]!)
}

/** The `package` one file addresses its contribution to. */
function contributionPackage(file: string): string | undefined {
  const source = readFileSync(file, 'utf8')
  return /package:\s*([A-Za-z]+Remote)\.package/.exec(source)?.[1]
}

describe('Remote mount parity', () => {
  it('mounts the same Remote descriptors on both halves', () => {
    const host = mountedRemotes(HOST)
    const client = mountedRemotes(CLIENT)
    expect(host.length).toBeGreaterThan(0)
    // Sorted comparison: order differs (the Client groups the settings-page
    // reads), membership must not.
    expect(client.toSorted()).toEqual(host.toSorted())
  })

  it('addresses both contributions to the same package', () => {
    // Both sides must name one package: the registry owns one contribution per
    // package, so a second `$mount` under another name would not compose.
    const host = contributionPackage(HOST)
    const client = contributionPackage(CLIENT)
    expect(host).toBeDefined()
    expect(client).toBe(host)
  })

  it('mounts the desktop Remote on the Client', () => {
    // The regression this spec exists for, asserted by name so a future
    // refactor cannot quietly drop it again.
    expect(mountedRemotes(CLIENT)).toContain('desktopRemote')
  })
})
