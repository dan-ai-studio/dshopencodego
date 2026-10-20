/**
 * Whether a string is an address a socket can be sent to.
 *
 * The page checks this before it writes, so a typo is caught while the
 * person is still looking at the field. The Host checks it again — the page
 * is a convenience, not the authority — and an address that fails there is
 * ignored, leaving the request on the system's own resolution.
 *
 * The rules are the ones a resolver itself uses, so an address accepted
 * here is one the resolver would accept too: no octal reading of `010`, no
 * empty group, no more than one `::`.
 *
 * @module @dan-ai-studio/dshopencodego/client/address
 */

/**
 * Whether the value is a dotted-quad address.
 *
 * Each part is a decimal number below 256, written without a leading zero:
 * `010` is read as octal by some resolvers and as ten by others, so it is
 * not an address at all.
 * @param value - the candidate.
 * @returns true when it is a dotted quad.
 */
function isDottedQuad(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  return parts.every(part => {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return false
    return Number(part) <= 255
  })
}

/**
 * Whether the value is an IPv6 address.
 *
 * Eight groups of hexadecimal digits, or fewer when `::` stands for the
 * groups it replaces. A trailing dotted quad counts as two groups, the way
 * it is written everywhere else.
 * @param value - the candidate.
 * @returns true when it is an IPv6 address.
 */
function isIPv6(value: string): boolean {
  if (!value.includes(':')) return false
  // A zone names the interface a link-local address belongs to. Node accepts
  // it, so the page accepts it too: a field the Host would take and the page
  // refuses is a field the person cannot set.
  const zone = value.indexOf('%')
  const address = zone === -1 ? value : value.slice(0, zone)
  if (zone !== -1) {
    const name = value.slice(zone + 1)
    if (name.length === 0 || name.includes('%')) return false
  }
  const halves = address.split('::')
  // Two `::` would leave no way to tell how many groups each one replaces.
  if (halves.length > 2) return false
  const groups = (part: string): string[] => (part.length === 0 ? [] : part.split(':'))
  const head = groups(halves[0] ?? '')
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : []
  const all = [...head, ...tail]
  let count = 0
  for (const [index, group] of all.entries()) {
    // A dotted quad is only ever the last group, and it takes two slots.
    if (group.includes('.')) {
      if (index !== all.length - 1) return false
      if (!isDottedQuad(group)) return false
      count += 2
      continue
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false
    count += 1
  }
  // Without `::` every group is written out; with it, at least one is
  // replaced — so fewer than eight may remain.
  return halves.length === 2 ? count <= 7 : count === 8
}

/**
 * Whether the value is an address a socket can be sent to.
 * @param value - the candidate, as typed.
 * @returns true when it is an IPv4 or an IPv6 address.
 */
export function isAddress(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  return isDottedQuad(trimmed) || isIPv6(trimmed)
}
