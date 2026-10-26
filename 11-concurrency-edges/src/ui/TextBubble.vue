<script setup lang="ts">
// Bubble menu on a text selection: turn into… | marks | link | Comment, Ask agent (spike 06: open the composer).
import { computed } from 'vue'
import type { Editor } from '@tiptap/core'
import { BubbleMenu } from '@tiptap/vue-3/menus'
import { NodeSelection } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { MessageSquarePlus, Sparkles } from 'lucide-vue-next'
import Dropdown, { type DropdownItem } from './Dropdown.vue'
import { cmd, type Cmd } from '../editor/commands'
import { formatShortcut, ui } from './store'

const props = defineProps<{ editor: Editor }>()
const emit = defineEmits<{ comment: [ask: boolean] }>()
const MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'highlight', 'link'].map(cmd)
const BLOCKS = ['paragraph', 'h1', 'h2', 'h3', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock'].map(cmd)
const tip = (c: Cmd) => (c.shortcut ? `${c.label}  ${formatShortcut(c.shortcut)}` : c.label)
const current = computed(() => ['codeBlock', 'h1', 'h2', 'h3', 'taskList', 'orderedList', 'bulletList', 'blockquote', 'paragraph'].map(cmd).find((c) => c.isActive?.(props.editor)) ?? cmd('paragraph'))
const blockItems = computed<DropdownItem[]>(() => BLOCKS.map((c) => ({ id: c.id, label: c.label, icon: c.icon, active: c === current.value, run: () => c.run(props.editor) })))

const shouldShow = ({ editor, view, state, from, to, element }: { editor: Editor; view: any; state: any; from: number; to: number; element: HTMLElement }) => {
  if (!editor.isEditable || ui.linkEdit) return false
  if (!(view.hasFocus() || element.contains(document.activeElement))) return false
  const sel = state.selection
  if (sel.empty || sel instanceof NodeSelection || sel instanceof CellSelection) return false
  return state.doc.textBetween(from, to).trim().length > 0
}

function comment() {
  emit('comment', false)
}
function askAgent() {
  emit('comment', true)
}
</script>

<template>
  <BubbleMenu :editor="editor" plugin-key="textBubble" :should-show="shouldShow" :update-delay="100" :options="{ placement: 'top', offset: 8 }">
    <div class="bubble text-bubble" data-testid="text-bubble" role="toolbar" aria-label="Selection">
      <Dropdown :items="blockItems" tip="Turn into…" testid="bubble-turninto" wide>
        <template #trigger><span class="dd-current">{{ current.label }}</span></template>
      </Dropdown>
      <span class="sep" />
      <button
        v-for="c in MARKS"
        :key="c.id"
        type="button"
        class="tb-btn"
        :class="{ active: c.isActive?.(editor) }"
        :aria-pressed="!!c.isActive?.(editor)"
        :aria-label="c.label"
        :data-tip="tip(c)"
        :data-testid="`bubble-${c.id}`"
        data-tb
        @mousedown.prevent
        @click="c.run(editor)"
      >
        <component :is="c.icon" :size="16" />
      </button>
      <span class="sep" />
      <button type="button" class="tb-btn labelled" data-tip="Comment  ⌘⌥M" data-testid="bubble-comment" data-tb @mousedown.prevent @click="comment">
        <MessageSquarePlus :size="16" /> Comment
      </button>
      <button type="button" class="tb-btn labelled agent" data-tip="Ask the agent about this (sent right away)" data-testid="bubble-ask" data-tb @mousedown.prevent @click="askAgent">
        <Sparkles :size="16" /> Ask agent
      </button>
    </div>
  </BubbleMenu>
</template>
