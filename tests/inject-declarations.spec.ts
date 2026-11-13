/**
 * Every Remote namespace the settings page reads must be declared in the
 * client `inject` list.
 *
 * Cordis refuses an undeclared service read with `cannot get property "…"
 * without inject` instead of answering `undefined`, so a missing declaration
 * is not a soft failure: the call throws. `remote.opencodeGoUpdate` was
 * missing for three releases and hid the update panel behind a blank row;
 * `remote.pluginManager` was missing too, which would have broken the
 * one-click update the moment anyone pressed it. This spec reads the two
 * files as text and pins the relationship so the next namespace cannot be
 * forgotten the same way.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CLIENT_INDEX = 'src/client/index.ts'
const SECTION = 'src/client/Section.tsx'

/** Dotted `remote.*` names declared in the client inject list. */
function declaredNamespaces(): Set<string> {
  const source = readFileSync(CLIENT_INDEX, 'utf8')
  const names = new Set<string>()
  for (const match of source.matchAll(/'(remote\.[A-Za-z0-9_]+)'/g)) names.add(match[1]!)
  return names
}

/** Dotted `remote.*` names the settings page's service contract reads. */
function usedNamespaces(): Set<string> {
  const source = readFileSync(SECTION, 'utf8')
  const contract = /export interface SectionServices \{[\s\S]*?\n\}/.exec(source)
  if (contract === null) throw new Error(`could not locate SectionServices in ${SECTION}`)
  // Only the properties inside the nested `remote: { … }` block are Remote
  // namespaces; the contract's own `remote` and `scope` fields are not.
  const block = /readonly remote:\s*\{([\s\S]*?)\n {2}\}/.exec(contract[0])
  if (block === null) throw new Error(`could not locate the remote block in ${SECTION}`)
  const names = new Set<string>()
  for (const match of block[1]!.matchAll(/readonly\s+([A-Za-z0-9_]+)\??:/g)) {
    names.add(`remote.${match[1]!}`)
  }
  return names
}

describe('client inject declarations', () => {
  it('declares every Remote namespace the settings page reads', () => {
    const declared = declaredNamespaces()
    const used = [...usedNamespaces()].toSorted()
    expect(used.length).toBeGreaterThan(0)
    expect(used.filter(name => !declared.has(name))).toEqual([])
  })

  it('declares every Remote namespace the client entry itself reads', () => {
    // The entry file reads namespaces directly too (`scope.remote.…` inside
    // its own inject callbacks). Collecting the declarations and the reads
    // from the same source catches a namespace that is read but never
    // declared anywhere in the file — the shape of the defect this spec was
    // written for.
    const source = readFileSync(CLIENT_INDEX, 'utf8')
    const declared = new Set<string>()
    for (const call of source.matchAll(/\.inject\(\s*\[([^\]]*)\]/g)) {
      for (const name of call[1]!.matchAll(/'(remote\.[A-Za-z0-9_]+)'/g)) declared.add(name[1]!)
    }
    const read = new Set<string>()
    // Any receiver name, not just `scope`: nested inject callbacks receive
    // their own parameter (e.g. `managerScope.remote.pluginManager`).
    for (const use of source.matchAll(/\b[A-Za-z]*[Ss]cope\.remote\.([A-Za-z0-9_]+)/g)) {
      read.add(`remote.${use[1]!}`)
    }
    expect(read.size).toBeGreaterThan(0)
    expect([...read].toSorted().filter(name => !declared.has(name))).toEqual([])
  })

  it('the page really does read the namespaces this contract claims', () => {
    // A contract entry nobody reads would let the spec above pass while the
    // page silently stops using a namespace.
    const section = readFileSync(SECTION, 'utf8')
    for (const name of usedNamespaces()) {
      const property = name.slice('remote.'.length)
      expect(section).toContain(`this.services.remote.${property}`)
    }
  })
})
