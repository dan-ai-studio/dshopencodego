/**
 * Spend ceiling for live probes.
 *
 * A live probe must never become a bill by accident: before any request goes
 * out, the model named for the probe is priced from the installed pi-ai
 * catalog and the worst-case cost of the capped request is estimated. Above
 * the ceiling — or when the model has no published price at all — the probe
 * refuses unless the caller passes `--allow-expensive` explicitly.
 *
 * Prices are informational (the gateway bills, not this file); the ceiling is
 * set two orders of magnitude above a normal probe so it only trips on a
 * genuinely expensive or unknown model, never on price jitter.
 */
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'

/** Prompt tokens a one-word probe carries (system + history + replay). */
const INPUT_TOKENS_ESTIMATE = 150

/**
 * Reasoning headroom folded into billed output. Thinking models can burn
 * thousands of reasoning tokens on a trivial prompt, and that is exactly how
 * "one cheap test" becomes an expensive one — so the estimate assumes it.
 */
const REASONING_HEADROOM_TOKENS = 8000

/** Worst-case dollars per probe above which explicit opt-in is required. */
const CEILING_USD = 0.01

/**
 * Refuse an expensive or unpriced probe model.
 * @param modelId - the exact gateway model id about to be probed.
 * @param maxTokens - the capped generation length for this probe.
 * @param options - pass `allowExpensive: true` only via `--allow-expensive`.
 * @throws when the estimate exceeds the ceiling without explicit opt-in.
 * @returns the worst-case dollar estimate, for the log.
 */
export function assertCheapModel(modelId, maxTokens, options = {}) {
  const entry = getBuiltinModels('opencode-go').find(model => model.id === modelId)
  const price = entry?.cost
  if (typeof price?.input !== 'number' || typeof price?.output !== 'number') {
    if (options.allowExpensive !== true) {
      throw new Error(
        `refusing live probe: "${modelId}" has no published price in the installed pi-ai catalog.` +
        ' Pass --allow-expensive only when the answer is worth an unknown price.',
      )
    }
    console.log(`live probe price: "${modelId}" unpriced, --allow-expensive accepted`)
    return Number.NaN
  }
  const estimate = (INPUT_TOKENS_ESTIMATE * price.input + (maxTokens + REASONING_HEADROOM_TOKENS) * price.output) / 1_000_000
  console.log(
    `live probe price: "${modelId}" input $${price.input}/1M + output $${price.output}/1M` +
    ` => worst case ~$${estimate.toFixed(6)} (cap $${CEILING_USD})`,
  )
  if (estimate > CEILING_USD && options.allowExpensive !== true) {
    throw new Error(
      `refusing live probe: "${modelId}" estimates ~$${estimate.toFixed(4)}, above the $${CEILING_USD} ceiling.` +
      ' Pass --allow-expensive only when the answer is worth its price.',
    )
  }
  return estimate
}
