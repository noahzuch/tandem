// Reactive UI state of the comments feature (sidebar, composer, highlight plugin share it).
import { reactive } from 'vue'
import type { AnchorJSON, Kind, Resolved, Target, ThreadSnapshot } from './model'

export interface Composer {
  target: Target
  anchor: AnchorJSON
  quote: string
  prefix: string
  suffix: string
  blockId: string | null
  leaf: { path: string; text: string } | null
  kind: Kind
  ask: boolean
}

export const comments = reactive({
  threads: [] as ThreadSnapshot[],
  /** thread id → current range in the editor doc, null = orphaned (filled by the highlight plugin) */
  ranges: new Map<string, Resolved | null>(),
  /** bumped whenever ranges were recomputed or mapped (sidebar re-layouts) */
  version: 0,
  active: null as string | null,
  hover: null as string | null,
  composer: null as Composer | null,
  /** 'now' = every comment wakes the agent; 'review' = drafts until "Send all to agent" */
  mode: 'review' as 'now' | 'review',
  showResolved: false,
  /** consumers with a `collab wait` open right now */
  listening: [] as string[],
  /** thread ids that just got an agent reply (flash) */
  flash: new Set<string>(),
})

try {
  const m = localStorage.getItem('spike06.mode')
  if (m === 'now' || m === 'review') comments.mode = m
} catch {
  /* private window */
}
export function setMode(m: 'now' | 'review') {
  comments.mode = m
  try {
    localStorage.setItem('spike06.mode', m)
  } catch {
    /* ignore */
  }
}
