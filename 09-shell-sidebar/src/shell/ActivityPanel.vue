<script setup lang="ts">
// Spike 09: what the agent did and what reached it — agent calls (read/patch/op…), queued events (comments,
// journal comments), file panel changes (journal +D-9), shell config changes. Newest first.
import { computed, onBeforeUnmount, ref } from 'vue'
import { Bot, FileText, PanelsTopLeft, Send } from 'lucide-vue-next'
import { ago, jumpToEntry, shell } from './store'

const now = ref(Date.now())
const tick = setInterval(() => (now.value = Date.now()), 5000)
onBeforeUnmount(() => clearInterval(tick))
const items = computed(() => [...shell.activity].reverse())
const icon = (k: string) => ({ agent: Bot, file: FileText, event: Send, shell: PanelsTopLeft })[k] ?? Bot
</script>

<template>
  <div class="activity" data-testid="activity">
    <p v-if="!items.length" class="jv-empty">Nothing yet. Agent calls, comments sent to the agent and file changes show up here.</p>
    <ol>
      <li v-for="a in items" :key="a.seq" :class="['act', `k-${a.kind}`]" :data-testid="`act-${a.seq}`">
        <component :is="icon(a.kind)" :size="13" class="act-icon" />
        <div class="act-main">
          <span class="act-text">{{ a.text }}</span>
          <span class="act-meta">
            {{ ago(a.ts, now) }}
            <a v-for="id in a.ids ?? []" :key="id" href="#" class="jref" @click.prevent="jumpToEntry(id)">{{ id }}</a>
          </span>
        </div>
      </li>
    </ol>
  </div>
</template>
