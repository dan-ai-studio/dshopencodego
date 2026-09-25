// @vitest-environment jsdom
/**
 * The usage pill: mounted only for this route, labelled from live readings,
 * and honest about failure.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { UsagePill } from '../src/client/UsagePill.tsx'
import { en } from '../src/client/locales.ts'
import type { GoMeter, GoUsageWindows } from '../src/usage/contract.ts'

const WINDOWS: GoUsageWindows = {
  rolling: { status: 'ok', percent: 4, resetsAt: '2026-09-25T05:18:50.000Z' },
  weekly: { status: 'ok', percent: 44, resetsAt: '2026-09-28T08:00:00.000Z' },
  monthly: { status: 'ok', percent: 40, resetsAt: '2026-10-17T10:49:27.000Z' },
}

const METER: GoMeter = {
  sinceMs: 1,
  atMs: 2,
  totals: { calls: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 },
  models: [],
}

function directory(provider: string | undefined) {
  const snapshot = { current: provider === undefined ? undefined : { provider } }
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as never
}

const t = (key: string): string => (en as Record<string, string>)[key] ?? key

afterEach(() => { cleanup() })

describe('UsagePill', () => {
  it('mounts nothing when another provider is selected', () => {
    const { container } = render(
      <UsagePill directory={directory('deepseek-official')} readWindows={async () => WINDOWS} readMeter={async () => METER} t={t} />,
    )
    expect(container.textContent).toBe('')
  })

  it('labels the button from the live windows', async () => {
    render(
      <UsagePill directory={directory('opencode-go')} readWindows={async () => WINDOWS} readMeter={async () => METER} t={t} />,
    )
    const button = await screen.findByRole('button', { name: /OpenCode Go usage/ })
    expect(button.textContent).toMatch(/5 hours 4%/)
    expect(button.textContent).toMatch(/Week 44%/)
  })

  it('keeps the local meter separate from the account windows', async () => {
    render(
      <UsagePill directory={directory('opencode-go')} readWindows={async () => WINDOWS} readMeter={async () => METER} t={t} />,
    )
    const button = await screen.findByRole('button', { name: /OpenCode Go usage/ })
    button.click()
    await screen.findByText('Since this Harness started')
    expect(document.body.textContent).toMatch(/15/)
  })

  it('shows unavailable without inventing zeros when the read fails', async () => {
    const failure = Object.assign(new Error('gone'), {
      code: 'dshopencodego/usage-unavailable',
      details: { retryable: true, retainPrevious: false },
    })
    render(
      <UsagePill
        directory={directory('opencode-go')}
        readWindows={async () => { throw failure }}
        readMeter={async () => METER}
        t={t}
      />,
    )
    const button = await screen.findByRole('button', { name: /unavailable/ })
    expect(button.textContent).not.toMatch(/0%/)
  })
})
