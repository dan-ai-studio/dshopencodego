/**
 * Go's published per-model monthly allowance.
 *
 * The authoritative source is the gateway's `/v1/models` listing: each model
 * carries `go.monthly_usage.go`, the Go-tier monthly allowance in USD. Free
 * models publish `null` there, which means no monetary limit — represented as
 * `unlimited`. The gateway value is read live by `catalog/gateway.ts` and
 * projected onto the settings page, so a provider price change reaches users
 * without a plugin release.
 *
 * The frozen seed below is the last resort: it renders instantly at startup
 * and keeps the page honest when the gateway cannot be read at all. It is
 * deliberately not a maintenance target — wherever it is shown, its
 * transcription date travels with it so a stale number is never silent.
 *
 * @module @dan-ai-studio/dshopencodego/go-limits
 */

/** The date this seed was transcribed from the provider's page. */
export const SEED_TRANSCRIBED = '2026-09-25'

/** One model's published Go-tier monthly allowance. */
export interface GoQuota {
  /** Go-tier monthly allowance in USD, or `unlimited` where none is published. */
  readonly monthlyUsd: number | 'unlimited'
}

/**
 * The frozen seed allowances, keyed by model id, from the September 2026
 * transcription. Only the Go tier is kept: the gateway's live listing is the
 * authority, and this is the floor behind it.
 * Not a maintenance target.
 */
export const SEED_QUOTAS: Readonly<Record<string, GoQuota>> = {
  'glm-5.3-flash': { monthlyUsd: 60 },
  'glm-5.3': { monthlyUsd: 15 },
  'glm-5.2': { monthlyUsd: 60 },
  'glm-5.1': { monthlyUsd: 60 },
  'kimi-k3': { monthlyUsd: 15 },
  'kimi-k2.7-code': { monthlyUsd: 60 },
  'kimi-k2.6': { monthlyUsd: 60 },
  'longcat-2.0': { monthlyUsd: 60 },
  'mimo-v2.6-flash': { monthlyUsd: 60 },
  'mimo-v2.6-pro': { monthlyUsd: 15 },
  'mimo-v2.5': { monthlyUsd: 60 },
  'mimo-v2.5-pro': { monthlyUsd: 15 },
  'minimax-m3': { monthlyUsd: 60 },
  'minimax-m2.7': { monthlyUsd: 60 },
  'minimax-m2.5': { monthlyUsd: 60 },
  'muse-spark-1.3-contributor': { monthlyUsd: 60 },
  'muse-spark-1.2-contributor': { monthlyUsd: 60 },
  'qwen3.8-max': { monthlyUsd: 15 },
  'qwen3.8-flash': { monthlyUsd: 30 },
  'qwen3.7-max': { monthlyUsd: 30 },
  'qwen3.7-plus': { monthlyUsd: 60 },
  'qwen3.6-plus': { monthlyUsd: 60 },
  'deepseek-v4.1-flash': { monthlyUsd: 60 },
  'deepseek-v4-pro': { monthlyUsd: 15 },
  'deepseek-v4-flash': { monthlyUsd: 30 },
  'deepseek-v4-flash-vision-exp': { monthlyUsd: 15 },
  'hy4-preview': { monthlyUsd: 30 },
  'hy3': { monthlyUsd: 60 },
  'grok-4.7': { monthlyUsd: 15 },
  'grok-4.6': { monthlyUsd: 15 },
  'gpt-6-luna': { monthlyUsd: 15 },
  'gpt-5.6-luna': { monthlyUsd: 15 },
  // Free tiers publish no monetary limit in the gateway (`monthly_usage: null`).
  // Keeping them in the seed makes the default-enabled ranking prefer them even
  // before the listing answers, on both the picker and the settings surface.
  'beam-free': { monthlyUsd: 'unlimited' },
  'hy4-flash-free': { monthlyUsd: 'unlimited' },
  'longcat-2.5-free': { monthlyUsd: 'unlimited' },
  'iceman-contributor-free': { monthlyUsd: 'unlimited' },
}

/** The seed allowance for one model id. */
export function goQuotaFor(id: string): GoQuota | undefined {
  return Object.hasOwn(SEED_QUOTAS, id) ? SEED_QUOTAS[id] : undefined
}

/**
 * Rank a quota for "most usable first" ordering: an unlimited (free) model
 * beats any finite allowance, a larger allowance beats a smaller one, and a
 * model with no published allowance sorts last.
 */
export function monthlyUsdRank(quota: GoQuota | undefined): number {
  if (quota === undefined) return -1
  if (quota.monthlyUsd === 'unlimited') return Number.MAX_SAFE_INTEGER
  return quota.monthlyUsd
}
