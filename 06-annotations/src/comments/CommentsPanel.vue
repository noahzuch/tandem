<script setup lang="ts">
// Spike 06: comment sidebar. Threads are aligned with their anchors (Google-Docs style margin), pushed down when they
// would overlap; the active thread sits exactly next to its anchor. Orphans (anchored text deleted) are listed below.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, watchEffect } from 'vue'
import type { Editor } from '@tiptap/core'
import type * as Y from 'yjs'
import { Bot, Check, MessageSquare, RotateCcw, Send, Trash2, User } from 'lucide-vue-next'
import { KINDS, addMessage, createThread, deleteThread, setStatus, type Kind, type ThreadSnapshot } from './model'
import { comments, setMode } from './store'
import { refreshComments } from './plugin'
import { toast } from '../ui/store'

const props = defineProps<{ editor: Editor; ydoc: Y.Doc; me: { name: string; color: string } }>()
const lane = ref<HTMLElement | null>(null)
const tops = reactive(new Map<string, number>())
const orphanTop = ref(0)
const laneHeight = ref(400)
const replyDraft = reactive<Record<string, string>>({})
const composerText = ref('')
const composerInput = ref<HTMLTextAreaElement | null>(null)

const kindLabel = (k: Kind) => KINDS.find((x) => x.id === k)?.label ?? k
const author = () => ({ name: props.me.name, kind: 'user' as const, color: props.me.color })
const isDraft = (t: ThreadSnapshot) => t.delivery === 'review' && t.sentSeq == null
const visible = (t: ThreadSnapshot) => t.status === 'open' || comments.showResolved

const anchored = computed(() => comments.threads.filter((t) => visible(t) && comments.ranges.get(t.id)))
const orphans = computed(() => comments.threads.filter((t) => visible(t) && comments.ranges.has(t.id) && !comments.ranges.get(t.id)))
const drafts = computed(() => comments.threads.filter((t) => isDraft(t) && t.status === 'open'))
const openCount = computed(() => comments.threads.filter((t) => t.status === 'open').length)
const resolvedCount = computed(() => comments.threads.filter((t) => t.status === 'resolved').length)

// ---------------------------------------------------------------- layout: align cards with anchors
function anchorTop(from: number, base: number): number {
  const view = props.editor.view
  try {
    const dom = view.nodeDOM(from) as HTMLElement | null
    const node = view.state.doc.nodeAt(from)
    if (dom && node && !node.isText && dom.getBoundingClientRect) return dom.getBoundingClientRect().top - base
    return view.coordsAtPos(Math.min(from + (node?.isText ? 0 : 1), view.state.doc.content.size)).top - base
  } catch {
    return 0
  }
}
let raf = 0
function layout() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(() => {
    const el = lane.value
    if (!el) return
    const base = el.getBoundingClientRect().top
    const items: { id: string; want: number; h: number }[] = []
    const height = (id: string) => (el.querySelector<HTMLElement>(`[data-card="${id}"]`)?.offsetHeight ?? 80) + 10
    if (comments.composer) {
      const r = comments.ranges.get('__pending')
      if (r) items.push({ id: '__pending', want: anchorTop(r.from, base), h: height('__pending') })
    }
    for (const t of anchored.value) items.push({ id: t.id, want: anchorTop(comments.ranges.get(t.id)!.from, base), h: height(t.id) })
    items.sort((a, b) => a.want - b.want)
    const top = items.map((i) => Math.max(0, i.want))
    for (let i = 1; i < items.length; i++) top[i] = Math.max(top[i], top[i - 1] + items[i - 1].h)
    // the active card (or the composer) sits exactly at its anchor: push the cards above it up
    const focus = items.findIndex((i) => i.id === (comments.composer ? '__pending' : comments.active))
    if (focus >= 0 && top[focus] > Math.max(0, items[focus].want)) {
      top[focus] = Math.max(0, items[focus].want)
      for (let i = focus + 1; i < items.length; i++) top[i] = Math.max(Math.max(0, items[i].want), top[i - 1] + items[i - 1].h)
      for (let i = focus - 1; i >= 0; i--) top[i] = Math.min(top[i], top[i + 1] - items[i].h)
      const shift = Math.min(0, top[0] ?? 0)
      if (shift < 0) for (let i = 0; i < items.length; i++) top[i] -= shift
    }
    tops.clear()
    items.forEach((it, i) => tops.set(it.id, top[i]))
    const last = items.length ? top[items.length - 1] + items[items.length - 1].h : 0
    orphanTop.value = last + 16
    const orphanH = el.querySelector<HTMLElement>('.cmt-orphans')?.offsetHeight ?? 0
    laneHeight.value = Math.max(orphanTop.value + orphanH + 40, (props.editor.view.dom as HTMLElement).offsetHeight)
  })
}
const relayout = () => nextTick(layout)
watch(() => [comments.version, comments.threads, comments.active, comments.composer, comments.showResolved], relayout, { deep: false })
let ro: ResizeObserver | null = null
onMounted(() => {
  props.editor.on('update', relayout)
  window.addEventListener('resize', relayout)
  ro = new ResizeObserver(relayout)
  ro.observe(props.editor.view.dom)
  relayout()
})
onBeforeUnmount(() => {
  props.editor.off('update', relayout)
  window.removeEventListener('resize', relayout)
  ro?.disconnect()
  cancelAnimationFrame(raf)
})

// ---------------------------------------------------------------- hover / active highlight (CSS, no PM transaction)
const styleEl = document.createElement('style')
styleEl.id = 'cmt-dynamic'
document.head.append(styleEl)
watchEffect(() => {
  const ids = [comments.hover, comments.active].filter(Boolean) as string[]
  styleEl.textContent = ids.map((id) => `.tiptap [data-thread="${id}"] { --cmt-strength: 1; }`).join('\n')
})
onBeforeUnmount(() => styleEl.remove())

// ---------------------------------------------------------------- agent replies flash
const seenAgent = new Map<string, number>()
watch(
  () => comments.threads,
  (threads) => {
    for (const t of threads) {
      const n = t.messages.filter((m) => m.author.kind === 'agent').length
      const before = seenAgent.get(t.id)
      if (before !== undefined && n > before) {
        comments.flash.add(t.id)
        setTimeout(() => comments.flash.delete(t.id), 2600)
      }
      seenAgent.set(t.id, n)
    }
  },
)

// ---------------------------------------------------------------- actions
function activate(id: string) {
  comments.active = id
}
function scrollTo(t: ThreadSnapshot) {
  const r = comments.ranges.get(t.id)
  if (!r) return
  activate(t.id)
  const dom = props.editor.view.domAtPos(r.from).node as HTMLElement
  ;(dom.nodeType === 1 ? dom : dom.parentElement)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}
function submitComposer() {
  const c = comments.composer
  if (!c || !composerText.value.trim()) return
  const delivery = c.ask || comments.mode === 'now' ? 'now' : 'review'
  const range = comments.ranges.get('__pending')
  const id = createThread(props.ydoc, { ...c, author: author(), text: composerText.value.trim(), delivery, ask: c.ask }, 'user-comments')
  composerText.value = ''
  comments.composer = null
  comments.active = id
  refreshComments(props.editor)
  // collapse the selection to the end of the commented text (hides the bubble menu, keeps the place)
  if (range && c.target === 'text') props.editor.commands.setTextSelection(range.to)
  if (delivery === 'now') toast(comments.listening.length ? 'Sent to the agent' : 'Queued for the agent (not listening right now)')
}
function cancelComposer() {
  comments.composer = null
  composerText.value = ''
  refreshComments(props.editor)
  props.editor.commands.focus()
}
function reply(t: ThreadSnapshot) {
  const text = (replyDraft[t.id] ?? '').trim()
  if (!text) return
  addMessage(props.ydoc, t.id, author(), text, 'user-comments')
  replyDraft[t.id] = ''
}
function toggleResolved(t: ThreadSnapshot) {
  setStatus(props.ydoc, t.id, t.status === 'open' ? 'resolved' : 'open', props.me.name, 'user-comments')
  if (t.status === 'open' && comments.active === t.id) comments.active = null
}
function remove(t: ThreadSnapshot) {
  deleteThread(props.ydoc, t.id, 'user-comments')
}
async function sendReview() {
  const r = await fetch('/api/review/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: props.me.name }) })
  const body = (await r.json()) as { count: number }
  toast(body.count ? `Sent ${body.count} comment${body.count > 1 ? 's' : ''} to the agent` : 'Nothing to send')
}
function toggleResolvedFilter() {
  comments.showResolved = !comments.showResolved
  refreshComments(props.editor)
}
watch(
  () => comments.composer,
  (c) => c && nextTick(() => composerInput.value?.focus()),
)
const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <aside class="cmt-panel" data-testid="comments-panel">
    <header class="cmt-head">
      <div class="cmt-title">
        <MessageSquare :size="16" /> Comments <span class="cmt-count" data-testid="cmt-open-count">{{ openCount }}</span>
        <span class="agent-badge" :class="{ on: comments.listening.length }" data-testid="agent-listening" :title="comments.listening.length ? 'a `collab wait` is open: comments reach the agent now' : 'no agent is waiting: comments are queued until it waits again'">
          agent: {{ comments.listening.length ? 'listening' : 'not listening' }}
        </span>
      </div>
      <div class="cmt-controls">
        <div class="seg" role="radiogroup" aria-label="Deliver comments">
          <button type="button" :class="{ on: comments.mode === 'review' }" data-testid="mode-review" title="Comments are drafts until you send them all (review round)" @click="setMode('review')">Review round</button>
          <button type="button" :class="{ on: comments.mode === 'now' }" data-testid="mode-now" title="Every comment goes to the agent right away" @click="setMode('now')">Immediately</button>
        </div>
        <button v-if="drafts.length" type="button" class="send-review" data-testid="send-review" @click="sendReview"><Send :size="14" /> Send {{ drafts.length }} to agent</button>
        <button v-if="resolvedCount" type="button" class="link-btn" data-testid="toggle-resolved" @click="toggleResolvedFilter">{{ comments.showResolved ? 'hide' : 'show' }} {{ resolvedCount }} resolved</button>
      </div>
    </header>

    <div ref="lane" class="cmt-lane" :style="{ height: laneHeight + 'px' }">
      <p v-if="!comments.threads.length && !comments.composer" class="cmt-empty">Select text → <b>Comment</b> or <b>Ask agent</b>. Blocks: grip menu → Comment on block. Diagrams: hover → comment.</p>

      <!-- composer -->
      <article v-if="comments.composer" class="cmt-card composer active" data-card="__pending" data-testid="composer" :style="{ top: (tops.get('__pending') ?? 0) + 'px' }">
        <div class="cmt-meta">
          <span class="who"><User :size="13" /> {{ me.name }}</span>
          <span v-if="comments.composer.target !== 'text'" class="target-tag">{{ comments.composer.leaf ? `label “${comments.composer.leaf.text}”` : comments.composer.target }}</span>
        </div>
        <div class="kinds" role="radiogroup" aria-label="Kind">
          <button v-for="k in KINDS" :key="k.id" type="button" :class="['kind', `k-${k.id}`, { on: comments.composer.kind === k.id }]" :title="k.hint" :data-testid="`kind-${k.id}`" @click="comments.composer.kind = k.id">{{ k.label }}</button>
        </div>
        <textarea
          ref="composerInput"
          v-model="composerText"
          data-testid="composer-text"
          :placeholder="comments.composer.ask ? 'Ask the agent…' : 'Comment…'"
          rows="3"
          @keydown.meta.enter.prevent="submitComposer"
          @keydown.ctrl.enter.prevent="submitComposer"
          @keydown.esc.prevent="cancelComposer"
        />
        <div class="cmt-actions">
          <span class="delivery-note">{{ comments.composer.ask || comments.mode === 'now' ? 'goes to the agent now' : 'draft until “Send to agent”' }}</span>
          <button type="button" class="link-btn" data-testid="composer-cancel" @click="cancelComposer">Cancel</button>
          <button type="button" class="primary" data-testid="composer-submit" :disabled="!composerText.trim()" @click="submitComposer">{{ comments.composer.ask ? 'Ask agent' : 'Comment' }}</button>
        </div>
      </article>

      <!-- anchored threads -->
      <article
        v-for="t in anchored"
        :key="t.id"
        class="cmt-card"
        :class="[`k-${t.kind}`, { active: comments.active === t.id, resolved: t.status === 'resolved', draft: isDraft(t), flash: comments.flash.has(t.id) }]"
        :data-card="t.id"
        :data-testid="`thread-${t.id}`"
        :style="{ top: (tops.get(t.id) ?? 0) + 'px' }"
        @mouseenter="comments.hover = t.id"
        @mouseleave="comments.hover = null"
        @click="activate(t.id)"
        @dblclick="scrollTo(t)"
      >
        <div class="cmt-meta">
          <span class="kind-badge" :class="`k-${t.kind}`">{{ kindLabel(t.kind) }}</span>
          <span v-if="t.ask" class="tag">ask agent</span>
          <span v-if="t.target !== 'text'" class="tag">{{ t.leaf ? `label “${t.leaf.text}”` : t.target }}</span>
          <span v-if="isDraft(t)" class="tag draft-tag" data-testid="draft-tag">draft</span>
          <span v-else-if="t.sentSeq" class="tag sent-tag" :title="`delivered as event #${t.sentSeq}`">sent</span>
          <span v-if="t.status === 'resolved'" class="tag resolved-tag" data-testid="resolved-tag">resolved{{ t.resolvedBy ? ` by ${t.resolvedBy}` : '' }}</span>
        </div>
        <div v-for="m in t.messages" :key="m.id" class="msg" :class="{ agent: m.author.kind === 'agent' }" :data-testid="m.author.kind === 'agent' ? 'agent-msg' : 'user-msg'">
          <div class="msg-head">
            <component :is="m.author.kind === 'agent' ? Bot : User" :size="13" /> <b>{{ m.author.name }}</b> <span class="time">{{ time(m.ts) }}</span>
          </div>
          <p>{{ m.text }}</p>
        </div>
        <div v-if="comments.active === t.id" class="cmt-reply" @click.stop>
          <textarea v-if="t.status === 'open'" v-model="replyDraft[t.id]" rows="2" placeholder="Reply…" data-testid="reply-text" @keydown.meta.enter.prevent="reply(t)" @keydown.ctrl.enter.prevent="reply(t)" />
          <div class="cmt-actions">
            <button type="button" class="icon-btn" title="Delete thread" data-testid="thread-delete" @click="remove(t)"><Trash2 :size="14" /></button>
            <span class="spacer" />
            <button type="button" :data-testid="t.status === 'open' ? 'thread-resolve' : 'thread-reopen'" @click="toggleResolved(t)">
              <component :is="t.status === 'open' ? Check : RotateCcw" :size="14" /> {{ t.status === 'open' ? 'Resolve' : 'Re-open' }}
            </button>
            <button v-if="t.status === 'open'" type="button" class="primary" data-testid="reply-submit" :disabled="!(replyDraft[t.id] ?? '').trim()" @click="reply(t)">Reply</button>
          </div>
        </div>
      </article>

      <!-- orphans -->
      <section v-if="orphans.length" class="cmt-orphans" data-testid="orphans" :style="{ top: orphanTop + 'px' }">
        <h4>Detached <span class="muted">— the commented text was deleted</span></h4>
        <article
          v-for="t in orphans"
          :key="t.id"
          class="cmt-card orphan"
          :class="[`k-${t.kind}`, { active: comments.active === t.id, resolved: t.status === 'resolved' }]"
          :data-testid="`orphan-${t.id}`"
          @click="activate(t.id)"
        >
          <div class="cmt-meta">
            <span class="kind-badge" :class="`k-${t.kind}`">{{ kindLabel(t.kind) }}</span>
            <span v-if="t.status === 'resolved'" class="tag resolved-tag">resolved</span>
          </div>
          <blockquote class="orphan-quote">“{{ t.quote }}”</blockquote>
          <div v-for="m in t.messages" :key="m.id" class="msg" :class="{ agent: m.author.kind === 'agent' }">
            <div class="msg-head"><component :is="m.author.kind === 'agent' ? Bot : User" :size="13" /> <b>{{ m.author.name }}</b></div>
            <p>{{ m.text }}</p>
          </div>
          <div v-if="comments.active === t.id" class="cmt-actions" @click.stop>
            <button type="button" class="icon-btn" title="Delete thread" @click="remove(t)"><Trash2 :size="14" /></button>
            <span class="spacer" />
            <button type="button" @click="toggleResolved(t)">{{ t.status === 'open' ? 'Resolve' : 'Re-open' }}</button>
          </div>
        </article>
      </section>
    </div>
    <span class="sr-only" aria-live="polite">{{ comments.threads.length }} threads</span>
  </aside>
</template>
