/**
 * A stand-in for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The real package's published entry pulls a whole markdown and
 * syntax-highlighting toolchain (shiki, katex, micromark, …) into the module
 * graph the moment anything imports it. None of that is what these tests
 * measure: they measure the plugin's own page and its own logic, and the
 * glyphs are decoration.
 *
 * So the suite swaps the package for this stub, which renders the same
 * element names with no children. The shell provides the real package at
 * runtime — it is an external of the client bundle — and this stub changes
 * nothing that ships.
 *
 * @module @dan-ai-studio/dshopencodego/tests/stubs/ui-primitives
 */

import type { ReactNode } from 'react'

/** The props every stubbed icon accepts. */
export interface StubIconProps {
  readonly size?: number
  readonly className?: string
  readonly 'aria-hidden'?: boolean | 'true' | 'false'
}

/** One stubbed glyph: an empty element with the icon's name. */
function icon(name: string) {
  return function StubbedIcon(props: StubIconProps): ReactNode {
    return <span data-stub-icon={name} data-size={props.size} className={props.className} />
  }
}

export const IconDataOutlineRegular = icon('data')
export const IconRefreshOutlineRegular = icon('refresh')
export const IconCloseOutlineRegular = icon('close')
export const IconPluginPinwheelOutlineRegular = icon('plugin')
