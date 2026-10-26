<script setup lang="ts">
// Popup for the `/` suggestion. Positioned by @tiptap/suggestion's own floating-ui mount().
import { computed, nextTick, ref, watch } from 'vue'
import type { Editor } from '@tiptap/core'
import type { Cmd } from '../editor/commands'
import { formatShortcut } from './store'

const props = defineProps<{ items: Cmd[]; command: (c: Cmd) => void; editor: Editor; query: string }>()
const selected = ref(0)
const list = ref<HTMLElement | null>(null)

const GROUP_LABEL: Record<string, string> = { block: 'Turn into / insert', insert: 'Insert', table: 'Table', mark: 'Format', move: 'Block', history: 'History' }
const groups = computed(() => {
  const out: { name: string; items: { cmd: Cmd; index: number }[] }[] = []
  props.items.forEach((cmd, index) => {
    const name = GROUP_LABEL[cmd.group] ?? cmd.group
    let g = out.find((x) => x.name === name)
    if (!g) out.push((g = { name, items: [] }))
    g.items.push({ cmd, index })
  })
  return out
})

watch(
  () => props.items,
  () => (selected.value = 0),
)
watch(selected, async () => {
  await nextTick()
  list.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
})

function pick(i: number) {
  const item = props.items[i]
  if (item) props.command(item)
}

function onKeyDown(e: KeyboardEvent): boolean {
  const n = props.items.length
  if (!n) return false
  if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
    selected.value = (selected.value + 1) % n
    return true
  }
  if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
    selected.value = (selected.value + n - 1) % n
    return true
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    pick(selected.value)
    return true
  }
  return false
}
defineExpose({ onKeyDown })
</script>

<template>
  <div class="menu slash-menu" data-testid="slash-menu" role="listbox" ref="list">
    <template v-if="items.length">
      <template v-for="g in groups" :key="g.name">
        <div class="menu-group">{{ g.name }}</div>
        <button
          v-for="{ cmd, index } in g.items"
          :key="cmd.id"
          type="button"
          role="option"
          class="menu-item"
          :data-testid="`slash-${cmd.id}`"
          :aria-selected="index === selected"
          @mousedown.prevent
          @mouseenter="selected = index"
          @click="pick(index)"
        >
          <component :is="cmd.icon" v-if="cmd.icon" :size="16" class="menu-icon" />
          <span class="menu-label">{{ cmd.label }}</span>
          <span class="menu-hint">{{ cmd.markdown ? cmd.markdown.trim() : formatShortcut(cmd.shortcut) }}</span>
        </button>
      </template>
    </template>
    <div v-else class="menu-empty">No command for “{{ query }}”</div>
  </div>
</template>
