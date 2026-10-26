// Spike 10 round 2: protect generic nodes (and spike 04's Container) the way Tiptap's table protects its cells —
// by shaping what the editing commands do, not by rejecting transactions (that was round 1's StructureLock,
// kept for the `locked` comparison mode in guards.ts).
//
// The pieces, each modelled on prosemirror-tables' tableEditing():
//   isolating: true        on genericBlock / genericTextBlock / container (nodes.ts, extensions.ts) — like a cell:
//                          joinBackward/joinForward (findCutBefore/After), deleteRange (coveredDepths) and the
//                          paste fitter never cross the element's edge. policy.isolating = false measures the cost.
//   keymap                 Backspace at the start of a generic textblock / of the first child of a protected block
//                          and Delete at the end of a generic textblock / of the last child do nothing (a cell's
//                          Backspace at the start of its first paragraph does nothing either). Enter inside a
//                          generic textblock: at the end → paragraph after the element; in the middle → split
//                          with the `id` dropped from the second half; inside a positioned element → <br>.
//                          Escape → select the enclosing element (NodeSelection); Backspace/Delete on that → the
//                          delete UI's confirm (deleteWidget.ts), never a silent removal.
//   selection clamping     appendTransaction: a text selection that starts inside an element and ends outside
//                          (or the reverse) is clamped to the element's edge, like isTextSelectionAcrossCells →
//                          normalizeSelection. Select-all (AllSelection) and NodeSelections are untouched.
//   emptying delete        Backspace / Delete / typing / cut over a text selection that would remove whole
//                          elements deletes the selected TEXT in every textblock instead (deleteCellSelection
//                          empties cells rather than removing them). Removing an element is an explicit act.
//   paste                  handlePaste: block HTML pasted into a generic textblock is flattened to inline content
//                          (paragraphs separated by <br>) so the element is neither split nor filled with blocks.
//   repair                 appendTransaction, like fixTables: duplicate `id`s among generic nodes (after a split /
//                          paste / duplicate-block) are dropped from the later copies.
//
// Every intervention is logged to window.__guardLog as `protect: …` (the interaction matrix reads it).
import { Extension } from '@tiptap/core'
import { AllSelection, NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Fragment, Slice, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { isGenericType } from './nodes'
import { policy } from './policy'

export const protectKey = new PluginKey('protect')

/** block nodes whose structure is protected: generic blocks / textblocks and spike 04's Container */
export const PROTECTED_TYPES = ['genericBlock', 'genericTextBlock', 'container']
export const isProtected = (n: PMNode): boolean => PROTECTED_TYPES.includes(n.type.name)
/** a wall for text selections: block-level protected nodes (a selection may span the textblocks inside one) */
export const isWall = (n: PMNode): boolean => n.type.name === 'genericBlock' || n.type.name === 'container'
/** a textblock that is an element with identity (tag + attributes), as opposed to a paragraph */
export const isElementTextblock = (n: PMNode): boolean => n.type.name === 'genericTextBlock'
/** everything the explicit delete UI handles: protected nodes + islands */
export const isUnit = (n: PMNode): boolean => isProtected(n) || n.type.name === 'htmlIsland' || n.type.name === 'htmlIslandInline'
export const tagOf = (n: PMNode): string => (n.attrs.tag as string | undefined) ?? (n.type.name === 'htmlIsland' || n.type.name === 'htmlIslandInline' ? 'island' : n.type.name)

export function logProtect(msg: string): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as { __guardLog?: string[] }
  ;(w.__guardLog ??= []).push(`protect: ${msg}`)
}

export interface Ancestor {
  node: PMNode
  depth: number
  pos: number
}

/** nearest protected ancestor of $pos (innermost), or null */
export function protectedAncestor($pos: ResolvedPos, maxDepth = $pos.depth): Ancestor | null {
  for (let d = maxDepth; d >= 1; d--) {
    const n = $pos.node(d)
    if (isProtected(n)) return { node: n, depth: d, pos: $pos.before(d) }
  }
  return null
}

const unitCount = (doc: PMNode): number => {
  let n = 0
  doc.descendants((node) => {
    if (isUnit(node)) n++
  })
  return n
}

// ---------------------------------------------------------------- selection clamping
/**
 * Where the head of a text selection must be moved so that the selection does not straddle an element edge:
 *   1. the anchor sits inside a wall that does not contain the head → the content edge of the INNERMOST such wall
 *      (like a cell: a selection started in a grid column stays in that column)
 *   2. the head sits inside a wall that does not contain the anchor → just outside the OUTERMOST such wall
 *      (the selection stops before the element it would enter)
 */
export function clampTarget($anchor: ResolvedPos, $head: ResolvedPos): { pos: number; why: string } | null {
  const dir = $head.pos > $anchor.pos ? 1 : -1
  for (let d = $anchor.depth; d >= 1; d--) {
    const n = $anchor.node(d)
    if (!isWall(n)) continue
    const start = $anchor.start(d)
    const end = $anchor.end(d)
    if ($head.pos >= start && $head.pos <= end) continue
    return { pos: dir > 0 ? end : start, why: `selection clamped to the ${dir > 0 ? 'end' : 'start'} of <${tagOf(n)}> (it started inside)` }
  }
  for (let d = 1; d <= $head.depth; d++) {
    const n = $head.node(d)
    if (!isWall(n)) continue
    const before = $head.before(d)
    const after = $head.after(d)
    if ($anchor.pos >= before && $anchor.pos <= after) continue
    return { pos: dir > 0 ? before : after, why: `selection clamped to ${dir > 0 ? 'before' : 'after'} <${tagOf(n)}> (it started outside)` }
  }
  return null
}

function clampSelection(state: EditorState, tr: Transaction | null): Transaction | null {
  const sel = (tr ?? state).selection
  if (!(sel instanceof TextSelection) || sel.empty) return tr
  const doc = (tr ?? state).doc
  const t = clampTarget(sel.$anchor, sel.$head)
  if (!t) return tr
  const dir = sel.$head.pos > sel.$anchor.pos ? 1 : -1
  const next = TextSelection.between(sel.$anchor, doc.resolve(t.pos), -dir)
  if (next.eq(sel)) return tr
  logProtect(t.why)
  return (tr ?? state.tr).setSelection(next)
}

// ---------------------------------------------------------------- repair: duplicate ids
// Measured in round 2: Tiptap's splitBlock honours `keepOnSplit: false` only when Enter is pressed at the END of a
// block; a split in the middle copies every attribute, so `<p id="t">` / `<h2 id="…">` / a generic element end up
// twice with the same id. The repair keeps the first occurrence (document order) and drops the id from the others.
function dedupeIds(state: EditorState, tr: Transaction | null): Transaction | null {
  const seen = new Set<string>()
  const fixes: { pos: number; node: PMNode; key: 'attrs' | 'htmlAttrs' }[] = []
  state.doc.descendants((node, pos) => {
    const key = isGenericType(node.type.name) ? 'attrs' : 'htmlAttrs'
    const id = (node.attrs[key] as Record<string, string> | null | undefined)?.id
    if (!id) return
    if (seen.has(id)) fixes.push({ pos, node, key })
    else seen.add(id)
  })
  if (!fixes.length) return tr
  tr ??= state.tr
  for (const { pos, node, key } of fixes) {
    const { id, ...rest } = node.attrs[key] as Record<string, string>
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, [key]: Object.keys(rest).length ? rest : null })
    logProtect(`dropped duplicate id="${id}" from a second <${tagOf(node) === node.type.name ? node.type.name : tagOf(node)}>`)
  }
  return tr
}

// ---------------------------------------------------------------- emptying delete
/** delete the selected text in every textblock the selection touches; elements and islands stay */
export function deleteTextOnly(state: EditorState, from: number, to: number): Transaction {
  const ranges: [number, number][] = []
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) {
      const s = Math.max(from, pos + 1)
      const e = Math.min(to, pos + 1 + node.content.size)
      if (e > s) ranges.push([s, e])
      return false
    }
    return true
  })
  const tr = state.tr
  for (const [s, e] of ranges.reverse()) tr.delete(s, e)
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size))))
  return tr
}

/** would ProseMirror's own deleteSelection remove a protected element / island? */
export function defaultDeleteDropsUnits(state: EditorState): number {
  const before = unitCount(state.doc)
  const after = unitCount(state.tr.deleteSelection().doc)
  return before - after
}

/** Backspace / Delete / cut over a text selection: intervene only when the default would drop an element */
function emptyingDelete(view: EditorView, what: string): boolean {
  const { state } = view
  const sel = state.selection
  if (!(sel instanceof TextSelection) || sel.empty) return false
  const dropped = defaultDeleteDropsUnits(state)
  if (dropped <= 0) return false
  view.dispatch(deleteTextOnly(state, sel.from, sel.to).scrollIntoView())
  logProtect(`${what}: deleted the selected text only, ${dropped} element${dropped === 1 ? '' : 's'} kept (removing one is explicit)`)
  return true
}

// ---------------------------------------------------------------- paste into a generic textblock
/** inline content of a slice: every textblock's inline content, separated by hard breaks */
function flattenToInline(slice: Slice, state: EditorState): Fragment {
  const parts: Fragment[] = []
  const walk = (f: Fragment) =>
    f.forEach((n) => {
      if (n.isTextblock) parts.push(n.content)
      else if (n.isInline) parts.push(Fragment.from(n))
      else walk(n.content)
    })
  walk(slice.content)
  const br = state.schema.nodes.hardBreak
  let out = Fragment.empty
  parts.forEach((p, i) => {
    if (i > 0 && br) out = out.append(Fragment.from(br.create()))
    out = out.append(p)
  })
  return out
}

function handlePaste(view: EditorView, _event: ClipboardEvent, slice: Slice): boolean {
  const { state } = view
  const $from = state.selection.$from
  if (!isElementTextblock($from.parent)) return false
  // a single textblock pastes inline anyway (ProseMirror's own rule); only multi-block / block-wrapped content
  // would split the element or push blocks into its parent
  let blocks = 0
  slice.content.forEach((n) => {
    if (n.isBlock) blocks++
  })
  if (blocks <= 1 && slice.content.childCount === 1 && (slice.content.firstChild!.isTextblock || slice.content.firstChild!.isInline)) return false
  const inline = flattenToInline(slice, state)
  view.dispatch(state.tr.replaceSelection(new Slice(inline, 0, 0)).scrollIntoView())
  logProtect(`pasted ${blocks} block${blocks === 1 ? '' : 's'} as text inside <${tagOf($from.parent)}> (line breaks instead of a split)`)
  return true
}

// ---------------------------------------------------------------- keymap helpers
const positioned = (view: EditorView, pos: number): boolean => {
  const dom = view.nodeDOM(pos) as Element | null
  if (!dom || !(dom instanceof Element)) return false
  const p = getComputedStyle(dom).position
  return p === 'absolute' || p === 'fixed'
}

const attrsWithoutId = (attrs: Record<string, unknown>) => {
  const a = (attrs.attrs as Record<string, string> | null) ?? null
  if (!a?.id) return attrs
  const { id: _id, ...rest } = a
  return { ...attrs, attrs: Object.keys(rest).length ? rest : null }
}

export const Protect = Extension.create({
  name: 'protect',
  // registered after StarterKit (so its keymap runs before Tiptap's Keymap: clearNodes / joinBackward /
  // liftEmptyBlock / splitBlock) and before the UI extensions (the slash menu's Suggestion sees Enter first)

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: protectKey,
        props: {
          decorations: (state) => {
            const decos: Decoration[] = []
            state.doc.descendants((n, pos) => {
              if (isGenericType(n.type.name)) decos.push(Decoration.node(pos, pos + n.nodeSize, { 'data-generic': n.attrs.mode, 'data-tag': n.attrs.tag }))
              else if (n.type.name === 'container') decos.push(Decoration.node(pos, pos + n.nodeSize, { 'data-generic': 'container', 'data-tag': n.attrs.tag }))
            })
            return DecorationSet.create(state.doc, decos)
          },
          handlePaste,
          handleTextInput: (view, from, to, text) => {
            if (from === to) return false
            const { state } = view
            if (!(state.selection instanceof TextSelection) || state.selection.from !== from || state.selection.to !== to) return false
            const dropped = defaultDeleteDropsUnits(state)
            if (dropped <= 0) return false
            const tr = deleteTextOnly(state, from, to)
            tr.insertText(text, from)
            view.dispatch(tr.scrollIntoView())
            logProtect(`typing over the selection replaced its text only, ${dropped} element${dropped === 1 ? '' : 's'} kept`)
            return true
          },
          handleDOMEvents: {
            cut: (view, event) => {
              const sel = view.state.selection
              if (!(sel instanceof TextSelection) || sel.empty || defaultDeleteDropsUnits(view.state) <= 0) return false
              const { dom, text } = view.serializeForClipboard(sel.content())
              event.clipboardData?.setData('text/html', dom.innerHTML)
              event.clipboardData?.setData('text/plain', text)
              event.preventDefault()
              return emptyingDelete(view, 'cut')
            },
          },
        },
        appendTransaction: (trs, _old, state) => {
          let tr: Transaction | null = null
          const local = trs.some((t) => t.docChanged && !t.getMeta('y-sync$'))
          if (local) tr = dedupeIds(state, tr)
          return clampSelection(state, tr)
        },
      }),
    ]
  },

  addKeyboardShortcuts() {
    const editor = this.editor
    const armDelete = (pos: number): boolean => {
      const w = (window as unknown as { __deleteWidget?: { arm: (pos: number) => boolean } }).__deleteWidget
      return w ? w.arm(pos) : false
    }
    const backspace = (): boolean => {
      const { state, view } = editor
      const sel = state.selection
      if (sel instanceof NodeSelection && isUnit(sel.node)) {
        logProtect(`Backspace on a selected <${tagOf(sel.node)}>: asking for confirmation instead of deleting`)
        return armDelete(sel.from)
      }
      if (sel instanceof AllSelection) return false
      if (!sel.empty) return emptyingDelete(view, 'Backspace')
      const $c = sel.$from
      if (!$c.parent.isTextblock || $c.parentOffset !== 0) return false
      const parent = $c.parent
      if (isElementTextblock(parent)) {
        const container = $c.node(-1)
        if (parent.content.size === 0 && container.childCount > 1 && parent.attrs.mode !== 'locked') {
          const pos = $c.before()
          const tr = state.tr.delete(pos, pos + parent.nodeSize)
          tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, pos - 1)), -1))
          view.dispatch(tr.scrollIntoView())
          logProtect(`removed the emptied <${tagOf(parent)}> (second Backspace in an empty element)`)
          return true
        }
        logProtect(`Backspace at the start of <${tagOf(parent)}> does not join it into the previous block`)
        return true
      }
      // a plain textblock that is the FIRST direct child of a protected block (deeper structures — list items,
      // blockquotes — keep their own Backspace behaviour; the element's isolating edge stops the join-out anyway)
      const anc = protectedAncestor($c, $c.depth - 1)
      if (anc && anc.depth === $c.depth - 1 && $c.index(anc.depth) === 0) {
        logProtect(`Backspace at the start of the first block inside <${tagOf(anc.node)}> does nothing (no lift, no join out)`)
        return true
      }
      return false
    }
    const del = (): boolean => {
      const { state, view } = editor
      const sel = state.selection
      if (sel instanceof NodeSelection && isUnit(sel.node)) {
        logProtect(`Delete on a selected <${tagOf(sel.node)}>: asking for confirmation instead of deleting`)
        return armDelete(sel.from)
      }
      if (sel instanceof AllSelection) return false
      if (!sel.empty) return emptyingDelete(view, 'Delete')
      const $c = sel.$from
      if (!$c.parent.isTextblock || $c.parentOffset !== $c.parent.content.size) return false
      if (isElementTextblock($c.parent)) {
        logProtect(`Delete at the end of <${tagOf($c.parent)}> does not join the next block into it`)
        return true
      }
      const anc = protectedAncestor($c, $c.depth - 1)
      if (anc && anc.depth === $c.depth - 1 && $c.index(anc.depth) === anc.node.childCount - 1) {
        logProtect(`Delete at the end of the last block inside <${tagOf(anc.node)}> does nothing (the next block is not pulled in)`)
        return true
      }
      return false
    }
    const enter = (): boolean => {
      const { state, view } = editor
      const sel = state.selection
      if (!(sel instanceof TextSelection)) return false
      const $c = sel.$from
      const parent = $c.parent
      if (!parent.isTextblock) return false
      const paragraph = state.schema.nodes.paragraph
      if (isElementTextblock(parent)) {
        if (parent.attrs.mode === 'locked') return false // guards.ts: no-op
        const pos = $c.before()
        if (!sel.empty) {
          // a selection inside the element: delete its text, then act as a cursor
          editor.view.dispatch(deleteTextOnly(state, sel.from, sel.to))
          return enter()
        }
        if (positioned(view, pos)) {
          view.dispatch(state.tr.replaceSelectionWith(state.schema.nodes.hardBreak.create()).scrollIntoView())
          logProtect(`Enter inside the positioned <${tagOf(parent)}> inserts a line break (a split would overlay a copy at the same coordinates)`)
          return true
        }
        const atEnd = $c.parentOffset === parent.content.size
        const atStart = $c.parentOffset === 0
        if (atEnd || parent.content.size === 0) {
          const after = pos + parent.nodeSize
          const tr = state.tr.insert(after, paragraph.create())
          tr.setSelection(TextSelection.create(tr.doc, after + 1))
          view.dispatch(tr.scrollIntoView())
          return true
        }
        if (atStart) {
          view.dispatch(state.tr.insert(pos, paragraph.create()).scrollIntoView())
          return true
        }
        const tr = state.tr.split($c.pos, 1, [{ type: parent.type, attrs: attrsWithoutId(parent.attrs) }])
        view.dispatch(tr.scrollIntoView())
        logProtect(`Enter split <${tagOf(parent)}> in two${(parent.attrs.attrs as Record<string, string> | null)?.id ? ' (id dropped from the second half)' : ''}`)
        return true
      }
      // an empty paragraph inside a protected block: ProseMirror's liftEmptyBlock would lift it out of the
      // element (last child) or SPLIT the element in two (middle child) — a new paragraph is what the user meant
      if (sel.empty && parent.content.size === 0 && parent.type === paragraph && protectedAncestor($c, $c.depth - 1)) {
        return editor.commands.splitBlock()
      }
      return false
    }
    const escape = (): boolean => {
      const { state, view } = editor
      const sel = state.selection
      let anc: Ancestor | null
      if (sel instanceof NodeSelection) {
        if (!isUnit(sel.node)) return false
        const $p = state.doc.resolve(sel.from)
        anc = protectedAncestor($p)
      } else anc = protectedAncestor(sel.$from)
      if (!anc) return false
      view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, anc.pos)).scrollIntoView())
      return true
    }
    return {
      Backspace: backspace,
      'Mod-Backspace': backspace,
      'Shift-Backspace': backspace,
      Delete: del,
      'Mod-Delete': del,
      Enter: enter,
      Escape: escape,
    }
  },
})
