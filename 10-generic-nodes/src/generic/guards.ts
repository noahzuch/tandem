// Spike 10: structure guards for LOCKED generic nodes (round 1's mechanism, kept as the `locked` comparison mode;
// round 2's default protection lives in protect.ts, which also owns the data-generic decorations).
//
//   filterTransaction  a transaction that removes a locked node or changes its structure (children added /
//                      removed / split / merged / retyped) is rejected as a whole, unless it carries the meta
//                      `structure-unlock` (explicit delete widget / block menu) or comes from Yjs (remote)
//                      + AddMarkStep inside a locked node with a mark type not in its allowed list → rejected
//   keymap             Enter / Backspace-at-start / Delete-at-end inside a locked node are no-ops (so the browser
//                      never gets to insert <div>/<br> when every ProseMirror command declines)
//
// What the guards catch and what they don't is measured by verify/matrix.ts.
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { AddMarkStep } from '@tiptap/pm/transform'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import { isGenericType } from './nodes'

export const UNLOCK_META = 'structure-unlock'
export const guardKey = new PluginKey<{ rejected: number; last: string }>('structureLock')

/** structural fingerprint: tag + attrs + child element structure; text, marks and hard breaks are free */
export function structureSig(node: PMNode): string {
  const kids: string[] = []
  node.forEach((c) => {
    if (c.isText || c.type.name === 'hardBreak') return
    kids.push(structureSig(c))
  })
  const own = isGenericType(node.type.name) ? `${node.attrs.tag}${JSON.stringify(node.attrs.attrs ?? {})}` : node.type.name
  return `${own}(${kids.join(',')})`
}

export function lockedAncestor($pos: ResolvedPos): { node: PMNode; depth: number } | null {
  for (let d = $pos.depth; d >= 1; d--) {
    const n = $pos.node(d)
    if (isGenericType(n.type.name) && n.attrs.mode === 'locked') return { node: n, depth: d }
  }
  return null
}

function lockedSigs(doc: PMNode): Map<string, number> {
  const m = new Map<string, number>()
  doc.descendants((n) => {
    if (isGenericType(n.type.name) && n.attrs.mode === 'locked') {
      const s = structureSig(n)
      m.set(s, (m.get(s) ?? 0) + 1)
      return false // children of a locked node are covered by its signature
    }
    return true
  })
  return m
}

/** why a transaction must be rejected, or null */
export function violation(tr: Transaction, state: EditorState): string | null {
  if (!tr.docChanged) return null
  if (tr.getMeta(UNLOCK_META) || tr.getMeta('y-sync$')) return null
  const before = lockedSigs(state.doc)
  if (before.size === 0 && !tr.steps.some((s) => s instanceof AddMarkStep)) return null
  const after = lockedSigs(tr.doc)
  for (const [sig, n] of before) {
    const m = after.get(sig) ?? 0
    if (m < n) return m === 0 && !hasSameTag(after, sig) ? `locked node removed: ${sig.slice(0, 60)}` : `locked node structure changed: ${sig.slice(0, 60)}`
  }
  // marks: AddMarkStep inside a locked node must use an allowed mark type
  for (const step of tr.steps) {
    if (!(step instanceof AddMarkStep)) continue
    const $from = state.doc.resolve(Math.min(step.from, state.doc.content.size))
    const locked = lockedAncestor($from)
    if (!locked) continue
    const allowed = (locked.node.attrs.marks as string[] | null) ?? []
    if (!allowed.includes(step.mark.type.name)) return `mark "${step.mark.type.name}" not allowed in locked <${locked.node.attrs.tag}> (allowed: ${allowed.join(', ') || 'none'})`
  }
  return null
}

const hasSameTag = (m: Map<string, number>, sig: string) => {
  const tag = sig.slice(0, sig.indexOf('{'))
  for (const k of m.keys()) if (k.startsWith(tag)) return true
  return false
}

export const StructureLock = Extension.create({
  name: 'structureLock',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: guardKey,
        state: {
          init: () => ({ rejected: 0, last: '' }),
          apply: (tr, v) => {
            const r = tr.getMeta(guardKey) as string | undefined
            return r ? { rejected: v.rejected + 1, last: r } : v
          },
        },
        filterTransaction: (tr, state) => {
          const why = violation(tr, state)
          if (why) {
            // record for the UI / tests (through a separate transaction, after this one is dropped)
            if (typeof window !== 'undefined') {
              const w = window as unknown as { __guardLog?: string[] }
              ;(w.__guardLog ??= []).push(why)
            }
            return false
          }
          return true
        },
      }),
    ]
  },
  addKeyboardShortcuts() {
    const inLocked = () => lockedAncestor(this.editor.state.selection.$from)
    return {
      Enter: () => {
        const { selection } = this.editor.state
        if (!selection.empty || !inLocked()) return false
        return true // no split, no new block; Shift-Enter still inserts a line break
      },
      Backspace: () => {
        const { selection } = this.editor.state
        const $from = selection.$from
        if (!selection.empty || !inLocked()) return false
        return $from.parentOffset === 0 // at the start of a textblock inside a locked node: nothing to join with
      },
      Delete: () => {
        const { selection } = this.editor.state
        const $from = selection.$from
        if (!selection.empty || !inLocked()) return false
        return $from.parentOffset === $from.parent.content.size
      },
    }
  },
})
