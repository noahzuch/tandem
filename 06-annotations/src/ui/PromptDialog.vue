<script setup lang="ts">
// Styled replacement for window.prompt (image URL, raw HTML island).
import { nextTick, onMounted, reactive, ref } from 'vue'
import { ui } from './store'

const spec = ui.dialog!
const values = reactive(Object.fromEntries(spec.fields.map((f) => [f.name, f.value ?? ''])))
const form = ref<HTMLFormElement | null>(null)
onMounted(() => nextTick(() => form.value?.querySelector<HTMLElement>('input, textarea')?.focus()))

function done(ok: boolean) {
  ui.dialog = null
  spec.resolve(ok ? { ...values } : null)
}
</script>

<template>
  <div class="overlay" @mousedown.self="done(false)">
    <form ref="form" class="dialog" role="dialog" :aria-label="spec.title" data-testid="dialog" @submit.prevent="done(true)" @keydown.esc="done(false)">
      <div class="dialog-head">
        <h2>{{ spec.title }}</h2>
      </div>
      <label v-for="f in spec.fields" :key="f.name" class="field">
        <span>{{ f.label }}</span>
        <textarea v-if="f.multiline" v-model="values[f.name]" spellcheck="false" :data-testid="`dialog-${f.name}`" @keydown.meta.enter="done(true)" @keydown.ctrl.enter="done(true)" />
        <input v-else v-model="values[f.name]" :placeholder="f.placeholder" :data-testid="`dialog-${f.name}`" />
      </label>
      <div class="dialog-actions">
        <button type="button" class="btn" @click="done(false)">Cancel</button>
        <button type="submit" class="btn primary" data-testid="dialog-submit">{{ spec.submit ?? 'OK' }}</button>
      </div>
    </form>
  </div>
</template>
