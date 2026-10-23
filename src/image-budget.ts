/**
 * Image-budget presets: the three numbers every image-bearing request is
 * shaped by — per-image pixels, per-image bytes, whole-request bytes.
 *
 * Two different sources name such numbers, and a third set is this
 * plugin's own history, so the setting names the source rather than
 * repeating the numbers. `dsh` is the default: without an explicit choice
 * a profile reads exactly the host route's own budgets.
 *
 * - `dsh`: DSH's own route defaults (`llm-pi-ai` config).
 * - `dshopencodego`: this plugin's historic, tighter budgets for slow links.
 * - `pi-ai`: the per-model resize profile pi-ai ships in its catalog,
 *   uniform across providers. pi-ai publishes no generic request cap, so
 *   the request level reuses the common per-model value from its catalog —
 *   which coincides with DSH's request default.
 *
 * @module @dan-ai-studio/dshopencodego/image-budget
 */

/** The sources an image budget can be taken from, in UI order. */
export const IMAGE_BUDGET_PRESETS = ['dsh', 'dshopencodego', 'pi-ai'] as const

/** One of the named image-budget sources. */
export type ImageBudgetPreset = (typeof IMAGE_BUDGET_PRESETS)[number]

/** The three image budgets: per-image pixels, per-image bytes, whole-request bytes. */
export interface ImageBudget {
  readonly maxPixels: number
  readonly maxBytes: number
  readonly maxRequestBytes: number
}

/** The effective budgets behind each preset name. */
export const IMAGE_BUDGETS: Record<ImageBudgetPreset, ImageBudget> = {
  dsh: { maxPixels: 2048 * 2048, maxBytes: 1024 * 1024, maxRequestBytes: 20 * 1024 * 1024 },
  dshopencodego: { maxPixels: 1_440_000, maxBytes: 400_000, maxRequestBytes: 6 * 1024 * 1024 },
  'pi-ai': { maxPixels: 2000 * 2000, maxBytes: 4718592, maxRequestBytes: 20 * 1024 * 1024 },
}

/** Whether a settings value names a known preset; anything else falls back to `dsh`. */
export function isImageBudgetPreset(value: unknown): value is ImageBudgetPreset {
  return typeof value === 'string' && (IMAGE_BUDGET_PRESETS as readonly string[]).includes(value)
}
