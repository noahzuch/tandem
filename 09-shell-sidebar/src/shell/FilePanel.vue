<script setup lang="ts">
// Spike 09: a file from the working tree in a side panel, live (the server watches it and pushes "file" over SSE).
//   markdown → markdown-it (raw HTML escaped); new/changed top-level blocks flash + scroll into view
//   journal  → JournalView (entry list of the brainstorm Decision Journal)
//   html     → sandboxed iframe (srcdoc, sandbox="" = no scripts, opaque origin: cannot touch the editor)
//   text     → <pre>
import { computed, nextTick, ref, watch } from 'vue'
import JournalView from './JournalView.vue'
import { journalIndex, jumpToEntry, type FileState, type Panel } from './store'
import { linkRefs, renderMarkdown, scrollWithin } from './markdown'

const props = defineProps<{ panel: Panel; file: FileState | undefined; active: boolean; me: { name: string } }>()
const root = ref<HTMLElement | null>(null)

const mdHtml = computed(() => (props.file && props.panel.render === 'markdown' ? linkRefs(renderMarkdown(props.file.text), journalIndex.value) : ''))

let lastBlocks: string[] | null = null
watch(
  () => props.file?.version,
  async () => {
    if (props.panel.render !== 'markdown') return
    await nextTick()
    const el = root.value?.querySelector<HTMLElement>('.md')
    if (!el) return
    const kids = Array.from(el.children) as HTMLElement[]
    const now = kids.map((k) => k.outerHTML)
    if (lastBlocks) {
      const before = new Set(lastBlocks)
      const fresh = kids.filter((k, i) => !before.has(now[i]))
      fresh.forEach((k) => {
        k.classList.add('flash')
        setTimeout(() => k.classList.remove('flash'), 3200)
      })
      if (fresh.length && props.active) scrollWithin(root.value?.closest<HTMLElement>('.sb-box') ?? null, fresh.at(-1)!)
    }
    lastBlocks = now
  },
  { immediate: true },
)

function onClick(ev: MouseEvent) {
  const a = (ev.target as HTMLElement).closest<HTMLElement>('a.jref')
  if (!a) return
  ev.preventDefault()
  jumpToEntry(a.dataset.ref!)
}
</script>

<template>
  <div ref="root" class="file-panel" :data-testid="`file-${panel.id}`" :data-version="file?.version ?? 0" @click="onClick">
    <p v-if="!file" class="jv-empty">Loading {{ panel.path }}…</p>
    <JournalView v-else-if="panel.render === 'journal'" :panel="panel" :file="file" :active="active" :me="me" />
    <p v-else-if="file.missing" class="jv-empty">{{ panel.path }} does not exist (yet).</p>
    <div v-else-if="panel.render === 'markdown'" class="md" v-html="mdHtml" />
    <iframe v-else-if="panel.render === 'html'" class="html-frame" sandbox="" :srcdoc="file.text" :title="panel.title ?? panel.path" data-testid="html-frame" />
    <pre v-else class="text-file">{{ file.text }}</pre>
  </div>
</template>
