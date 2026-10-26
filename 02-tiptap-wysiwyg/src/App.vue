<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import { buildExtensions } from './extensions'

const docPath = ref('')
const status = ref('loading…')
const dirty = ref(false)

const editor = useEditor({
  extensions: buildExtensions(),
  content: '',
  onUpdate: () => {
    dirty.value = true
    status.value = 'unsaved changes'
  },
})

async function load() {
  const res = await fetch('/doc')
  const doc = await res.json()
  docPath.value = doc.path
  // The editor only owns <body>; <head> (title, <style>, meta) stays on disk untouched.
  editor.value?.commands.setContent(doc.body, { emitUpdate: false })
  dirty.value = false
  status.value = 'loaded'
}

async function save() {
  if (!editor.value) return
  status.value = 'saving…'
  const res = await fetch('/doc', {
    method: 'PUT',
    headers: { 'content-type': 'text/html' },
    body: editor.value.getHTML(),
  })
  if (res.ok) {
    dirty.value = false
    status.value = `saved ${new Date().toLocaleTimeString()}`
  } else {
    status.value = `save failed: ${res.status}`
  }
}

function setLink() {
  const prev = editor.value?.getAttributes('link').href as string | undefined
  const href = window.prompt('Link URL (empty to remove)', prev ?? 'https://')
  if (href === null) return
  const chain = editor.value!.chain().focus().extendMarkRange('link')
  if (href === '') chain.unsetLink().run()
  else chain.setLink({ href }).run()
}

function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault()
    void save()
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  ;(window as unknown as { __editor: unknown }).__editor = editor
  // wait until useEditor has created the instance
  while (!editor.value) await new Promise((r) => setTimeout(r, 10))
  ;(window as unknown as { __editor: unknown }).__editor = editor.value
  await load()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

type Btn = { label: string; title: string; id: string; run: () => void; active?: () => boolean }
const e = () => editor.value!.chain().focus()
const buttons: (Btn | '|')[] = [
  { id: 'bold', label: 'B', title: 'Bold', run: () => e().toggleBold().run(), active: () => !!editor.value?.isActive('bold') },
  { id: 'italic', label: 'I', title: 'Italic', run: () => e().toggleItalic().run(), active: () => !!editor.value?.isActive('italic') },
  { id: 'underline', label: 'U', title: 'Underline', run: () => e().toggleUnderline().run(), active: () => !!editor.value?.isActive('underline') },
  { id: 'strike', label: 'S', title: 'Strike', run: () => e().toggleStrike().run(), active: () => !!editor.value?.isActive('strike') },
  { id: 'code', label: '<>', title: 'Inline code', run: () => e().toggleCode().run(), active: () => !!editor.value?.isActive('code') },
  { id: 'highlight', label: 'HL', title: 'Highlight', run: () => e().toggleHighlight().run(), active: () => !!editor.value?.isActive('highlight') },
  { id: 'link', label: '🔗', title: 'Link', run: setLink, active: () => !!editor.value?.isActive('link') },
  '|',
  { id: 'p', label: 'P', title: 'Paragraph', run: () => e().setParagraph().run(), active: () => !!editor.value?.isActive('paragraph') },
  { id: 'h1', label: 'H1', title: 'Heading 1', run: () => e().toggleHeading({ level: 1 }).run(), active: () => !!editor.value?.isActive('heading', { level: 1 }) },
  { id: 'h2', label: 'H2', title: 'Heading 2', run: () => e().toggleHeading({ level: 2 }).run(), active: () => !!editor.value?.isActive('heading', { level: 2 }) },
  { id: 'h3', label: 'H3', title: 'Heading 3', run: () => e().toggleHeading({ level: 3 }).run(), active: () => !!editor.value?.isActive('heading', { level: 3 }) },
  '|',
  { id: 'ul', label: '• List', title: 'Bullet list', run: () => e().toggleBulletList().run(), active: () => !!editor.value?.isActive('bulletList') },
  { id: 'ol', label: '1. List', title: 'Numbered list', run: () => e().toggleOrderedList().run(), active: () => !!editor.value?.isActive('orderedList') },
  { id: 'task', label: '☑ Tasks', title: 'Task list', run: () => e().toggleTaskList().run(), active: () => !!editor.value?.isActive('taskList') },
  { id: 'quote', label: '❝', title: 'Blockquote', run: () => e().toggleBlockquote().run(), active: () => !!editor.value?.isActive('blockquote') },
  { id: 'codeblock', label: '{ }', title: 'Code block', run: () => e().toggleCodeBlock().run(), active: () => !!editor.value?.isActive('codeBlock') },
  { id: 'hr', label: '―', title: 'Horizontal rule', run: () => e().setHorizontalRule().run() },
  { id: 'table', label: '▦', title: 'Insert 3×3 table', run: () => e().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  '|',
  { id: 'left', label: '⇤', title: 'Align left', run: () => e().setTextAlign('left').run() },
  { id: 'center', label: '↔', title: 'Align center', run: () => e().setTextAlign('center').run() },
  '|',
  { id: 'undo', label: '↶', title: 'Undo', run: () => e().undo().run() },
  { id: 'redo', label: '↷', title: 'Redo', run: () => e().redo().run() },
]
</script>

<template>
  <div class="shell">
    <div class="toolbar" role="toolbar">
      <template v-for="(b, i) in buttons" :key="i">
        <span v-if="b === '|'" class="sep" />
        <button
          v-else
          type="button"
          :data-testid="`tb-${b.id}`"
          :title="b.title"
          :class="{ active: b.active?.() }"
          @mousedown.prevent
          @click="b.run()"
        >
          {{ b.label }}
        </button>
      </template>
      <span class="spacer" />
      <span class="status" data-testid="status" :class="{ dirty }">{{ status }}</span>
      <button type="button" class="save" data-testid="save" @click="save">Save (⌘S)</button>
    </div>
    <div class="docpath">{{ docPath }}</div>
    <EditorContent :editor="editor" class="page" />
  </div>
</template>
