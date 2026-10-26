<script setup lang="ts">
// Outline built from the document's headings (own ~60 lines instead of @tiptap/extension-table-of-contents,
// which writes a data-toc-id attribute into every heading — that would end up in the saved HTML).
// Click / Enter: caret to the heading + smooth scroll. The current section is highlighted while scrolling.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Editor } from '@tiptap/core'

const props = defineProps<{ editor: Editor }>()
interface Item {
  level: number
  text: string
  pos: number
  id: string | null
}
const items = ref<Item[]>([])
const activePos = ref<number | null>(null)

function collect() {
  const out: Item[] = []
  props.editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      out.push({ level: node.attrs.level, text: node.textContent || '(empty heading)', pos, id: (node.attrs.htmlAttrs?.id as string) ?? null })
      return false
    }
    return node.type.name !== 'table' && !node.isAtom
  })
  items.value = out
  updateActive()
}

function domFor(pos: number): HTMLElement | null {
  const dom = props.editor.view.nodeDOM(pos)
  return dom instanceof HTMLElement ? dom : null
}

function updateActive() {
  let current: number | null = null
  for (const it of items.value) {
    const el = domFor(it.pos)
    if (el && el.getBoundingClientRect().top < 140) current = it.pos
  }
  activePos.value = current ?? items.value[0]?.pos ?? null
}

function go(index: number) {
  const it = items.value[index]
  if (!it) return
  const el = domFor(it.pos)
  props.editor.chain().focus(undefined, { scrollIntoView: false }).setTextSelection(it.pos + 1 + it.text.length).run()
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  activePos.value = it.pos
}

// synchronous on every doc change: a debounced list showed stale positions right after an edit (verify caught it).
// Walking the headings of a spec-sized doc is well under a millisecond.
const onUpdate = () => collect()
onMounted(() => {
  props.editor.on('update', onUpdate)
  props.editor.on('create', collect)
  window.addEventListener('scroll', updateActive, { passive: true })
  collect()
})
onBeforeUnmount(() => {
  props.editor.off('update', onUpdate)
  window.removeEventListener('scroll', updateActive)
})
defineExpose({ collect })
const minLevel = () => Math.min(...items.value.map((i) => i.level), 6)
</script>

<template>
  <nav class="outline" aria-label="Outline" data-testid="outline">
    <div class="outline-title">Outline</div>
    <ol v-if="items.length">
      <li v-for="(it, i) in items" :key="it.pos" :style="{ paddingLeft: `${(it.level - minLevel()) * 12}px` }">
        <a
          href="#"
          :class="{ active: it.pos === activePos, [`lvl-${it.level}`]: true }"
          :data-testid="`outline-${it.id ?? it.pos}`"
          @click.prevent="go(i)"
        >
          {{ it.text }}
        </a>
      </li>
    </ol>
    <p v-else class="outline-empty">Headings appear here.</p>
  </nav>
</template>
