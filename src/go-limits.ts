/**
 * Go's published per-model quota.
 *
 * No API exposes this — the gateway's `/v1/models` answers only ids, and
 * `/usage` answers three account-wide percentages — so the numbers are
 * transcribed from the provider's own documentation.
 *
 * Source: https://opencode.ai/docs/zh-cn/go — the 「使用限制」 and
 * 「预估请求数」 tables. Transcribed 2026-09-25.
 *
 * Two caveats are part of the data's meaning, not noise:
 * - `monthlyUsd` is the hard monthly allowance; the request counts are the
 *   provider's own estimate for a typical request mix, not a hard ceiling.
 * - DeepSeek V4.1 Flash carries a limited-time 4x allowance (until 2026-09-27)
 *   already reflected here; the archived numbers follow the provider page.
 *
 * @module @dan-ai-studio/dshopencodego/go-limits
 */

/** One model's published Go allowance. */
export interface GoQuota {
  /** Monthly usage allowance in USD, or `unlimited` where none is published. */
  readonly monthlyUsd: number | 'unlimited'
  /** Provider's estimated requests per month for a typical mix, when listed. */
  readonly monthlyRequests?: number | 'unlimited'
}

/** The transcribed table, keyed by model id. */
export const GO_QUOTAS: Readonly<Record<string, GoQuota>> = {
  'glm-5.3-flash': { monthlyUsd: 60, monthlyRequests: 31_580 },
  'glm-5.3': { monthlyUsd: 15, monthlyRequests: 1_080 },
  'glm-5.2': { monthlyUsd: 60, monthlyRequests: 4_300 },
  'glm-5.1': { monthlyUsd: 60, monthlyRequests: 4_300 },
  'kimi-k3': { monthlyUsd: 15, monthlyRequests: 490 },
  'kimi-k2.7-code': { monthlyUsd: 60, monthlyRequests: 6_750 },
  'kimi-k2.6': { monthlyUsd: 60, monthlyRequests: 5_750 },
  'longcat-2.0': { monthlyUsd: 60, monthlyRequests: 57_200 },
  'mimo-v2.6-flash': { monthlyUsd: 60, monthlyRequests: 150_400 },
  'mimo-v2.6-pro': { monthlyUsd: 15, monthlyRequests: 16_300 },
  'mimo-v2.5': { monthlyUsd: 60, monthlyRequests: 150_400 },
  'mimo-v2.5-pro': { monthlyUsd: 15, monthlyRequests: 16_300 },
  'minimax-m3': { monthlyUsd: 60, monthlyRequests: 16_000 },
  'minimax-m2.7': { monthlyUsd: 60, monthlyRequests: 17_000 },
  'minimax-m2.5': { monthlyUsd: 60 },
  'muse-spark-1.3-contributor': { monthlyUsd: 60, monthlyRequests: 226_600 },
  'muse-spark-1.2-contributor': { monthlyUsd: 60, monthlyRequests: 226_600 },
  'qwen3.8-max': { monthlyUsd: 15, monthlyRequests: 810 },
  'qwen3.8-flash': { monthlyUsd: 30, monthlyRequests: 27_000 },
  'qwen3.7-max': { monthlyUsd: 30, monthlyRequests: 840 },
  'qwen3.7-plus': { monthlyUsd: 60, monthlyRequests: 21_600 },
  'qwen3.6-plus': { monthlyUsd: 60, monthlyRequests: 16_300 },
  'deepseek-v4.1-flash': { monthlyUsd: 60, monthlyRequests: 130_000 },
  'deepseek-v4-pro': { monthlyUsd: 15, monthlyRequests: 5_200 },
  'deepseek-v4-flash': { monthlyUsd: 30, monthlyRequests: 65_000 },
  'deepseek-v4-flash-vision-exp': { monthlyUsd: 15, monthlyRequests: 32_500 },
  'hy4-preview': { monthlyUsd: 30, monthlyRequests: 6_770 },
  'hy3': { monthlyUsd: 60, monthlyRequests: 21_500 },
  'space-bunny-free': { monthlyUsd: 'unlimited', monthlyRequests: 'unlimited' },
  'grok-4.7': { monthlyUsd: 15, monthlyRequests: 845 },
  'grok-4.6': { monthlyUsd: 15, monthlyRequests: 845 },
  'gpt-6-luna': { monthlyUsd: 15, monthlyRequests: 21_130 },
  'gpt-5.6-luna': { monthlyUsd: 15, monthlyRequests: 10_250 },
}

/**
 * The published quota for one model id.
 * @param id - the gateway's model id.
 * @returns the transcribed allowance, or undefined when the page lists none.
 */
export function goQuotaFor(id: string): GoQuota | undefined {
  return Object.hasOwn(GO_QUOTAS, id) ? GO_QUOTAS[id] : undefined
}

/**
 * Rank a quota for "most usable first" ordering: unlimited beats any finite
 * request estimate, a larger estimate beats a smaller one, and a model the
 * page does not quantify sorts last.
 * @param quota - the allowance under comparison, when one exists.
 * @returns a sortable rank.
 */
export function monthlyRequestsRank(quota: GoQuota | undefined): number {
  if (quota === undefined) return -1
  const requests = quota.monthlyRequests
  if (requests === 'unlimited') return Number.MAX_SAFE_INTEGER
  if (requests === undefined) return quota.monthlyUsd === 'unlimited' ? Number.MAX_SAFE_INTEGER : -1
  return requests
}
