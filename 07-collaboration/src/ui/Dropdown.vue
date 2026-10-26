<script setup lang="ts">
// Menu button: click / Enter / ↓ opens, ↑↓ move, Enter picks, Esc closes (focus back to the trigger).
import { nextTick, onBeforeUnmount, ref, type Component } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

export interface DropdownItem {
  id: string
  label: string
  icon?: Component
  hint?: string
  active?: boolean
  run: () => void
}

const props = defineProps<{ items?: DropdownItem[]; tip?: string; testid: string; wide?: boolean }>()
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const trigger = ref<HTMLElement | null>(null)

function focusables() {
  return Array.from(panel.value?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])
}
async function show(focusFirst: boolean) {
  open.value = true
  document.addEventListener('mousedown', outside, true)
  await nextTick()
  if (focusFirst) {
    const items = focusables()
    ;(items.find((x) => x.getAttribute('aria-checked') === 'true') ?? items[0])?.focus()
  }
}
function hide(refocus = false) {
  open.value = false
  document.removeEventListener('mousedown', outside, true)
  if (refocus) trigger.value?.focus()
}
function outside(e: MouseEvent) {
  if (!root.value?.contains(e.target as Node)) hide()
}
onBeforeUnmount(() => document.removeEventListener('mousedown', outside, true))

function onTriggerKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    e.stopPropagation()
    void show(true)
  }
}
function onPanelKey(e: KeyboardEvent) {
  const items = focusables()
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus()
  else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus()
  else if (e.key === 'Escape') hide(true)
  else if (e.key === 'Tab') hide()
  else return
  e.preventDefault()
  e.stopPropagation()
}
function pick(item: DropdownItem) {
  hide()
  item.run()
}
defineExpose({ hide })
</script>

<template>
  <div ref="root" class="dropdown" :class="{ open }">
    <button
      ref="trigger"
      type="button"
      class="tb-btn dd-trigger"
      :data-tip="tip"
      :data-testid="testid"
      aria-haspopup="menu"
      :aria-expanded="open"
      data-tb
      tabindex="-1"
      @mousedown.prevent
      @click="open ? hide() : show(false)"
      @keydown="onTriggerKey"
    >
      <slot name="trigger" />
      <ChevronDown :size="14" class="dd-chevron" />
    </button>
    <div v-if="open" ref="panel" class="menu dd-panel" :class="{ wide }" role="menu" :data-testid="`${testid}-menu`" @keydown="onPanelKey">
      <slot :hide="hide">
        <button
          v-for="item in props.items"
          :key="item.id"
          type="button"
          class="menu-item"
          role="menuitemradio"
          :aria-checked="!!item.active"
          :data-testid="`${testid}-${item.id}`"
          data-menu-item
          @mousedown.prevent
          @click="pick(item)"
        >
          <component :is="item.icon" v-if="item.icon" :size="16" class="menu-icon" />
          <span class="menu-label">{{ item.label }}</span>
          <span class="menu-hint">{{ item.hint }}</span>
        </button>
      </slot>
    </div>
  </div>
</template>
