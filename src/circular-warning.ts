/**
 * Silence Node's circular-dependency property warning.
 *
 * `@earendil-works/pi-ai` named-imports `partial-json`:
 *
 * ```js
 * import { parse as partialParse } from "partial-json";
 * ```
 *
 * Resolving a named import from CommonJS makes Node enumerate the module's
 * exports, and `partial-json`'s `index.js` and `options.js` require each
 * other — so the enumeration reads `Allow` while its own module is still
 * initialising. Node prints, once per read:
 *
 *   Accessing non-existent property 'Allow' of module exports inside circular dependency
 *
 * The read is harmless: `parse` resolves correctly, the value is present once
 * the pair settles, and every request this plugin makes was verified against
 * that behaviour. What makes it worth filtering is the volume — a plugin
 * reload re-runs the graph, and each enumeration prints again, so an update
 * leaves a flood of identical lines in the host's log. A wall of warnings
 * nobody can act on is how a real one gets missed.
 *
 * Why a message filter rather than a supported switch: Node emits this one
 * with a bare string and **no type**, so `--disable-warning` (which matches a
 * code or type) cannot select it. Matching the message prefix is the narrowest
 * filter available, and it drops exactly one message — everything else reaches
 * the default handler untouched.
 *
 * @module @dan-ai-studio/dshopencodego/circular-warning
 */

/** The invariable opening of Node's message; the property name varies. */
const PREFIX = 'Accessing non-existent property'

/**
 * Marks the process as filtered.
 *
 * A `Symbol.for` key so it survives a plugin reload: the host may evaluate
 * this bundle again, and the filter must be installed once for the process
 * rather than once per evaluation.
 */
const INSTALLED = Symbol.for('dshopencodego/circular-warning-filter')

/** The text of a warning Node may pass as a string or as an `Error`. */
function warningText(warning: unknown): string {
  if (typeof warning === 'string') return warning
  const message = (warning as { message?: unknown } | undefined)?.message
  return String(message ?? warning)
}

/**
 * Whether this warning is the circular-dependency one.
 *
 * Exported so the rule can be tested directly, without installing anything.
 * @param warning - the first argument Node passes to `process.emitWarning`.
 * @returns true when the warning is Node's circular-dependency notice.
 */
export function dropsCircularWarning(warning: unknown): boolean {
  return warningText(warning).startsWith(PREFIX)
}

/**
 * Install the filter. Safe to call on every mount; the first call wins.
 *
 * Called from `apply` rather than from module scope because ES module imports
 * are hoisted — by the time any statement of this bundle runs, `pi-ai` has
 * already been evaluated, so the first enumeration cannot be intercepted. Every
 * later one can, and a reload is exactly what produces the flood.
 * @param target - the process-like object to patch; defaults to the real one.
 */
export function filterCircularWarnings(
  target: Pick<typeof process, 'emitWarning'> = process,
): void {
  const host = target as Pick<typeof process, 'emitWarning'> & { [INSTALLED]?: true }
  if (host[INSTALLED] === true) return
  host[INSTALLED] = true
  const original = target.emitWarning.bind(target) as (...args: unknown[]) => void
  target.emitWarning = ((warning: unknown, ...rest: unknown[]): void => {
    if (dropsCircularWarning(warning)) return
    original(warning, ...rest)
  }) as typeof process.emitWarning
}
