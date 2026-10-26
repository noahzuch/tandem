<script setup lang="ts">
// Vue NodeView for htmlIsland / htmlIslandInline.
// Text editing inside the island (approach (a) from the brief):
//   * HTML text leaves (p, span, figcaption, td, custom element with only text…) get
//     contenteditable="plaintext-only" → native caret, selection, IME, spellcheck-free typing.
//   * SVG <text>/<tspan> can't be contenteditable (Chromium ignores the attribute on SVG; an editable
//     HTML ancestor makes the whole SVG editable and inserts <br> into <text>), so a click opens a
//     positioned HTML overlay over the label, caret at the clicked character (getCharNumAtPosition).
//   * every input → replaceLeafText(source, path, text) → updateAttributes({html}) = one ProseMirror
//     transaction (undo history, later Yjs). Structure is never re-serialised from the DOM.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { renderIsland, shapeOf, SVG_NS } from './islands/render'
import { replaceLeafText } from './islands/source'
import { islandEnv, islandKey } from './islands/env'

const props = defineProps(nodeViewProps)
const host = ref<HTMLElement | null>(null)
const inline = computed(() => props.node.type.name === 'htmlIslandInline')
const shape = computed(() => shapeOf(props.node.attrs.html as string))
const editingSource = ref(false)
const draft = ref('')
const error = ref('')

let shadow: ShadowRoot | null = null
let root: HTMLElement | null = null
/** last html we produced ourselves: an update carrying it must not re-render (would kill the caret) */
let lastLocal: string | null = null
let composing = false

function render() {
  if (!host.value) return
  shadow ??= host.value.attachShadow({ mode: 'open' })
  closeOverlay(false)
  root = renderIsland(shadow, props.node.attrs.html as string, islandEnv.docCss, props.editor.isEditable)
}

function commit(pathAttr: string, text: string) {
  const path = pathAttr === '' ? [] : pathAttr.split('/').map(Number)
  try {
    const html = replaceLeafText(props.node.attrs.html as string, path, text)
    if (html === props.node.attrs.html) return
    lastLocal = html
    props.updateAttributes({ html })
    error.value = ''
  } catch (e) {
    error.value = String(e)
  }
}

// ------------------------------------------------------------ SVG text overlay
let overlay: { el: HTMLElement; target: SVGTextContentElement } | null = null

function openOverlay(target: SVGTextContentElement, clientX: number, clientY: number) {
  if (!root) return
  closeOverlay(false)
  const ov = document.createElement('span')
  ov.className = 'svg-overlay'
  ov.contentEditable = 'plaintext-only'
  ov.spellcheck = false
  ov.dataset.leafPath = target.getAttribute('data-leaf-path') ?? ''
  ov.dataset.testid = 'svg-overlay'
  ov.textContent = target.textContent
  const cs = getComputedStyle(target)
  const scale = target.getScreenCTM()?.a ?? 1
  ov.style.fontFamily = cs.fontFamily
  ov.style.fontSize = `${parseFloat(cs.fontSize) * scale}px`
  ov.style.fontWeight = cs.fontWeight
  root.append(ov)
  overlay = { el: ov, target }
  target.style.opacity = '0'
  place()
  // caret at the clicked character
  let idx = (target.textContent ?? '').length
  const ctm = target.getScreenCTM()
  if (ctm) {
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
    const n = target.getCharNumAtPosition(p)
    if (n >= 0) {
      const ext = target.getExtentOfChar(n)
      idx = p.x > ext.x + ext.width / 2 ? n + 1 : n
    }
  }
  ov.focus()
  const sel = window.getSelection()
  if (sel && ov.firstChild) sel.collapse(ov.firstChild, Math.min(idx, ov.firstChild.textContent!.length))
}

/** keep the overlay centred on the (hidden, live-updated) SVG label */
function place() {
  if (!overlay || !root) return
  const r = overlay.target.getBoundingClientRect()
  const rr = root.getBoundingClientRect()
  const w = overlay.el.offsetWidth
  overlay.el.style.left = `${r.left - rr.left + r.width / 2 - w / 2}px`
  overlay.el.style.top = `${r.top - rr.top + r.height / 2 - overlay.el.offsetHeight / 2}px`
}

function closeOverlay(focusEditor: boolean) {
  if (!overlay) return
  const { el, target } = overlay
  overlay = null
  target.style.opacity = ''
  el.remove()
  if (focusEditor) focusAfter()
}

function focusAfter() {
  const pos = props.getPos()
  if (typeof pos !== 'number') return
  // spike 05 fix: synchronous focus. Tiptap's focus() command defers view.focus() to the next animation frame;
  // if the user clicks into another island leaf before that frame, the late focus pulls the caret back into
  // ProseMirror with the island NodeSelected, and the next keystroke replaces the whole island (found by verify).
  props.editor.commands.setNodeSelection(pos)
  props.editor.view.focus()
}

// ------------------------------------------------------------ events inside the shadow root
function leafOf(e: Event): HTMLElement | null {
  for (const n of e.composedPath()) {
    if (n === root) break
    if (n instanceof Element && n.hasAttribute('data-leaf-path')) return n as HTMLElement
  }
  return null
}

function onInput(e: Event) {
  if (composing) return
  const leaf = leafOf(e)
  if (!leaf) return
  const text = leaf.textContent ?? ''
  if (overlay && leaf === overlay.el) {
    overlay.target.textContent = text
    place()
  }
  commit(leaf.dataset.leafPath ?? leaf.getAttribute('data-leaf-path') ?? '', text)
}

function onKeydown(e: KeyboardEvent) {
  const leaf = leafOf(e)
  if (!leaf) return
  const mod = e.metaKey || e.ctrlKey
  if (e.key === 'Enter' || e.key === 'Escape') {
    // single-line semantics: Enter/Escape leave the text, no <br>/newline inserted
    e.preventDefault()
    if (overlay && leaf === overlay.el) closeOverlay(true)
    else {
      leaf.blur()
      focusAfter()
    }
  } else if (mod && e.key.toLowerCase() === 'z') {
    // the browser's own undo stack of the contenteditable would fight ProseMirror's → route to editor
    e.preventDefault()
    if (e.shiftKey) props.editor.commands.redo()
    else props.editor.commands.undo()
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault()
    props.editor.commands.redo()
  } else if (mod && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
    e.preventDefault() // no formatting inside island text
  }
}

function onMousedown(e: MouseEvent) {
  const t = e.composedPath()[0]
  if (t instanceof Element && t.namespaceURI === SVG_NS && t.hasAttribute('data-leaf-path') && props.editor.isEditable) {
    e.preventDefault()
    openOverlay(t as unknown as SVGTextContentElement, e.clientX, e.clientY)
  }
}

function onClick(e: MouseEvent) {
  // links inside islands must not navigate the editor
  if (e.composedPath().some((n) => n instanceof Element && n.localName === 'a')) e.preventDefault()
}

function onFocusOut(e: FocusEvent) {
  if (overlay && e.target === overlay.el) closeOverlay(false)
  // focus leaves the island (relatedTarget outside the shadow root or null) → release the soft lock
  const next = e.relatedTarget as Node | null
  if (!next || !shadow?.contains(next)) islandEnv.onEditing?.(null)
}

function onFocusIn() {
  // spike 07: tell the other participants (awareness) that the user is inside this island
  islandEnv.onEditing?.(islandKey(props.node.attrs.html as string))
}

onMounted(() => {
  render()
  if (!shadow) return
  shadow.addEventListener('input', onInput)
  shadow.addEventListener('compositionstart', () => (composing = true))
  shadow.addEventListener('compositionend', (e) => {
    composing = false
    onInput(e)
  })
  shadow.addEventListener('keydown', onKeydown as EventListener)
  shadow.addEventListener('mousedown', onMousedown as EventListener)
  shadow.addEventListener('click', onClick as EventListener)
  shadow.addEventListener('focusout', onFocusOut as EventListener)
  shadow.addEventListener('focusin', onFocusIn)
})
onBeforeUnmount(() => closeOverlay(false))

watch(
  () => props.node.attrs.html as string,
  (html) => {
    if (html === lastLocal) return // our own keystroke: DOM is already right, keep the caret
    lastLocal = null
    render() // undo/redo, source edit, remote change
  },
)

// ------------------------------------------------------------ toolbar
function openSource() {
  draft.value = props.node.attrs.html as string
  editingSource.value = true
}
function applySource() {
  lastLocal = null
  props.updateAttributes({ html: draft.value })
  editingSource.value = false
}
</script>

<template>
  <NodeViewWrapper
    :as="inline ? 'span' : 'div'"
    class="island"
    :class="{ 'island-inline': inline, 'island-selected': selected }"
    :data-island-kind="shape.label"
  >
    <span class="island-bar" contenteditable="false" data-island-ui>
      <span class="island-kind">{{ shape.kind === 'html' ? `<${shape.label}>` : shape.label }}</span>
      <button type="button" data-testid="island-source" title="Edit raw HTML" @mousedown.prevent @click="openSource">source</button>
      <button type="button" data-testid="island-delete" title="Delete" @mousedown.prevent @click="deleteNode()">✕</button>
    </span>
    <span ref="host" class="island-host" :data-inline="inline ? '' : undefined" />
    <span v-if="error" class="island-error" contenteditable="false">{{ error }}</span>
    <span v-if="editingSource" class="island-src" contenteditable="false" data-island-ui>
      <textarea v-model="draft" spellcheck="false" data-testid="island-src-text" />
      <span class="island-src-actions">
        <button type="button" data-testid="island-src-apply" @click="applySource">Apply</button>
        <button type="button" @click="editingSource = false">Cancel</button>
      </span>
    </span>
  </NodeViewWrapper>
</template>
