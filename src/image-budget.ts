/**
 * Image-budget presets: the three numbers every image-bearing request is
 * shaped by — per-image pixels, per-image bytes, whole-request bytes.
 *
 * The default is `default`: the plugin names no budget at all, so the host
 * route's own budgets decide. `dsh` names those same numbers explicitly for a
 * caller that wants them pinned, and `pi-ai` uses the per-model resize profile
 * pi-ai ships in its catalog.
 *
 * - `default`: let DSH decide — no budget is named by the plugin.
 * - `dsh`: DSH's own route defaults (`llm-pi-ai` config), named explicitly.
 * - `pi-ai`: the per-model resize profile pi-ai ships in its catalog,
 *   uniform across providers. pi-ai publishes no generic request cap, so
 *   the request level reuses the common per-model value from its catalog —
 *   which coincides with DSH's request default.
 *
 * @module @dan-ai-studio/dshopencodego/image-budget
 */

/** The sources an image budget can be taken from, in UI order. */
export const IMAGE_BUDGET_PRESETS = ['default', 'dsh', 'pi-ai'] as const

/** One of the named image-budget sources. */
export type ImageBudgetPreset = (typeof IMAGE_BUDGET_PRESETS)[number]

/** The three image budgets: per-image pixels, per-image bytes, whole-request bytes. */
export interface ImageBudget {
  readonly maxPixels: number
  readonly maxBytes: number
  readonly maxRequestBytes: number
}

/**
 * The effective budgets behind each preset name.
 *
 * `default` mirrors the host's own numbers because the request log still has
 * to estimate an image's wire size; it is not sent on the request itself.
 */
export const IMAGE_BUDGETS: Record<ImageBudgetPreset, ImageBudget> = {
  default: { maxPixels: 2048 * 2048, maxBytes: 1024 * 1024, maxRequestBytes: 20 * 1024 * 1024 },
  dsh: { maxPixels: 2048 * 2048, maxBytes: 1024 * 1024, maxRequestBytes: 20 * 1024 * 1024 },
  'pi-ai': { maxPixels: 2000 * 2000, maxBytes: 4718592, maxRequestBytes: 20 * 1024 * 1024 },
}

/** Whether a settings value names a known preset; anything else falls back to `default`. */
export function isImageBudgetPreset(value: unknown): value is ImageBudgetPreset {
  return typeof value === 'string' && (IMAGE_BUDGET_PRESETS as readonly string[]).includes(value)
}

/** Whether the preset leaves the budget to the host — no field is passed on the request. */
export function isHostImageBudget(preset: ImageBudgetPreset): boolean {
  return preset === 'default'
}
