/**
 * Remote registration: one package, one contribution, both namespaces.
 *
 * The settings page mounts `remote.opencodeGoCatalog` and `remote.opencodeGoUsage`;
 * a contribution missing either half leaves a live page silently incomplete, so
 * the descriptors are asserted as a set rather than by example.
 */
import { describe, expect, it, vi } from 'vitest'
import { registerRemotes } from '../src/remotes.ts'

describe('registerRemotes', () => {
  it('registers usage and catalog methods under one package', () => {
    const register = vi.fn()
    const effect = vi.fn((run: () => unknown) => run())
    const inject = vi.fn((_services: unknown, run: (scope: unknown) => unknown) =>
      run({ effect, typert: { register } }))
    registerRemotes({ inject } as never)

    expect(inject).toHaveBeenCalledWith(['typert'], expect.any(Function))
    expect(effect).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledTimes(1)
    const contribution = register.mock.calls[0]![0] as {
      package: string
      face: string
      invocations: Array<{ id: string; service: string; namespace: string; method: string }>
    }
    expect(contribution.package).toBe('@dan-ai-studio/dshopencodego')
    expect(contribution.face).toBe('host')
    const methods = contribution.invocations.map(entry => `${entry.namespace}/${entry.method}`).toSorted()
    expect(methods).toEqual([
      'opencodeGoCatalog/read',
      'opencodeGoCatalog/refresh',
      'opencodeGoUsage/readMeter',
      'opencodeGoUsage/readWindows',
    ])
    for (const entry of contribution.invocations) {
      expect(entry.service).toBe(entry.namespace)
      expect(entry.id).toBe(`@dan-ai-studio/dshopencodego#${entry.namespace}/${entry.method}`)
    }
  })
})
