/**
 * Remote registration.
 *
 * One registry owns one contribution per package, so both usage methods are
 * mounted together after whichever registry activation order the composition
 * happens to use.
 *
 * @module @dan-ai-studio/dshopencodego/remotes
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { catalogRemote } from './catalog/contract.ts'
import { usageRemote } from './usage/contract.ts'

/** Every Remote method this package owns, mounted as one contribution. */
const contribution = {
  package: usageRemote.package,
  descriptors: [...usageRemote.descriptors, ...catalogRemote.descriptors],
}

/** Register this package's Remote contribution for the mount's lifetime. */
export function registerRemotes(ctx: Context): void {
  ctx.inject(['typert'], (scope) => {
    scope.effect(() => scope.typert.register({
      package: contribution.package,
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: contribution.descriptors,
    }))
  })
}
