<script setup lang="ts">
// Spike 09: one sidebar (left or right) of the shell: tabs from the config, resizable, collapsible to a rail.
// Panels stay mounted when hidden (v-show): the comments lane keeps its layout, a journal keeps its scroll position.
import { computed, watch } from 'vue'
import type { Editor } from '@tiptap/core'
import type * as Y from 'yjs'
import { Activity as ActivityIcon, FileCode, FileText, Globe, Link, ListTree, MessageSquare, NotebookText, PanelLeftClose, PanelRightClose, ScrollText } from 'lucide-vue-next'
import Outline from '../ui/Outline.vue'
import CommentsPanel from '../comments/CommentsPanel.vue'
import { comments } from '../comments/store'
import FilePanel from './FilePanel.vue'
import ActivityPanel from './ActivityPanel.vue'
import { panelTitle, setSide, shell, sideState, type Panel, type Side } from './store'

const props = defineProps<{ side: Side; editor: Editor; ydoc: Y.Doc; me: { name: string; color: string } }>()
const st = computed(() => sideState(props.side))
/** not enough room for every title: inactive tabs show only their icon (title on hover) */
const compact = computed(() => st.value.panels.length > Math.max(1, Math.floor((st.value.width - 40) / 92)))

const icon = (p: Panel) =>
  p.type === 'file'
    ? ({ journal: NotebookText, markdown: FileText, html: FileCode, text: ScrollText } as const)[p.render ?? 'text']
    : ({ outline: ListTree, comments: MessageSquare, activity: ActivityIcon, links: Link, iframe: Globe } as const)[p.type as 'outline']
const openThreads = computed(() => comments.threads.filter((t) => t.status === 'open').length)
const badge = (p: Panel) => (p.type === 'comments' ? openThreads.value || '' : shell.unseen[p.id] ? `+${shell.unseen[p.id]}` : '')

function activate(id: string) {
  setSide(props.side, { active: id, collapsed: false })
  delete shell.unseen[id]
}
const toggle = () => setSide(props.side, { collapsed: !st.value.collapsed })

// a comment is being written / a thread was clicked in the text → show the comments tab (wherever it is configured)
const commentsHere = computed(() => st.value.panels.find((p) => p.type === 'comments'))
watch(
  () => [comments.composer, comments.active] as const,
  ([composer, active]) => {
    if ((composer || active) && commentsHere.value && (st.value.active !== commentsHere.value.id || st.value.collapsed)) activate(commentsHere.value.id)
  },
)
// the comments lane measures its cards: re-layout when its tab becomes visible
watch(
  () => [st.value.active, st.value.collapsed, st.value.width],
  () => requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))),
)

// ---------------------------------------------------------------- resize (drag the inner edge)
function startResize(e: PointerEvent) {
  const startX = e.clientX
  const startW = st.value.width
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  document.body.classList.add('resizing')
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - startX
    setSide(props.side, { width: Math.round(Math.max(220, Math.min(720, startW + (props.side === 'left' ? dx : -dx)))) })
  }
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    document.body.classList.remove('resizing')
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}
</script>

<template>
  <aside
    :class="['sb', `sb-${side}`, { collapsed: st.collapsed }]"
    :style="{ '--sb-w': st.collapsed ? '44px' : st.width + 'px' }"
    :data-testid="`sidebar-${side}`"
    :data-collapsed="st.collapsed"
    :aria-label="`${side} sidebar`"
  >
    <!-- collapsed: a rail of tab icons -->
    <nav v-if="st.collapsed" class="sb-rail">
      <button type="button" class="rail-btn" :title="`Expand ${side} sidebar`" :data-testid="`sb-expand-${side}`" @click="toggle">
        <component :is="side === 'left' ? PanelLeftClose : PanelRightClose" :size="16" style="transform: scaleX(-1)" />
      </button>
      <button
        v-for="p in st.panels"
        :key="p.id"
        type="button"
        :class="['rail-btn', { new: shell.newPanels.includes(p.id) }]"
        :title="panelTitle(p)"
        :data-testid="`rail-${p.id}`"
        @click="activate(p.id)"
      >
        <component :is="icon(p)" :size="16" />
        <span v-if="badge(p)" class="tab-badge">{{ badge(p) }}</span>
      </button>
    </nav>
    <template v-else>
      <div class="sb-tabs">
        <div :class="['sb-tablist', { compact }]" role="tablist">
        <button
          v-for="p in st.panels"
          :key="p.id"
          type="button"
          role="tab"
          :aria-selected="p.id === st.active"
          :class="['sb-tab', { on: p.id === st.active, new: shell.newPanels.includes(p.id) }]"
          :data-testid="`tab-${p.id}`"
          :title="p.path ?? p.url ?? panelTitle(p)"
          @click="activate(p.id)"
        >
          <component :is="icon(p)" :size="14" />
          <span class="tab-title">{{ panelTitle(p) }}</span>
          <span v-if="badge(p)" class="tab-badge" :data-testid="`badge-${p.id}`">{{ badge(p) }}</span>
        </button>
        </div>
        <button type="button" class="sb-collapse" :title="`Collapse ${side} sidebar`" :data-testid="`sb-collapse-${side}`" @click="toggle">
          <component :is="side === 'left' ? PanelLeftClose : PanelRightClose" :size="16" />
        </button>
      </div>
      <p v-if="!st.panels.length" class="jv-empty sb-empty">No panels. <code>collab panel add … --side {{ side }}</code></p>
    </template>

    <!-- panels (mounted always, shown when active and expanded) -->
    <template v-for="p in st.panels" :key="p.id">
      <!-- comments: in the page flow, cards aligned with their anchors in the text (scrolls with the document) -->
      <div v-if="p.type === 'comments'" v-show="!st.collapsed && st.active === p.id" class="sb-flow" :data-testid="`panel-${p.id}`">
        <CommentsPanel :editor="editor" :ydoc="ydoc" :me="me" />
      </div>
      <!-- everything else: a sticky box with its own scrollbar -->
      <div v-else v-show="!st.collapsed && st.active === p.id" class="sb-box" :data-testid="`panel-${p.id}`" :data-type="p.type">
        <Outline v-if="p.type === 'outline'" :editor="editor" />
        <ActivityPanel v-else-if="p.type === 'activity'" />
        <FilePanel v-else-if="p.type === 'file'" :panel="p" :file="shell.files[p.id]" :active="!st.collapsed && st.active === p.id" :me="me" />
        <iframe v-else-if="p.type === 'iframe'" class="html-frame" :src="p.url" sandbox="allow-scripts allow-forms allow-popups" :title="panelTitle(p)" />
        <ul v-else-if="p.type === 'links'" class="links">
          <li v-for="l in p.links" :key="l.href">
            <a :href="l.href" target="_blank" rel="noopener noreferrer">{{ l.title }}</a>
            <span class="muted">{{ l.href }}</span>
          </li>
        </ul>
      </div>
    </template>
    <div v-if="!st.collapsed" class="sb-resize" :title="'Drag to resize'" :data-testid="`sb-resize-${side}`" @pointerdown.prevent="startResize" />
  </aside>
</template>
