<script setup lang="ts">
// Link popover. View mode (caret inside a link): URL · open · edit · remove.
// Edit mode (⌘K, toolbar, bubble, "edit"): URL input, Enter applies, Esc cancels.
// '#anchor' links jump to the heading inside the editor instead of opening a tab.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Editor } from '@tiptap/core'
import { computePosition, flip, offset, shift } from '@floating-ui/dom'
import { ExternalLink, Pencil, Link2Off, Check } from 'lucide-vue-next'
import { ui, formatShortcut } from './store'

const props = defineProps<{ editor: Editor }>()
const el = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const mode = ref<'hidden' | 'view' | 'edit'>('hidden')
const href = ref('')
const draft = ref('')

function inLink() {
  return props.editor.isActive('link')
}

function refresh() {
  if (ui.linkEdit) {
    if (mode.value !== 'edit') {
      href.value = (props.editor.getAttributes('link').href as string) ?? ''
      draft.value = href.value || ''
      mode.value = 'edit'
      void nextTick(() => {
        input.value?.focus()
        input.value?.select()
      })
    }
  } else if (props.editor.state.selection.empty && inLink() && props.editor.isFocused) {
    href.value = props.editor.getAttributes('link').href as string
    mode.value = 'view'
  } else if (mode.value === 'view' && el.value?.contains(document.activeElement)) {
    // focus moved into the popover (keyboard) → keep it
  } else {
    mode.value = 'hidden'
  }
  void nextTick(place)
}

async function place() {
  if (mode.value === 'hidden' || !el.value) return
  const view = props.editor.view
  const { from, to } = props.editor.state.selection
  const a = view.coordsAtPos(from)
  const b = view.coordsAtPos(to)
  const reference = {
    getBoundingClientRect: () => new DOMRect(Math.min(a.left, b.left), a.top, Math.abs(b.right - a.left) || 1, b.bottom - a.top),
  }
  const { x, y } = await computePosition(reference, el.value, { strategy: 'fixed', placement: 'bottom-start', middleware: [offset(6), flip(), shift({ padding: 8 })] })
  Object.assign(el.value.style, { left: `${x}px`, top: `${y}px` })
}

function apply() {
  const url = draft.value.trim()
  const chain = props.editor.chain().focus()
  if (!url) chain.extendMarkRange('link').unsetLink().run()
  else if (props.editor.state.selection.empty && !inLink()) chain.insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run()
  else chain.extendMarkRange('link').setLink({ href: url }).run()
  close()
}
function close() {
  ui.linkEdit = false
  mode.value = 'hidden'
  props.editor.commands.focus()
}
function remove() {
  props.editor.chain().focus().extendMarkRange('link').unsetLink().run()
  close()
}
function edit() {
  ui.linkEdit = true
}
function open() {
  const url = href.value
  if (url.startsWith('#')) {
    const target = props.editor.view.dom.querySelector(`[id="${CSS.escape(url.slice(1))}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  window.open(url, '_blank', 'noopener')
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  } else if (e.key === 'Enter' && mode.value === 'edit') {
    e.preventDefault()
    apply()
  }
}

watch(() => ui.linkEdit, refresh)
/** clicking back into the text while editing = cancel */
function onEditorFocus() {
  if (mode.value === 'edit') {
    ui.linkEdit = false
    mode.value = 'hidden'
  }
  refresh()
}
const onScroll = () => void place()
onMounted(() => {
  props.editor.on('selectionUpdate', refresh)
  props.editor.on('focus', onEditorFocus)
  props.editor.on('blur', () => setTimeout(refresh, 0))
  window.addEventListener('scroll', onScroll, true)
})
onBeforeUnmount(() => {
  props.editor.off('selectionUpdate', refresh)
  window.removeEventListener('scroll', onScroll, true)
})
</script>

<template>
  <div v-show="mode !== 'hidden'" ref="el" class="bubble link-popover" data-testid="link-popover" :data-mode="mode" @keydown="onKey">
    <template v-if="mode === 'edit'">
      <input ref="input" v-model="draft" class="link-input" type="url" placeholder="https://… or #heading-id" aria-label="Link URL" data-testid="link-input" />
      <button type="button" class="tb-btn" data-tip="Apply  ↵" aria-label="Apply" data-testid="link-apply" @mousedown.prevent @click="apply"><Check :size="16" /></button>
      <button v-if="inLink()" type="button" class="tb-btn" data-tip="Remove link" aria-label="Remove link" @mousedown.prevent @click="remove"><Link2Off :size="16" /></button>
    </template>
    <template v-else-if="mode === 'view'">
      <a class="link-href" :href="href" :title="href" data-testid="link-href" @click.prevent="open">{{ href }}</a>
      <span class="sep" />
      <button type="button" class="tb-btn" :data-tip="href.startsWith('#') ? 'Jump to section' : 'Open in new tab'" aria-label="Open link" data-testid="link-open" @mousedown.prevent @click="open"><ExternalLink :size="16" /></button>
      <button type="button" class="tb-btn" :data-tip="`Edit link  ${formatShortcut('Mod-k')}`" aria-label="Edit link" data-testid="link-edit" @mousedown.prevent @click="edit"><Pencil :size="16" /></button>
      <button type="button" class="tb-btn" data-tip="Remove link" aria-label="Remove link" data-testid="link-remove" @mousedown.prevent @click="remove"><Link2Off :size="16" /></button>
    </template>
  </div>
</template>
