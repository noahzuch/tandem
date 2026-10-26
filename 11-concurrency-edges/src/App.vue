<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useEditor, EditorContent, VueNodeViewRenderer } from '@tiptap/vue-3'
import { Selection } from '@tiptap/pm/state'
import * as Y from 'yjs'
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider'
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
import { ui, toast } from './ui/store'
// spike 06: comments
import CommentsPanel from './comments/CommentsPanel.vue'
import { Comments, openComposer } from './comments/plugin'
import { comments } from './comments/store'
import { caretFixStats } from './editor/caretFix'
import * as commentModel from './comments/model'
import { TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { DocInfo } from './main'

const props = defineProps<{ info: DocInfo }>()

// Events inside an island's editable text / toolbar belong to the island, not to ProseMirror.
// (Events from the shadow root are retargeted to the host, so Tiptap's default target checks miss them.)
const islandView = VueNodeViewRenderer(IslandView, {
  // spike 06: Tiptap's Vue NodeView does not pass new decorations to the component when only the decorations change
  // (same node → it updates the wrapper classes only). Comment highlights on a label need them → always update props.
  update: ({ oldNode, newNode, updateProps }) => {
    if (oldNode.type !== newNode.type) return false
    updateProps()
    return true
  },
  stopEvent: ({ event }) =>
    event
      .composedPath()
      .some((n) => n instanceof Element && (n.hasAttribute('data-leaf-path') || n.hasAttribute('data-island-ui'))),
})
const codeBlockView = VueNodeViewRenderer(CodeBlockView)

// ---------------------------------------------------------------- spike 07: Y.Doc + Hocuspocus provider
export interface Peer {
  clientId: number
  name: string
  color: string
  /** has a caret in the document right now */
  active: boolean
}
const PALETTE = ['#2a7de1', '#1f9d55', '#c2410c', '#9333ea', '#be185d', '#0f766e']
const params = new URLSearchParams(location.search)
const me = {
  name: params.get('user') ?? 'You',
  color: params.get('color') ?? PALETTE[Math.floor(Math.random() * PALETTE.length)],
}
const ydoc = new Y.Doc()
const provider = new HocuspocusProvider({
  url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`,
  name: props.info.name,
  document: ydoc,
})
const connection = ref<'connecting' | 'connected' | 'disconnected'>('connecting')
const synced = ref(false)
const unsynced = ref(0)
const peers = shallowRef<Peer[]>([])
/** blocks a remote peer changed recently (status bar + tests) */
const remoteChanges = ref<{ at: number; by: string; blocks: string[] }[]>([])
provider.on('status', ({ status }: { status: WebSocketStatus }) => (connection.value = status))
provider.on('synced', () => {
  synced.value = true
  // the Y.Doc arrived from the server (seeded there — the browser never setContent()s); the sync plugin has
  // rendered it by the time this macrotask runs
  setTimeout(() => {
    const ed = editor.value
    if (!ed || firstSyncDone) return
    firstSyncDone = true
    ed.view.dispatch(ed.state.tr.setSelection(Selection.atStart(ed.state.doc)).setMeta('addToHistory', false))
    islandStats.value = countIslands()
    outline.value?.collect()
  }, 0)
})
let firstSyncDone = false
provider.on('unsyncedChanges', ({ number }: { number: number }) => (unsynced.value = number))
const refreshPeers = () => {
  const list: Peer[] = []
  for (const [clientId, state] of provider.awareness!.getStates()) {
    if (clientId === ydoc.clientID) continue
    const u = (state as { user?: { name: string; color: string }; cursor?: unknown }).user
    if (!u) continue
    list.push({ clientId, name: u.name, color: u.color, active: !!(state as { cursor?: unknown }).cursor })
  }
  peers.value = list
}
provider.awareness!.on('change', refreshPeers)
const remoteUser = () => {
  const p = peers.value.find((x) => x.active) ?? peers.value[0]
  return p ? { name: p.name, color: p.color } : null
}

const docPath = ref(props.info.path)
const islandStats = ref<{ blockIslands: number; inlineIslands: number; comments: number } | null>(null)

// ---------------------------------------------------------------- spike 06: comments
// "agent: listening" — the server broadcasts presence as a Hocuspocus stateless message when a `collab wait` starts/ends
provider.on('stateless', ({ payload }: { payload: string }) => {
  try {
    const msg = JSON.parse(payload) as { type?: string; listening?: string[] }
    if (msg.type === 'presence') comments.listening = msg.listening ?? []
  } catch {
    /* not ours */
  }
})
async function fetchPresence() {
  try {
    comments.listening = ((await (await fetch('/api/presence')).json()) as { listening: string[] }).listening
  } catch {
    /* server restarting */
  }
}
provider.on('synced', () => void fetchPresence())

function commentOnSelection(ask: boolean) {
  const ed = editor.value
  if (!ed) return
  const { from, to, empty } = ed.state.selection
  if (empty || !(ed.state.selection instanceof TextSelection)) return toast('Select some text first')
  openComposer(ed, ydoc, from, to, { target: 'text', kind: ask ? 'question' : 'comment', ask })
}
function commentOnBlock(pos: number, node: PMNode) {
  const ed = editor.value
  if (!ed) return
  openComposer(ed, ydoc, pos, pos + node.nodeSize, { target: node.type.name.startsWith('htmlIsland') ? 'island' : 'block', kind: 'comment', ask: false })
}
islandEnv.onComment = (pos, leaf) => {
  const ed = editor.value
  const node = ed?.state.doc.nodeAt(pos)
  if (!ed || !node) return
  openComposer(ed, ydoc, pos, pos + node.nodeSize, { target: 'island', kind: 'comment', ask: false, leaf })
}
const toolbar = ref<InstanceType<typeof Toolbar> | null>(null)
const outline = ref<InstanceType<typeof Outline> | null>(null)
const docStyle = document.createElement('style')
docStyle.id = 'doc-css'
document.head.append(docStyle)

const editor = useEditor({
  extensions: buildExtensions({
    islandView,
    codeBlockView,
    ui: params.has('nocomments') ? uiExtensions : [...uiExtensions, Comments.configure({ ydoc })], // ?nocomments = A/B for debugging
    collab: {
      document: ydoc,
      provider,
      user: me,
      caretFix: !params.has('nocaretfix'), // ?nocaretfix = A/B (experiments/typing-race.ts)
      highlight: {
        remoteUser,
        onRemoteChange: (blocks) => {
          remoteChanges.value = [{ at: Date.now(), by: remoteUser()?.name ?? 'remote', blocks: blocks.map((b) => b.bid ?? b.type) }, ...remoteChanges.value].slice(0, 20)
        },
      },
    },
  }),
  editorProps: {
    attributes: { spellcheck: 'true', 'aria-label': 'Document' },
    // keep the caret clear of the sticky toolbar and the fixed status bar when ProseMirror scrolls it into view
    scrollMargin: { top: 72, bottom: 64, left: 0, right: 0 },
    scrollThreshold: { top: 72, bottom: 64, left: 0, right: 0 },
  },
})

function countIslands() {
  const ed = editor.value
  if (!ed) return null
  let blockIslands = 0
  let inlineIslands = 0
  let comments = 0
  ed.state.doc.descendants((n) => {
    if (n.type.name === 'htmlIsland') String(n.attrs.html).trimStart().startsWith('<!--') ? comments++ : blockIslands++
    if (n.type.name === 'htmlIslandInline') String(n.attrs.html).trimStart().startsWith('<!--') ? comments++ : inlineIslands++
  })
  return { blockIslands, inlineIslands, comments }
}

const counts = computed(() => {
  const ed = editor.value
  if (!ed) return null
  const cc = ed.storage.characterCount
  const { from, to, empty } = ed.state.selection
  const selWords = empty ? 0 : ed.state.doc.textBetween(from, to, ' ', ' ').split(/\s+/).filter(Boolean).length
  return { words: cc.words(), chars: cc.characters(), selWords }
})

/** save state for the toolbar: the server persists on its own (debounced); ⌘S flushes now */
const status = computed(() => {
  if (connection.value !== 'connected') return connection.value === 'connecting' ? 'Connecting…' : 'Offline — edits are kept locally'
  if (!synced.value) return 'Syncing…'
  if (unsynced.value > 0) return 'Syncing…'
  return 'Synced · saved by the server'
})
const dirty = computed(() => connection.value !== 'connected' || unsynced.value > 0)

async function save() {
  await fetch('/doc/flush', { method: 'POST' })
}

// soft lock: "Noah is editing inside <figure class="diagram">" → the agent CLI waits / refuses to rewrite that island
islandEnv.onEditing = (key) => provider.awareness!.setLocalStateField('island', key)

function applyDocCss() {
  // The editor only owns <body>; <head> (title, <style>, meta) stays on disk untouched.
  islandEnv.docCss = extractCss(props.info.head)
  docStyle.textContent = `@scope (.tiptap) {\n${islandEnv.docCss.replace(/:root\b/g, ':scope')}\n}`
  const title = /<title>([^<]*)<\/title>/i.exec(props.info.head)?.[1]
  if (title) document.title = `${title} · spike 11`
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
  if (mod && e.altKey && e.code === 'KeyM') {
    e.preventDefault()
    commentOnSelection(false)
  } else if (mod && e.key.toLowerCase() === 's') {
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
  applyDocCss()
  window.addEventListener('keydown', onKey)
  while (!editor.value) await new Promise((r) => setTimeout(r, 10))
  const w = window as unknown as Record<string, unknown>
  w.__editor = editor.value
  w.__provider = provider
  w.__ydoc = ydoc
  w.__islands = { prepareForEditor, expandIslands, replaceLeafText }
  w.__collab = { peers, remoteChanges, me }
  w.__comments = { store: comments, model: commentModel, ydoc }
  w.__caretFix = caretFixStats
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  provider.destroy()
})
</script>

<template>
  <div class="app" :class="{ 'outline-open': ui.outlineOpen, composing: !!comments.composer }">
    <Toolbar v-if="editor" ref="toolbar" :editor="editor" :status="status" :dirty="dirty" :peers="peers" :me="me" :connection="connection" @save="save" />
    <div class="workspace">
      <aside v-if="editor && ui.outlineOpen" class="side">
        <Outline ref="outline" :editor="editor" />
      </aside>
      <main class="page">
        <EditorContent :editor="editor" />
        <template v-if="editor">
          <TextBubble :editor="editor" @comment="commentOnSelection" />
          <TableBubble :editor="editor" />
          <BlockHandle :editor="editor" @comment="commentOnBlock" />
        </template>
      </main>
      <CommentsPanel v-if="editor" :editor="editor" :ydoc="ydoc" :me="me" />
    </div>
    <footer class="statusbar" data-testid="statusbar">
      <span class="docpath" :title="docPath">{{ docPath }}</span>
      <span v-if="islandStats" data-testid="island-stats" class="muted">
        islands: {{ islandStats.blockIslands }} block · {{ islandStats.inlineIslands }} inline · {{ islandStats.comments }} html comments
      </span>
      <span v-if="remoteChanges.length" class="muted" data-testid="remote-changes">
        last remote change: {{ remoteChanges[0].by }} → {{ remoteChanges[0].blocks.join(', ') }}
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
