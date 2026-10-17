/**
 * Durable replay state and version ordering: an envelope this process writes
 * must be one it can read back, and a prerelease identifier must compare the
 * way semver says it does.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  REPLAYABLE_STOP_REASONS,
  replayableStopReason,
  toPiAssistant,
  toPiReplayState,
} from '../src/conversion/replay.ts'
import { compareVersions, isUpdateAvailable } from '../src/update/check.ts'

/** A minimal completed pi-ai message: only the fields the envelope reads. */
function completed(stopReason: string): never {
  return {
    api: 'openai-completions',
    provider: 'opencode-go',
    model: 'glm-5.3',
    stopReason,
    content: [{ type: 'text', text: 'hi', textSignature: 'sig-text' }],
  } as never
}

/** The durable assistant message a later request rebuilds from. */
function history(envelope: unknown): never {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'model', provider: 'opencode-go', model: 'glm-5.3', replayState: envelope },
  } as never
}

describe('replay stop reasons', () => {
  it.each(['pending', 'deferred'] as const)(
    'stores the transport state %s in its durable form',
    (transport) => {
      // pi-ai can hand a `done` event with `deferred` (pi-ai types:616), and
      // the write side used to store it verbatim — so the next request read
      // its own envelope as invalid, degraded the message, and dropped every
      // signature.
      const envelope = toPiReplayState(completed(transport), 'glm-5.3')
      expect(envelope.response).toMatchObject({ stopReason: 'error' })
    },
  )

  it('reads back what it wrote, signatures intact and without degrading', () => {
    const envelope = toPiReplayState(completed('deferred'), 'glm-5.3')
    const degrade = vi.fn()
    const native = toPiAssistant(history(envelope), degrade)
    expect(degrade).not.toHaveBeenCalled()
    expect(native.api).toBe('openai-completions')
    expect(native.content[0]).toMatchObject({ type: 'text', text: 'hi', textSignature: 'sig-text' })
  })

  it('keeps the write mapping and the read whitelist in one vocabulary', () => {
    for (const reason of REPLAYABLE_STOP_REASONS) {
      expect(replayableStopReason(reason)).toBe(reason)
      const native = toPiAssistant(history(toPiReplayState(completed(reason), 'glm-5.3')))
      expect(native.api).toBe('openai-completions')
    }
    // Anything outside the whitelist is a transport state, never a durable one.
    expect(replayableStopReason('pending')).toBe('error')
    expect(replayableStopReason('deferred')).toBe('error')
  })
})

describe('compareVersions prerelease ordering', () => {
  it('compares numeric identifiers numerically', () => {
    expect(compareVersions('0.2.1-rc.10', '0.2.1-rc.9')).toBeGreaterThan(0)
    expect(compareVersions('0.2.1-rc.9', '0.2.1-rc.10')).toBeLessThan(0)
    expect(compareVersions('0.1.0-alpha.10', '0.1.0-alpha.9')).toBeGreaterThan(0)
  })

  it('follows the semver 11 precedence chain', () => {
    const ordered = [
      '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta',
      '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0',
    ]
    for (let index = 1; index < ordered.length; index += 1) {
      expect(compareVersions(ordered[index - 1]!, ordered[index]!)).toBeLessThan(0)
    }
  })

  it('drives the update notice for the prerelease ranges this project ships', () => {
    expect(isUpdateAvailable('0.2.1-rc.9', '0.2.1-rc.10')).toBe(true)
    expect(isUpdateAvailable('0.2.1-rc.10', '0.2.1-rc.9')).toBe(false)
    expect(isUpdateAvailable('0.2.1-rc.10', '0.2.1')).toBe(true)
    expect(isUpdateAvailable('0.2.1', '0.2.1-rc.10')).toBe(false)
  })
})
