<script setup lang="ts">
// Fixed toolbar: history | block type | marks | link | lists | insert (table picker, more) | panels, help, save.
// ARIA toolbar pattern: one tab stop, ←/→ move between controls, Esc back to the text, Alt+F10 jumps here.
import { computed, ref } from 'vue'
import type { Editor } from '@tiptap/core'
import { Table, Plus, ListTree, Keyboard, Save } from 'lucide-vue-next'
import Dropdown, { type DropdownItem } from './Dropdown.vue'
import TablePicker from './TablePicker.vue'
import { cmd, insertTable, type Cmd } from '../editor/commands'
import { formatShortcut, ui } from './store'

const props = defineProps<{ editor: Editor; status: string; dirty: boolean }>()
const emit = defineEmits<{ save: [] }>()
const bar = ref<HTMLElement | null>(null)
const tableDd = ref<InstanceType<typeof Dropdown> | null>(null)

const tip = (c: Cmd) => (c.shortcut ? `${c.label}  ${formatShortcut(c.shortcut)}` : c.label)
const BLOCKS = ['paragraph', 'h1', 'h2', 'h3', 'h4', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock'].map(cmd)
const MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'highlight'].map(cmd)
const LISTS = ['bulletList', 'orderedList', 'taskList'].map(cmd)
const INSERTS = ['callout', 'calloutWarning', 'details', 'codeBlock', 'hr', 'image', 'island'].map(cmd)

// block type: the most specific active one wins (a heading inside a list item shows "Heading")
const currentBlock = computed(() => {
  const order = ['codeBlock', 'h1', 'h2', 'h3', 'h4', 'taskList', 'orderedList', 'bulletList', 'blockquote', 'paragraph']
  return order.map(cmd).find((c) => c.isActive?.(props.editor)) ?? cmd('paragraph')
})
const blockItems = computed<DropdownItem[]>(() =>
  BLOCKS.map((c) => ({ id: c.id, label: c.label, icon: c.icon, hint: formatShortcut(c.shortcut), active: c === currentBlock.value, run: () => c.run(props.editor) })),
)
const insertItems = computed<DropdownItem[]>(() =>
  INSERTS.map((c) => ({ id: c.id, label: c.label, icon: c.icon, hint: c.markdown?.trim() ?? formatShortcut(c.shortcut), run: () => c.run(props.editor) })),
)
const active = (c: Cmd) => !!c.isActive?.(props.editor)

function onKey(e: KeyboardEvent) {
  const items = Array.from(bar.value?.querySelectorAll<HTMLElement>('[data-tb]') ?? [])
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (i < 0) return
  if (e.key === 'ArrowRight') items[(i + 1) % items.length].focus()
  else if (e.key === 'ArrowLeft') items[(i - 1 + items.length) % items.length].focus()
  else if (e.key === 'Home') items[0].focus()
  else if (e.key === 'End') items[items.length - 1].focus()
  else if (e.key === 'Escape') props.editor.commands.focus()
  else return
  e.preventDefault()
}
function focusFirst() {
  bar.value?.querySelector<HTMLElement>('[data-tb]')?.focus()
}
defineExpose({ focusFirst })
</script>

<template>
  <div ref="bar" class="toolbar" role="toolbar" aria-label="Formatting" data-testid="toolbar" @keydown="onKey">
    <div class="tb-group">
      <button
        v-for="c in [cmd('undo'), cmd('redo')]"
        :key="c.id"
        type="button"
        class="tb-btn"
        :data-tip="tip(c)"
        :aria-label="c.label"
        :aria-keyshortcuts="c.shortcut"
        :data-testid="`tb-${c.id}`"
        :aria-disabled="c.id === 'undo' ? !editor.can().undo() : !editor.can().redo()"
        data-tb
        tabindex="0"
        @mousedown.prevent
        @click="c.run(editor)"
      >
        <component :is="c.icon" :size="17" />
      </button>
    </div>
    <span class="sep" />
    <Dropdown :items="blockItems" tip="Turn into…" testid="tb-blocktype" wide>
      <template #trigger>
        <span class="dd-current" data-testid="tb-blocktype-current">{{ currentBlock.label }}</span>
      </template>
    </Dropdown>
    <span class="sep" />
    <div class="tb-group">
      <button
        v-for="c in MARKS"
        :key="c.id"
        type="button"
        class="tb-btn"
        :class="{ active: active(c) }"
        :aria-pressed="active(c)"
        :data-tip="tip(c)"
        :aria-label="c.label"
        :aria-keyshortcuts="c.shortcut"
        :data-testid="`tb-${c.id}`"
        data-tb
        tabindex="-1"
        @mousedown.prevent
        @click="c.run(editor)"
      >
        <component :is="c.icon" :size="17" />
      </button>
      <button
        type="button"
        class="tb-btn"
        :class="{ active: active(cmd('link')) }"
        :data-tip="tip(cmd('link'))"
        aria-label="Link"
        data-testid="tb-link"
        data-tb
        tabindex="-1"
        @mousedown.prevent
        @click="cmd('link').run(editor)"
      >
        <component :is="cmd('link').icon" :size="17" />
      </button>
    </div>
    <span class="sep" />
    <div class="tb-group">
      <button
        v-for="c in LISTS"
        :key="c.id"
        type="button"
        class="tb-btn"
        :class="{ active: active(c) }"
        :aria-pressed="active(c)"
        :data-tip="tip(c)"
        :aria-label="c.label"
        :data-testid="`tb-${c.id}`"
        data-tb
        tabindex="-1"
        @mousedown.prevent
        @click="c.run(editor)"
      >
        <component :is="c.icon" :size="17" />
      </button>
    </div>
    <span class="sep" />
    <Dropdown ref="tableDd" tip="Insert table" testid="tb-table">
      <template #trigger><Table :size="17" /></template>
      <template #default="{ hide }">
        <TablePicker
          @pick="
            (r: number, c: number) => {
              hide()
              insertTable(editor, r, c)
            }
          "
        />
      </template>
    </Dropdown>
    <Dropdown :items="insertItems" tip="Insert block (or type /)" testid="tb-insert" wide>
      <template #trigger><Plus :size="17" /><span class="dd-current">Insert</span></template>
    </Dropdown>
    <span class="spacer" />
    <span class="status" data-testid="status" :class="{ dirty }">{{ status }}</span>
    <button
      type="button"
      class="tb-btn"
      :class="{ active: ui.outlineOpen }"
      data-tip="Outline"
      aria-label="Toggle outline"
      data-testid="tb-outline"
      data-tb
      tabindex="-1"
      @mousedown.prevent
      @click="ui.outlineOpen = !ui.outlineOpen"
    >
      <ListTree :size="17" />
    </button>
    <button
      type="button"
      class="tb-btn"
      :data-tip="`Keyboard shortcuts  ${formatShortcut('Mod-/')}`"
      aria-label="Keyboard shortcuts"
      data-testid="tb-help"
      data-tb
      tabindex="-1"
      @mousedown.prevent
      @click="ui.helpOpen = !ui.helpOpen"
    >
      <Keyboard :size="17" />
    </button>
    <button
      type="button"
      class="tb-btn save"
      :data-tip="`Save  ${formatShortcut('Mod-s')}`"
      data-testid="save"
      data-tb
      tabindex="-1"
      @mousedown.prevent
      @click="emit('save')"
    >
      <Save :size="16" /> Save
    </button>
  </div>
</template>
