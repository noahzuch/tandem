<script setup lang="ts">
// Grid size picker (hover or arrow keys, click / Enter inserts).
import { onMounted, ref } from 'vue'

const emit = defineEmits<{ pick: [rows: number, cols: number] }>()
const MAX = 8
const rows = ref(3)
const cols = ref(3)
const grid = ref<HTMLElement | null>(null)
onMounted(() => grid.value?.focus())

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowRight') cols.value = Math.min(MAX, cols.value + 1)
  else if (e.key === 'ArrowLeft') cols.value = Math.max(1, cols.value - 1)
  else if (e.key === 'ArrowDown') rows.value = Math.min(MAX, rows.value + 1)
  else if (e.key === 'ArrowUp') rows.value = Math.max(1, rows.value - 1)
  else if (e.key === 'Enter' || e.key === ' ') emit('pick', rows.value, cols.value)
  else return
  e.preventDefault()
  e.stopPropagation()
}
</script>

<template>
  <div class="table-picker">
    <div
      ref="grid"
      class="tp-grid"
      tabindex="0"
      data-menu-item
      role="grid"
      aria-label="Table size, arrow keys to change, Enter to insert"
      data-testid="table-picker"
      @keydown="onKey"
    >
      <template v-for="r in MAX" :key="r">
        <span
          v-for="c in MAX"
          :key="c"
          class="tp-cell"
          :class="{ on: r <= rows && c <= cols }"
          :data-testid="`tp-${r}x${c}`"
          @mouseenter="(rows = r), (cols = c)"
          @mousedown.prevent
          @click="emit('pick', r, c)"
        />
      </template>
    </div>
    <div class="tp-label">{{ rows }} × {{ cols }} <span class="muted">· header row</span></div>
  </div>
</template>
