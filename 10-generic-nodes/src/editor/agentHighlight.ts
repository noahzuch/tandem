// spike 07: briefly highlight blocks that a REMOTE participant (the agent) changed.
//
// A y-sync transaction (isChangeOrigin) replaces the changed part of the document. We compare the top-level
// blocks of the old and new state by block id (data-bid): a block whose id is new, or whose node is not .eq()
// to the block with the same id before, gets a node decoration `.agent-changed` for ~2.5 s. The decoration
// carries the remote user's colour/name (awareness) as CSS custom properties, so the fade is in "their" colour.
// Who exactly made a given update is not known to Yjs (updates carry client ids, not users); when several
// remote peers are present we label it with the first one. Good enough for "the agent just touched this".
import { Extension } from '@tiptap/core'
import { isChangeOrigin } from '@tiptap/extension-collaboration'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

export interface AgentHighlightOptions {
  /** who is on the other end right now (name + colour), or null if nobody */
  remoteUser?: () => { name: string; color: string } | null
  /** called with the changed block texts (for the status bar / tests) */
  onRemoteChange?: (blocks: { bid: string | null; type: string; text: string }[]) => void
  durationMs?: number
}

export const agentHighlightKey = new PluginKey<{ decos: DecorationSet; seq: number }>('agentHighlight')

function changedTopBlocks(oldDoc: PMNode, newDoc: PMNode): { from: number; to: number; node: PMNode }[] {
  const oldById = new Map<string, PMNode>()
  const oldByIndex: PMNode[] = []
  oldDoc.forEach((n) => {
    oldByIndex.push(n)
    if (n.attrs.bid) oldById.set(n.attrs.bid, n)
  })
  const out: { from: number; to: number; node: PMNode }[] = []
  newDoc.forEach((n, pos, index) => {
    const prev = n.attrs.bid ? oldById.get(n.attrs.bid) : oldByIndex[index]
    if (!prev || !prev.eq(n)) out.push({ from: pos, to: pos + n.nodeSize, node: n })
  })
  return out
}

export const AgentHighlight = Extension.create<AgentHighlightOptions>({
  name: 'agentHighlight',
  addOptions: () => ({ durationMs: 2500 }),
  addProseMirrorPlugins() {
    const opts = this.options
    const scheduled = new Set<number>()
    return [
      new Plugin({
        key: agentHighlightKey,
        state: {
          init: () => ({ decos: DecorationSet.empty, seq: 0 }),
          apply(tr, prev, oldState: EditorState, newState: EditorState) {
            let decos = prev.decos.map(tr.mapping, tr.doc)
            let seq = prev.seq
            const expire = tr.getMeta(agentHighlightKey)?.expire as number | undefined
            if (expire !== undefined) decos = decos.remove(decos.find(undefined, undefined, (spec) => spec.seq === expire))
            // a y-sync transaction that is not the user's own undo/redo (those also come back through Yjs)
            const ySync = tr.getMeta('y-sync$') as { isUndoRedoOperation?: boolean } | undefined
            // …and not the initial render of the server's document into the empty editor (found by the first screenshot:
            // every block lit up as "remote")
            const initialLoad = oldState.doc.childCount <= 1 && oldState.doc.textContent === ''
            if (tr.docChanged && isChangeOrigin(tr) && !ySync?.isUndoRedoOperation && !initialLoad) {
              const changed = changedTopBlocks(oldState.doc, newState.doc)
              if (changed.length) {
                seq++
                const user = opts.remoteUser?.() ?? null
                const color = user?.color ?? '#7a4fc4'
                decos = decos.add(
                  newState.doc,
                  changed.map((c) =>
                    Decoration.node(c.from, c.to, { class: 'agent-changed', style: `--agent-color:${color}`, 'data-agent-name': user?.name ?? 'remote' }, { seq }),
                  ),
                )
                opts.onRemoteChange?.(changed.map((c) => ({ bid: c.node.attrs.bid ?? null, type: c.node.type.name, text: c.node.textContent.slice(0, 60) })))
              }
            }
            return { decos, seq }
          },
        },
        view: (view) => ({
          update: () => {
            const st = agentHighlightKey.getState(view.state)
            if (!st) return
            for (const d of st.decos.find()) {
              const seq = d.spec.seq as number
              if (scheduled.has(seq)) continue
              scheduled.add(seq)
              setTimeout(() => {
                scheduled.delete(seq)
                if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(agentHighlightKey, { expire: seq }).setMeta('addToHistory', false))
              }, opts.durationMs)
            }
          },
        }),
        props: {
          decorations: (state) => agentHighlightKey.getState(state)?.decos ?? null,
        },
      }),
    ]
  },
})
