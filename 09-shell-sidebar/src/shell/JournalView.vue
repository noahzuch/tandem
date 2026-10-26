<script setup lang="ts">
// Spike 09: the brainstorm Decision Journal as a filterable entry list (or the plain rendered file).
// Live: the file panel reloads on every change on disk; new/changed entries flash and scroll into view.
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { MessageSquare, Send } from 'lucide-vue-next'
import { TYPE_LABEL, type EntryType, type JournalEntry } from './journal'
import { linkRefs, renderMarkdown, scrollWithin } from './markdown'
import { ago, sendJournalComment, shell, type FileState, type Panel } from './store'
import { toast } from '../ui/store'

const props = defineProps<{ panel: Panel; file: FileState; active: boolean; me: { name: string } }>()
const root = ref<HTMLElement | null>(null)
const view = ref<'entries' | 'file'>('entries')
const filter = ref<EntryType | 'all'>('all')
const query = ref('')
const flash = reactive(new Set<string>())
const expanded = reactive(new Set<string>())
const composing = ref<string | null>(null)
const draft = ref('')
const hiddenFresh = ref<string[]>([])

const entries = computed(() => props.file.entries ?? [])
const known = computed(() => new Map(entries.value.map((e) => [e.id, e])))
const counts = computed(() => {
  const c: Record<string, number> = { all: entries.value.length }
  for (const e of entries.value) c[e.type] = (c[e.type] ?? 0) + 1
  return c
})
const ORDER: EntryType[] = ['decision', 'fact', 'question', 'rejected']
const matches = (e: JournalEntry) =>
  (filter.value === 'all' || e.type === filter.value) && (!query.value || `${e.id} ${e.body}`.toLowerCase().includes(query.value.toLowerCase()))
const shown = computed(() => entries.value.filter(matches))

const html = new Map<string, { body: string; out: string }>()
function bodyHtml(e: JournalEntry) {
  const c = html.get(e.id)
  if (c && c.body === e.body) return c.out
  const out = linkRefs(renderMarkdown(e.body), known.value)
  html.set(e.id, { body: e.body, out })
  return out
}
const fileHtml = computed(() => linkRefs(renderMarkdown(props.file.text), known.value))
const long = (e: JournalEntry) => e.body.length > 420

const scroller = () => root.value?.closest<HTMLElement>('.sb-box') ?? null
function reveal(id: string, smooth = true) {
  const e = known.value.get(id)
  if (!e) return
  if (!matches(e)) {
    filter.value = 'all'
    query.value = ''
  }
  view.value = 'entries'
  expanded.add(id)
  void nextTick(() => {
    scrollWithin(scroller(), root.value?.querySelector<HTMLElement>(`[data-entry="${id}"]`) ?? null, smooth)
    flash.add(id)
    setTimeout(() => flash.delete(id), 2600)
  })
}

// the file changed on disk: flash what is new, scroll to the last new entry (appends land at the bottom)
watch(
  () => props.file.version,
  () => {
    const fresh = props.file.fresh
    if (!fresh.length) return
    hiddenFresh.value = fresh.filter((id) => known.value.has(id) && !matches(known.value.get(id)!))
    void nextTick(() => {
      for (const id of fresh) {
        flash.add(id)
        setTimeout(() => flash.delete(id), 3200)
      }
      if (props.active && view.value === 'entries') {
        const visible = fresh.filter((id) => !hiddenFresh.value.includes(id))
        const last = visible.at(-1)
        if (last) scrollWithin(scroller(), root.value?.querySelector<HTMLElement>(`[data-entry="${last}"]`) ?? null)
      }
    })
  },
)
// "show me D-7" (agent `collab panel open journal --entry D-7`, or a click on a reference in the spec)
watch(
  () => shell.focus?.n,
  () => {
    const f = shell.focus
    if (f && f.panel === props.panel.id && f.entry) reveal(f.entry)
  },
)
// tab opened again after changes arrived while it was hidden
watch(
  () => props.active,
  (on) => {
    const focused = shell.focus?.panel === props.panel.id && shell.focus.entry && Date.now() - shell.focus.at < 1000 // "show D-1" wins
    if (on && !focused && props.file.fresh.length && Date.now() - props.file.loadedAt < 60000) void nextTick(() => reveal(props.file.fresh.at(-1)!, false))
  },
)

function onClick(ev: MouseEvent) {
  const a = (ev.target as HTMLElement).closest<HTMLElement>('a.jref')
  if (!a) return
  ev.preventDefault()
  reveal(a.dataset.ref!)
}

async function send(e: JournalEntry) {
  const text = draft.value.trim()
  if (!text) return
  try {
    await sendJournalComment(e, text, props.me.name)
    draft.value = ''
    composing.value = null
    toast(`Comment on ${e.id} sent to the agent`)
  } catch (err) {
    toast(`Could not send: ${(err as Error).message}`)
  }
}
function openComposer(id: string) {
  composing.value = composing.value === id ? null : id
  draft.value = ''
  void nextTick(() => root.value?.querySelector<HTMLTextAreaElement>(`[data-entry="${id}"] textarea`)?.focus())
}
</script>

<template>
  <div ref="root" class="journal" :data-testid="`journal-${panel.id}`" @click="onClick">
    <div class="jv-bar">
      <div class="seg" role="radiogroup" aria-label="View">
        <button type="button" :class="{ on: view === 'entries' }" data-testid="jv-entries" @click="view = 'entries'">Entries</button>
        <button type="button" :class="{ on: view === 'file' }" data-testid="jv-file" @click="view = 'file'">File</button>
      </div>
      <input v-if="view === 'entries'" v-model="query" class="jv-search" type="search" placeholder="Search…" data-testid="jv-search" />
    </div>
    <template v-if="view === 'entries'">
      <div class="jv-chips" role="radiogroup" aria-label="Filter">
        <button type="button" :class="['chip', { on: filter === 'all' }]" data-testid="jf-all" @click="filter = 'all'">All {{ counts.all }}</button>
        <button
          v-for="t in ORDER.filter((t) => counts[t])"
          :key="t"
          type="button"
          :class="['chip', `t-${t}`, { on: filter === t }]"
          :data-testid="`jf-${t}`"
          @click="filter = filter === t ? 'all' : t"
        >
          {{ TYPE_LABEL[t] }} {{ counts[t] }}
        </button>
      </div>
      <p v-if="hiddenFresh.length" class="jv-hidden">
        New: {{ hiddenFresh.join(', ') }} (hidden by the filter) <button type="button" class="link-btn" @click="reveal(hiddenFresh.at(-1)!)">show</button>
      </p>
      <p v-if="file.missing" class="jv-empty">{{ panel.path }} does not exist (yet). It appears here as soon as it is written.</p>
      <p v-else-if="!entries.length" class="jv-empty">No journal entries in {{ panel.path }} yet.</p>
      <article
        v-for="e in shown"
        :key="e.id"
        :class="['je', `t-${e.type}`, `s-${e.status}`, { flash: flash.has(e.id), clamped: long(e) && !expanded.has(e.id) }]"
        :data-entry="e.id"
        :data-testid="`entry-${e.id}`"
      >
        <header class="je-head">
          <span class="je-id">{{ e.id }}</span>
          <span v-if="e.statusText || e.status" class="je-status" :title="e.statusText">{{ e.statusText || e.status }}</span>
          <span class="spacer" />
          <button type="button" class="je-act" title="Comment on this entry (goes to the agent)" :data-testid="`entry-comment-${e.id}`" @click="openComposer(e.id)">
            <MessageSquare :size="13" />
          </button>
        </header>
        <div class="je-body md" v-html="bodyHtml(e)" />
        <button v-if="long(e)" type="button" class="link-btn je-more" @click="expanded.has(e.id) ? expanded.delete(e.id) : expanded.add(e.id)">
          {{ expanded.has(e.id) ? 'less' : 'more' }}
        </button>
        <ul v-if="shell.sentComments[e.id]?.length" class="je-sent">
          <li v-for="c in shell.sentComments[e.id]" :key="c.at">💬 {{ c.text }} <span class="muted">· sent to agent {{ ago(c.at) }}</span></li>
        </ul>
        <form v-if="composing === e.id" class="je-compose" @submit.prevent="send(e)">
          <textarea v-model="draft" rows="2" :placeholder="`Comment on ${e.id} for the agent…`" data-testid="entry-comment-text" @keydown.meta.enter.prevent="send(e)" @keydown.ctrl.enter.prevent="send(e)" @keydown.esc="composing = null" />
          <button type="submit" class="send-review" data-testid="entry-comment-send"><Send :size="13" /> Send</button>
        </form>
      </article>
    </template>
    <div v-else class="md jv-file" data-testid="jv-file-view" v-html="fileHtml" />
  </div>
</template>
