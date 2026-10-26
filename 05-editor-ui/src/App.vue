<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useEditor, EditorContent, VueNodeViewRenderer } from '@tiptap/vue-3'
import { Selection } from '@tiptap/pm/state'
import { buildExtensions } from './extensions'
import IslandView from './IslandView.vue'
import CodeBlockView from './editor/CodeBlockView.vue'
import { uiExtensions } from './editor/uiExtensions'
import { prepareForEditor, replaceLeafText } from './islands/source'
import { expandIslands } from './islands/raw'
import { islandEnv, extractCss } from './islands/env'
import Toolbar from './ui/Toolbar.vue'
import TextBubble from './ui/TextBubble.vue'
import TableBubble from './ui/TableBubble.vue'
import LinkPopover from './ui/LinkPopover.vue'
import BlockHandle from './ui/BlockHandle.vue'
import Outline from './ui/Outline.vue'
import HelpDialog from './ui/HelpDialog.vue'
import PromptDialog from './ui/PromptDialog.vue'
import { ui } from './ui/store'

// Events inside an island's editable text / toolbar belong to the island, not to ProseMirror.
// (Events from the shadow root are retargeted to the host, so Tiptap's default target checks miss them.)
const islandView = VueNodeViewRenderer(IslandView, {
  stopEvent: ({ event }) =>
    event
      .composedPath()
      .some((n) => n instanceof Element && (n.hasAttribute('data-leaf-path') || n.hasAttribute('data-island-ui'))),
})
const codeBlockView = VueNodeViewRenderer(CodeBlockView)

const docPath = ref('')
const status = ref('loading…')
const dirty = ref(false)
const islandStats = ref<{ blockIslands: number; inlineIslands: number; comments: number } | null>(null)
const toolbar = ref<InstanceType<typeof Toolbar> | null>(null)
const outline = ref<InstanceType<typeof Outline> | null>(null)
const docStyle = document.createElement('style')
docStyle.id = 'doc-css'
document.head.append(docStyle)

const editor = useEditor({
  extensions: buildExtensions({ islandView, codeBlockView, ui: uiExtensions }),
  content: '',
  editorProps: {
    attributes: { spellcheck: 'true', 'aria-label': 'Document' },
    // keep the caret clear of the sticky toolbar and the fixed status bar when ProseMirror scrolls it into view
    scrollMargin: { top: 72, bottom: 64, left: 0, right: 0 },
    scrollThreshold: { top: 72, bottom: 64, left: 0, right: 0 },
  },
  onUpdate: () => {
    dirty.value = true
    status.value = 'Unsaved changes'
  },
})

const counts = computed(() => {
  const ed = editor.value
  if (!ed) return null
  const cc = ed.storage.characterCount
  const { from, to, empty } = ed.state.selection
  const selWords = empty ? 0 : ed.state.doc.textBetween(from, to, ' ', ' ').split(/\s+/).filter(Boolean).length
  return { words: cc.words(), chars: cc.characters(), selWords }
})

async function load() {
  const res = await fetch('/doc')
  const doc = await res.json()
  docPath.value = doc.path
  // The editor only owns <body>; <head> (title, <style>, meta) stays on disk untouched.
  islandEnv.docCss = extractCss(doc.head)
  docStyle.textContent = `@scope (.tiptap) {\n${islandEnv.docCss.replace(/:root\b/g, ':scope')}\n}`
  const title = /<title>([^<]*)<\/title>/i.exec(doc.head)?.[1]
  if (title) document.title = `${title} · spike 05`
  const prepared = prepareForEditor(doc.body)
  islandStats.value = prepared.stats
  const ed = editor.value!
  ed.commands.setContent(prepared.html, { emitUpdate: false })
  // caret at the start (setContent leaves a NodeSelection on the last island)
  ed.view.dispatch(ed.state.tr.setSelection(Selection.atStart(ed.state.doc)).setMeta('addToHistory', false))
  outline.value?.collect()
  dirty.value = false
  status.value = 'Saved'
}

async function save() {
  if (!editor.value) return
  status.value = 'Saving…'
  const res = await fetch('/doc', { method: 'PUT', headers: { 'content-type': 'text/html' }, body: editor.value.getHTML() })
  if (res.ok) {
    dirty.value = false
    status.value = `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  } else status.value = `Save failed: ${res.status}`
}

/** ←/→ inside a floating menu, Esc back to the text */
function rove(container: HTMLElement, e: KeyboardEvent) {
  const items = Array.from(container.querySelectorAll<HTMLElement>('[data-tb]'))
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (e.key === 'ArrowRight') items[(i + 1) % items.length]?.focus()
  else if (e.key === 'ArrowLeft') items[(i - 1 + items.length) % items.length]?.focus()
  else if (e.key === 'Escape') editor.value?.commands.focus()
  else return
  e.preventDefault()
}

function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented) return // already handled by the editor keymap (e.g. Mod-/ inside the text)
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void save()
  } else if (e.altKey && e.key === 'F10') {
    e.preventDefault()
    const floating = document.querySelector<HTMLElement>('.text-bubble [data-tb], .table-bubble [data-tb]')
    if (floating) floating.focus()
    else toolbar.value?.focusFirst()
  } else if (mod && e.key === '/' && !editor.value?.isFocused) {
    e.preventDefault()
    ui.helpOpen = !ui.helpOpen
  } else if (e.key === '?' && !editor.value?.isFocused && !(e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable]')) {
    ui.helpOpen = true
  } else {
    const bubble = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('.text-bubble, .table-bubble')
    if (bubble && !(document.activeElement as HTMLElement).closest('.dd-panel')) rove(bubble, e)
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  while (!editor.value) await new Promise((r) => setTimeout(r, 10))
  ;(window as unknown as { __editor: unknown }).__editor = editor.value
  ;(window as unknown as { __islands: unknown }).__islands = { prepareForEditor, expandIslands, replaceLeafText }
  await load()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="app" :class="{ 'outline-open': ui.outlineOpen }">
    <Toolbar v-if="editor" ref="toolbar" :editor="editor" :status="status" :dirty="dirty" @save="save" />
    <div class="workspace">
      <aside v-if="editor && ui.outlineOpen" class="side">
        <Outline ref="outline" :editor="editor" />
      </aside>
      <main class="page">
        <EditorContent :editor="editor" />
        <template v-if="editor">
          <TextBubble :editor="editor" />
          <TableBubble :editor="editor" />
          <BlockHandle :editor="editor" />
        </template>
      </main>
    </div>
    <footer class="statusbar" data-testid="statusbar">
      <span class="docpath" :title="docPath">{{ docPath }}</span>
      <span v-if="islandStats" data-testid="island-stats" class="muted">
        islands: {{ islandStats.blockIslands }} block · {{ islandStats.inlineIslands }} inline · {{ islandStats.comments }} comments
      </span>
      <span class="spacer" />
      <span v-if="counts" data-testid="word-count">
        <template v-if="counts.selWords">{{ counts.selWords }} of </template>{{ counts.words }} words · {{ counts.chars }} characters
      </span>
    </footer>
    <LinkPopover v-if="editor" :editor="editor" />
    <HelpDialog v-if="ui.helpOpen" />
    <PromptDialog v-if="ui.dialog" :key="ui.dialog.title" />
    <div v-if="ui.toast" class="toast" role="status" data-testid="toast">{{ ui.toast }}</div>
  </div>
</template>
