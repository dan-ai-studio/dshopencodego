/**
 * The image budgets every image-bearing request is shaped by — per-image
 * pixels, per-image encoded bytes, whole-request bytes.
 *
 * These are DSH's own route defaults (`DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET` and
 * `DEFAULT_REQUEST_IMAGE_MAX_BYTES` in `llm-pi-ai`), named here because the
 * attachment store takes a target rather than reading a default: a caller has
 * to hand it dimensions and a byte limit. There is deliberately no setting:
 * one provider mirroring another's numbers into a menu produced three options
 * whose values were identical, and a budget the host changes should not need a
 * plugin release to follow.
 *
 * @module @dan-ai-studio/dshopencodego/image-budget
 */

/** The three image budgets: per-image pixels, per-image bytes, whole-request bytes. */
export interface ImageBudget {
  readonly maxPixels: number
  /** Hard encoded-byte limit for one image; the encoder never returns more. */
  readonly maxImageBytes: number
  readonly maxRequestBytes: number
}

/** DSH's own route defaults, the same numbers `llm-pi-ai` uses without configuration. */
export const IMAGE_BUDGET: ImageBudget = {
  maxPixels: 2048 * 2048,
  maxImageBytes: 1024 * 1024,
  maxRequestBytes: 20 * 1024 * 1024,
}
