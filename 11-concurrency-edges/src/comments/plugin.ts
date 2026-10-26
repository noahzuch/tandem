// Comment highlights as ProseMirror DECORATIONS (anchoring model (b)): nothing is written into the document.
//
// Ranges come from the thread anchors (Y.RelativePosition in Y.Map('comments')) resolved through y-tiptap's
// Y type → PM node mapping. Same update strategy as y-prosemirror's cursor plugin:
//   * remote y-sync transaction, comments map changed, or our own meta → recompute from Yjs (exact)
//   * local transaction (the user types) → map the existing ranges through tr.mapping (Yjs has not seen the change
//     yet: the binding writes it to Y in view.update, after apply). Edges map "inclusive", like the anchors.
//   * no timers: every extra dispatch while the user types races ProseMirror's DOM observer (a keystroke whose DOM
//     mutation is not read yet gets its caret reset — found by verify), so we dispatch only when anchors/status change
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import type * as Y from 'yjs'
import { allThreads, blockContext, makeAnchor, resolveAll, resolveAnchor, textAround, threadsOf, type Kind, type Resolved, type Target } from './model'
import { comments } from './store'

export const commentsKey = new PluginKey<CommentsState>('comments')
const PENDING = '__pending'

interface CommentsState {
  ranges: Map<string, Resolved | null>
  decos: DecorationSet
}

function mappingOf(state: EditorState) {
  const s = ySyncPluginKey.getState(state) as { binding?: { mapping: Map<unknown, unknown> } } | undefined
  return s?.binding?.mapping ?? null
}

function decorate(state: EditorState, ranges: Map<string, Resolved | null>): DecorationSet {
  const decos: Decoration[] = []
  const byId = new Map(comments.threads.map((t) => [t.id, t]))
  for (const [id, r] of ranges) {
    if (!r || r.to > state.doc.content.size) continue
    const t = byId.get(id)
    const pending = id === PENDING
    if (!pending && (!t || (t.status === 'resolved' && !comments.showResolved))) continue
    const kind = pending ? 'pending' : t!.kind
    const cls = ['cmt', `cmt-${kind}`, t?.status === 'resolved' ? 'cmt-resolved' : '', t && t.delivery === 'review' && t.sentSeq == null ? 'cmt-draft' : ''].filter(Boolean).join(' ')
    const target: Target = pending ? comments.composer!.target : t!.target
    const node = state.doc.nodeAt(r.from)
    if (target !== 'text' && node && r.from + node.nodeSize === r.to) {
      decos.push(Decoration.node(r.from, r.to, { class: `${cls} cmt-node`, 'data-thread': id }, { thread: id, leaf: pending ? comments.composer!.leaf?.path : t!.leaf?.path }))
    } else {
      decos.push(Decoration.inline(r.from, r.to, { class: cls, 'data-thread': id }, { thread: id, inclusiveStart: true, inclusiveEnd: true }))
    }
  }
  return DecorationSet.create(state.doc, decos)
}

function compute(state: EditorState, ydoc: Y.Doc): CommentsState {
  const mapping = mappingOf(state)
  if (!mapping) return { ranges: new Map(), decos: DecorationSet.empty }
  const ranges = resolveAll(ydoc, state.doc, mapping as never)
  if (comments.composer) ranges.set(PENDING, resolveAnchor(ydoc, mapping as never, comments.composer.anchor))
  return { ranges, decos: decorate(state, ranges) }
}

export interface CommentsOptions {
  ydoc: Y.Doc | null
}

export const Comments = Extension.create<CommentsOptions>({
  name: 'comments',
  addOptions: () => ({ ydoc: null }),
  addProseMirrorPlugins() {
    const ydoc = this.options.ydoc!
    return [
      new Plugin<CommentsState>({
        key: commentsKey,
        state: {
          init: () => ({ ranges: new Map(), decos: DecorationSet.empty }),
          apply(tr: Transaction, prev, _old, newState) {
            const y = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined
            if (tr.getMeta(commentsKey)?.recompute || y?.isChangeOrigin) return compute(newState, ydoc)
            if (!tr.docChanged) return prev
            const ranges = new Map<string, Resolved | null>()
            for (const [id, r] of prev.ranges) {
              if (!r) ranges.set(id, null)
              else {
                const from = tr.mapping.map(r.from, -1)
                const to = tr.mapping.map(r.to, 1)
                ranges.set(id, to > from ? { from, to } : null)
              }
            }
            return { ranges, decos: decorate(newState, ranges) }
          },
        },
        props: {
          decorations: (state) => commentsKey.getState(state)?.decos ?? null,
          handleClick(view, _pos, event) {
            const el = (event.target as HTMLElement | null)?.closest?.('[data-thread]')
            const id = el?.getAttribute('data-thread')
            if (id && id !== PENDING) comments.active = id
            return false
          },
        },
        view(view) {
          const recompute = () => {
            if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(commentsKey, { recompute: true }).setMeta('addToHistory', false))
          }
          // only what changes the decorations (anchor, status, kind, draft state) triggers a recompute; replies don't
          let signature = ''
          const syncThreads = () => {
            comments.threads = allThreads(ydoc)
            const sig = JSON.stringify(comments.threads.map((t) => [t.id, t.anchor, t.status, t.kind, t.delivery, t.sentSeq == null]))
            if (sig === signature) return
            signature = sig
            // a Y observer may fire inside a Yjs transaction: dispatch outside of it
            setTimeout(recompute, 0)
          }
          threadsOf(ydoc).observeDeep(syncThreads)
          syncThreads()
          let last: Map<string, Resolved | null> | null = null
          return {
            update(v) {
              const st = commentsKey.getState(v.state)
              if (st && st.ranges !== last) {
                last = st.ranges
                comments.ranges = st.ranges
                comments.version++
              }
            },
            destroy() {
              threadsOf(ydoc).unobserveDeep(syncThreads)
            },
          }
        },
      }),
    ]
  },
})

/** re-run decorations after a UI-only change (showResolved, composer opened/closed) */
export function refreshComments(editor: Editor) {
  editor.view.dispatch(editor.state.tr.setMeta(commentsKey, { recompute: true }).setMeta('addToHistory', false))
}

/** open the composer for [from, to) of the current editor doc */
export function openComposer(editor: Editor, ydoc: Y.Doc, from: number, to: number, opts: { target: Target; kind: Kind; ask: boolean; leaf?: { path: string; text: string } | null }) {
  const mapping = mappingOf(editor.state)
  if (!mapping) return
  const doc = editor.state.doc
  const ctx = textAround(doc, from, to)
  const block = blockContext(doc, from)
  comments.composer = {
    target: opts.target,
    anchor: makeAnchor(ydoc, mapping as never, from, to),
    quote: opts.target === 'text' ? ctx.quote : (opts.leaf?.text ?? block.blockText.slice(0, 200)),
    prefix: opts.target === 'text' ? ctx.prefix : '',
    suffix: opts.target === 'text' ? ctx.suffix : '',
    blockId: block.blockId,
    leaf: opts.leaf ?? null,
    kind: opts.kind,
    ask: opts.ask,
  }
  comments.active = null
  refreshComments(editor)
}
