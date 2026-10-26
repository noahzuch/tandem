<script setup lang="ts">
// Block handle (MIT @tiptap/extension-drag-handle-vue-3): "+" inserts a block below (opens the slash menu),
// the grip drags the block; clicking the grip opens a block menu (turn into, move, duplicate, delete).
import { nextTick, onBeforeUnmount, ref } from 'vue'
import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { DragHandle } from '@tiptap/extension-drag-handle-vue-3'
import { GripVertical, MessageSquarePlus, Plus } from 'lucide-vue-next'
import { cmd } from '../editor/commands'
import { formatShortcut } from './store'

const props = defineProps<{ editor: Editor }>()
// spike 06: "Comment on block" — the composer is owned by App.vue
const emit = defineEmits<{ comment: [pos: number, node: PMNode] }>()
function commentBlock() {
  const c = current.value
  closeMenu(false)
  if (c) emit('comment', c.pos, c.node)
}
const current = ref<{ node: PMNode; pos: number } | null>(null)
const menuOpen = ref(false)
const menu = ref<HTMLElement | null>(null)

function onNodeChange({ node, pos }: { node: PMNode | null; pos: number }) {
  if (menuOpen.value) return
  current.value = node ? { node, pos } : null
}

const lock = (locked: boolean) => props.editor.view.dispatch(props.editor.state.tr.setMeta('lockDragHandle', locked))

/** 'node': NodeSelection (move/duplicate/delete act on the whole block); 'text': its text (turn into) */
function selectCurrent(kind: 'node' | 'text'): boolean {
  const c = current.value
  if (!c) return false
  const { state } = props.editor
  const node = state.doc.nodeAt(c.pos)
  if (!node) return false
  const sel =
    kind === 'text' && !node.isAtom
      ? TextSelection.between(state.doc.resolve(c.pos + 1), state.doc.resolve(c.pos + node.nodeSize - 1))
      : NodeSelection.create(state.doc, c.pos)
  props.editor.view.dispatch(state.tr.setSelection(sel))
  return true
}

function insertBelow() {
  const c = current.value
  if (!c) return
  const at = c.pos + c.node.nodeSize
  props.editor
    .chain()
    .insertContentAt(at, { type: 'paragraph', content: [{ type: 'text', text: '/' }] })
    .setTextSelection(at + 2)
    .focus()
    .run()
}

async function toggleMenu() {
  if (menuOpen.value) return closeMenu()
  if (!selectCurrent('node')) return
  menuOpen.value = true
  lock(true)
  document.addEventListener('mousedown', outside, true)
  await nextTick()
  menu.value?.querySelector<HTMLElement>('[data-menu-item]')?.focus()
}
function closeMenu(refocus = true) {
  menuOpen.value = false
  lock(false)
  document.removeEventListener('mousedown', outside, true)
  if (refocus) props.editor.commands.focus()
}
function outside(e: MouseEvent) {
  if (!menu.value?.contains(e.target as Node)) closeMenu(false)
}
onBeforeUnmount(() => document.removeEventListener('mousedown', outside, true))

const ACTIONS = ['moveUp', 'moveDown', 'duplicate', 'deleteBlock'].map(cmd)
const TURN = ['paragraph', 'h1', 'h2', 'h3', 'bulletList', 'taskList', 'blockquote', 'codeBlock'].map(cmd)
function run(id: string) {
  const c = cmd(id)
  selectCurrent(c.group === 'block' ? 'text' : 'node')
  closeMenu()
  c.run(props.editor)
}
function onMenuKey(e: KeyboardEvent) {
  const items = Array.from(menu.value?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus()
  else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus()
  else if (e.key === 'Escape') closeMenu()
  else return
  e.preventDefault()
}
</script>

<template>
  <DragHandle :editor="editor" :on-node-change="onNodeChange" class="block-handle">
    <div class="bh-inner" data-testid="block-handle">
      <button type="button" class="bh-btn" data-tip="Insert block below" aria-label="Insert block below" data-testid="bh-plus" @mousedown.prevent @click="insertBelow">
        <Plus :size="16" />
      </button>
      <button type="button" class="bh-btn grip" data-tip="Drag to move · click for menu" aria-label="Block menu" data-testid="bh-grip" @click="toggleMenu">
        <GripVertical :size="16" />
      </button>
      <div v-if="menuOpen" ref="menu" class="menu block-menu" data-testid="block-menu" role="menu" @keydown="onMenuKey" @mousedown.stop>
        <template v-if="current?.node.isTextblock || current?.node.type.name.endsWith('List')">
          <div class="menu-group">Turn into</div>
          <button v-for="c in TURN" :key="c.id" type="button" class="menu-item" data-menu-item :data-testid="`bm-${c.id}`" @mousedown.prevent @click="run(c.id)">
            <component :is="c.icon" :size="16" class="menu-icon" /><span class="menu-label">{{ c.label }}</span>
          </button>
          <div class="menu-sep" />
        </template>
 <button type="button" class="menu-item" data-menu-item data-testid="bm-comment" @mousedown.prevent @click="commentBlock">
          <MessageSquarePlus :size="16" class="menu-icon" /><span class="menu-label">Comment on block</span>
        </button>
        <button v-for="c in ACTIONS" :key="c.id" type="button" class="menu-item" :class="{ danger: c.id === 'deleteBlock' }" data-menu-item :data-testid="`bm-${c.id}`" @mousedown.prevent @click="run(c.id)">
          <component :is="c.icon" :size="16" class="menu-icon" /><span class="menu-label">{{ c.label }}</span>
          <span class="menu-hint">{{ formatShortcut(c.shortcut) }}</span>
        </button>
      </div>
    </div>
  </DragHandle>
</template>
