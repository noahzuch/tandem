// spike 06 (found by verify): workaround for a caret bug in @tiptap/y-tiptap 3.0.10.
//
// When a REMOTE change arrives, the sync plugin restores the local selection from relative positions
// (restoreRelativeSelection) — correct — but then runs `recoverSelectionEndpoint`, whose
// `isMisresolvedAfterStructuralChange` returns true whenever the caret's paragraph text changed
// (`$old.parent.textContent !== $new.parent.textContent`). It then falls back to the OLD OFFSET inside the block.
// Effect: the agent inserts/deletes text BEFORE the user's caret in the same paragraph → the caret jumps by that many
// characters and the user's next keystrokes land in the wrong place (char-by-char agent typing before the caret even
// reverses the user's word: " durable" → " duraelb"). Measured A/B in experiments/typing-race.ts.
//
// Fix: keep our own relative selection (computed after every view update, when Yjs has the local state) and, after a
// remote y-sync transaction, re-apply it if it resolves (deleted text / structural changes resolve to null → we leave
// y-tiptap's recovery alone).
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type * as Y from 'yjs'
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap'

interface Binding {
  doc: Y.Doc
  type: Y.XmlFragment
  mapping: Map<unknown, unknown>
}
const bindingOf = (state: import('@tiptap/pm/state').EditorState) => (ySyncPluginKey.getState(state) as { binding?: Binding } | undefined)?.binding ?? null

export const caretFixKey = new PluginKey('collabCaretFix')
export const caretFixStats = { corrected: 0 }

export const CollabCaretFix = Extension.create({
  name: 'collabCaretFix',
  addProseMirrorPlugins() {
    let rel: { anchor: Y.RelativePosition; head: Y.RelativePosition } | null = null
    return [
      new Plugin({
        key: caretFixKey,
        view: () => ({
          update(view) {
            const b = bindingOf(view.state)
            const sel = view.state.selection
            if (!b || !(sel instanceof TextSelection)) {
              rel = null
              return
            }
            try {
              rel = {
                anchor: absolutePositionToRelativePosition(sel.anchor, b.type, b.mapping as never),
                head: absolutePositionToRelativePosition(sel.head, b.type, b.mapping as never),
              }
            } catch {
              rel = null
            }
          },
        }),
        appendTransaction(trs, _old, state) {
          if (!rel || !trs.some((tr) => (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin && tr.docChanged)) return null
          const b = bindingOf(state)
          if (!b || !(state.selection instanceof TextSelection)) return null
          const anchor = relativePositionToAbsolutePosition(b.doc, b.type, rel.anchor, b.mapping as never)
          const head = relativePositionToAbsolutePosition(b.doc, b.type, rel.head, b.mapping as never)
          if (anchor === null || head === null || anchor > state.doc.content.size || head > state.doc.content.size) return null
          if (anchor === state.selection.anchor && head === state.selection.head) return null
          caretFixStats.corrected++
          return state.tr.setSelection(TextSelection.between(state.doc.resolve(anchor), state.doc.resolve(head))).setMeta('addToHistory', false)
        },
      }),
    ]
  },
})
