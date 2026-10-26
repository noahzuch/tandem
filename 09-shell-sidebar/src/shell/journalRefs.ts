// Spike 09: journal references in the spec. "D-3" / "F-12" in the text (and links to "journal#D-3" or "#D-3") are
// decorated — never written into the HTML — when that id exists in the journal panel. Hover = the entry's summary,
// click = the journal tab opens and scrolls to the entry (the caret still lands where clicked: editing stays normal).
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { REF } from './journal'

export const journalRefsKey = new PluginKey<DecorationSet>('journalRefs')
/** journal#D-4, decisions.md#D4, #D-4 */
const LINK_REF = /#([FDQR])-?(\d{1,4})$/

export interface JournalRefsOptions {
  /** id → summary of the entries that exist right now */
  lookup: () => Map<string, { summary: string }>
  onJump: (id: string) => void
}

function build(doc: PMNode, known: Map<string, { summary: string }>) {
  if (!known.size) return DecorationSet.empty
  const decos: Decoration[] = []
  const deco = (from: number, to: number, id: string) =>
    decos.push(Decoration.inline(from, to, { class: 'jref', 'data-jref': id, title: `${id}: ${known.get(id)!.summary} (click: show in the journal)` }))
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    if (node.marks.some((m) => m.type.name === 'code')) return
    const link = node.marks.find((m) => m.type.name === 'link')
    const lm = link ? LINK_REF.exec(String(link.attrs.href ?? '')) : null
    if (lm) {
      const id = `${lm[1]}-${Number(lm[2])}`
      if (known.has(id)) return void deco(pos, pos + node.nodeSize, id)
    }
    for (const m of node.text.matchAll(REF)) {
      const id = `${m[1]}-${Number(m[2])}`
      if (known.has(id)) deco(pos + m.index!, pos + m.index! + m[0].length, id)
    }
  })
  return DecorationSet.create(doc, decos)
}

export const JournalRefs = Extension.create<JournalRefsOptions>({
  name: 'journalRefs',
  addOptions() {
    return { lookup: () => new Map(), onJump: () => {} }
  },
  addProseMirrorPlugins() {
    const opts = this.options
    return [
      new Plugin<DecorationSet>({
        key: journalRefsKey,
        state: {
          init: (_, state) => build(state.doc, opts.lookup()),
          apply: (tr, old) => (tr.docChanged || tr.getMeta(journalRefsKey) ? build(tr.doc, opts.lookup()) : old),
        },
        props: {
          decorations: (state) => journalRefsKey.getState(state),
          handleClick: (_view, _pos, event) => {
            const el = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('.jref[data-jref]')
            if (el) opts.onJump(el.dataset.jref!)
            return false
          },
        },
      }),
    ]
  },
})
