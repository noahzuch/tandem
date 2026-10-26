<script setup lang="ts">
// "?" popover: every shortcut + markdown rule, generated from the command registry.
import { computed, nextTick, onMounted, ref } from 'vue'
import { commands } from '../editor/commands'
import { formatShortcut, ui } from './store'

const panel = ref<HTMLElement | null>(null)
onMounted(() => nextTick(() => panel.value?.focus()))

const formatting = computed(() => commands.filter((c) => c.shortcut && ['history', 'mark', 'block', 'move'].includes(c.group)))
const markdown = computed(() => commands.filter((c) => c.markdown))
const nav: [string, string][] = [
  ['/', 'Command menu (insert, turn into, table ops inside a table)'],
  [formatShortcut('Mod-k'), 'Insert / edit link'],
  [formatShortcut('Alt-F10'), 'Focus toolbar (or the open bubble / table menu); ←/→ to move, Esc back to text'],
  ['Tab / ' + formatShortcut('Shift-Tab'), 'Next / previous table cell · indent / outdent list item'],
  [formatShortcut('Shift-Enter'), 'Line break inside a block'],
  [formatShortcut('Mod-s'), 'Save to disk'],
  [formatShortcut('Mod-/'), 'This help'],
  ['Esc', 'Close menu / popover'],
]
</script>

<template>
  <div class="overlay" @mousedown.self="ui.helpOpen = false">
    <div ref="panel" class="dialog help" role="dialog" aria-label="Keyboard shortcuts" tabindex="-1" data-testid="help" @keydown.esc="ui.helpOpen = false">
      <div class="dialog-head">
        <h2>Keyboard shortcuts</h2>
        <button type="button" class="tb-btn" aria-label="Close" @click="ui.helpOpen = false">✕</button>
      </div>
      <div class="help-cols">
        <section>
          <h3>Formatting &amp; blocks</h3>
          <dl>
            <template v-for="c in formatting" :key="c.id">
              <dt><kbd>{{ formatShortcut(c.shortcut) }}</kbd></dt>
              <dd>{{ c.label }}</dd>
            </template>
          </dl>
        </section>
        <section>
          <h3>Navigation &amp; menus</h3>
          <dl>
            <template v-for="[k, d] in nav" :key="k">
              <dt><kbd>{{ k }}</kbd></dt>
              <dd>{{ d }}</dd>
            </template>
          </dl>
          <h3>Markdown while typing</h3>
          <dl>
            <template v-for="c in markdown" :key="c.id">
              <dt><code>{{ c.markdown }}</code></dt>
              <dd>{{ c.label }}</dd>
            </template>
          </dl>
        </section>
      </div>
    </div>
  </div>
</template>
