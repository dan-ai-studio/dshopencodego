/**
 * The sidebar's request-log entry icon.
 *
 * The sidebar owns the button, its label, and the selected state around it;
 * this occupant contributes only the glyph.
 *
 * @module @dan-ai-studio/dshopencodego/client/RequestLogPanelIcon
 */

import { IconDataOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `sidebar.panellist` list this occupant registers into.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the log glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share.
 * @returns the icon element.
 */
export function RequestLogPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): React.JSX.Element {
  return <IconDataOutlineRegular size={size} />
}
