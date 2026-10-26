<script setup lang="ts">
// Table context menu: anchored above the table the caret is in (not at the caret, so it never covers the cell).
import type { Editor } from '@tiptap/core'
import { BubbleMenu } from '@tiptap/vue-3/menus'
import { CellSelection } from '@tiptap/pm/tables'
import { cmd, type Cmd } from '../editor/commands'

const props = defineProps<{ editor: Editor }>()
const GROUPS = [
  ['addRowBefore', 'addRowAfter', 'deleteRow'],
  ['addColumnBefore', 'addColumnAfter', 'deleteColumn'],
  ['mergeCells', 'splitCell'],
  ['toggleHeaderRow', 'toggleHeaderColumn'],
  ['deleteTable'],
].map((g) => g.map(cmd))

const can = (c: Cmd): boolean => {
  const k = props.editor.can() as unknown as Record<string, () => boolean>
  return typeof k[c.id] === 'function' ? k[c.id]() : true
}
const isOn = (c: Cmd) =>
  (c.id === 'toggleHeaderRow' && headerRow()) || (c.id === 'toggleHeaderColumn' && headerCol())

function tableDom(): HTMLElement | null {
  const { $from } = props.editor.state.selection
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'table') {
      const dom = props.editor.view.nodeDOM($from.before(d)) as HTMLElement | null
      return dom?.querySelector?.('table') ?? dom
    }
  }
  return null
}
function headerRow() {
  const t = tableDom() as HTMLTableElement | null
  return !!t?.rows?.[0] && Array.from(t.rows[0].cells).every((c) => c.tagName === 'TH')
}
function headerCol() {
  const t = tableDom() as HTMLTableElement | null
  return !!t?.rows?.length && Array.from(t.rows).every((r) => r.cells[0]?.tagName === 'TH')
}

const shouldShow = ({ editor, view, state, element }: { editor: Editor; view: any; state: any; element: HTMLElement }) => {
  if (!editor.isEditable || !editor.isActive('table')) return false
  if (!(view.hasFocus() || element.contains(document.activeElement))) return false
  // a text selection inside a cell gets the text bubble instead
  return state.selection.empty || state.selection instanceof CellSelection
}
const reference = () => {
  const el = tableDom()
  if (!el) return null
  return { getBoundingClientRect: () => el.getBoundingClientRect(), getClientRects: () => el.getClientRects() }
}
</script>

<template>
  <BubbleMenu
    :editor="editor"
    plugin-key="tableMenu"
    :should-show="shouldShow"
    :update-delay="0"
    :get-referenced-virtual-element="reference"
    :options="{ placement: 'top-start', offset: 6, flip: false, shift: { padding: 8 } }"
  >
    <div class="bubble table-bubble" data-testid="table-bubble" role="toolbar" aria-label="Table">
      <template v-for="(g, i) in GROUPS" :key="i">
        <span v-if="i" class="sep" />
        <button
          v-for="c in g"
          :key="c.id"
          type="button"
          class="tb-btn"
          :class="{ active: isOn(c), danger: c.id === 'deleteTable' }"
          :aria-label="c.label"
          :aria-disabled="!can(c)"
          :data-tip="c.label"
          :data-testid="`tbl-${c.id}`"
          data-tb
          @mousedown.prevent
          @click="can(c) && c.run(editor)"
        >
          <component :is="c.icon" :size="16" />
        </button>
      </template>
    </div>
  </BubbleMenu>
</template>
