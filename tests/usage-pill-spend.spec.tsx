// @vitest-environment jsdom
/**
 * The spend line inside the usage pill.
 *
 * The pill is the only surface a user reads this number on, so what it must
 * never do is show a figure for a model nobody priced: an absent estimate reads
 * as "Unpriced", and tokens that had no rate are named separately instead of
 * disappearing into the total. The measurement note is part of the contract
 * too — the panel has to say what the number is.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { UsagePill } from '../src/client/UsagePill.tsx'
import { en } from '../src/client/locales.ts'
import type { GoMeter, MeterTotals, GoUsageWindows } from '../src/usage/contract.ts'

const WINDOWS: GoUsageWindows = {
  rolling: { status: 'ok', percent: 4, resetsAt: '2026-09-25T05:18:50.000Z' },
  weekly: { status: 'ok', percent: 44, resetsAt: '2026-09-28T08:00:00.000Z' },
  monthly: { status: 'ok', percent: 40, resetsAt: '2026-10-17T10:49:27.000Z' },
}

const BASE: MeterTotals = {
  calls: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15,
}

function meterWith(totals: MeterTotals, models: GoMeter['models']): GoMeter {
  return { sinceMs: 1, atMs: 2, totals, models }
}

function directory() {
  const snapshot = { current: { provider: 'opencode-go' } }
  return { subscribe: () => () => {}, getSnapshot: () => snapshot } as never
}

const t = (key: string): string => (en as Record<string, string>)[key] ?? key

/** Render the pill open, with one meter reading, and return the panel text. */
async function panelText(meter: GoMeter): Promise<string> {
  render(
    <UsagePill directory={directory()} readWindows={async () => WINDOWS} readMeter={async () => meter} t={t} />,
  )
  const button = await screen.findByRole('button', { name: /OpenCode Go usage/ })
  button.click()
  await screen.findByText('Since this Harness started')
  return document.body.textContent ?? ''
}

afterEach(() => { cleanup() })

describe('usage pill spend', () => {
  it('shows the estimate with the rates it came from', async () => {
    const text = await panelText(meterWith(
      { ...BASE, estimatedUSD: 0.0123 },
      [{ model: 'glm-5.3', ...BASE, estimatedUSD: 0.0123 }],
    ))
    expect(text).toMatch(/Estimated spend/)
    expect(text).toMatch(/\$0\.0123/)
    // The measurement note is not optional: the panel has to say what the
    // number is and where it does not apply.
    expect(text).toMatch(/models\.dev rates/)
    expect(text).toMatch(/not a bill/)
    expect(text).toMatch(/subscription/)
  })

  it('says unpriced instead of showing a zero for a model nobody priced', async () => {
    const text = await panelText(meterWith(
      { ...BASE, unpricedTokens: 15 },
      [{ model: 'no-price', ...BASE, unpricedTokens: 15 }],
    ))
    expect(text).toMatch(/Unpriced/)
    // Not "$0.0000": that is what free looks like, and this is not that.
    expect(text).not.toMatch(/\$0/)
    expect(text).toMatch(/No published rate:/)
    expect(text).toMatch(/no-price/)
  })

  it('names the unpriced tokens alongside a partial estimate', async () => {
    const text = await panelText(meterWith(
      { ...BASE, estimatedUSD: 1.5, unpricedTokens: 1_234 },
      [
        { model: 'priced', ...BASE, estimatedUSD: 1.5 },
        { model: 'unpriced', ...BASE, unpricedTokens: 1_234 },
      ],
    ))
    expect(text).toMatch(/\$1\.50/)
    expect(text).toMatch(/Unpriced tokens/)
    expect(text).toMatch(/1,234/)
    expect(text).toMatch(/unpriced/)
  })

  it('renders a sub-cent estimate without rounding it to zero', async () => {
    const text = await panelText(meterWith(
      { ...BASE, estimatedUSD: 0.00002 },
      [{ model: 'm', ...BASE, estimatedUSD: 0.00002 }],
    ))
    expect(text).toMatch(/<\$0\.0001/)
  })

  it('shows the reasoning share of the output when the provider reported one', async () => {
    const text = await panelText(meterWith(
      { ...BASE, reasoningTokens: 4 },
      [{ model: 'thinker', ...BASE, reasoningTokens: 4 }],
    ))
    expect(text).toMatch(/reasoning tokens/)
    // The billed total is unchanged by it: 4 of the 5 output tokens were thinking.
    expect(text).toMatch(/tokens/)
  })

  it('omits the reasoning line when nothing reported a breakdown', async () => {
    const text = await panelText(meterWith(BASE, [{ model: 'plain', ...BASE }]))
    expect(text).not.toMatch(/reasoning tokens/)
  })
})
