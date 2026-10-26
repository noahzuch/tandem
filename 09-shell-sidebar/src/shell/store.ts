// Spike 09: browser side of the shell. The config comes from the server (SSE /shell/events, live); what the viewer does
// with the layout (resize, collapse, switch tab) is a per-viewer preference in localStorage that overrides the config's
// defaults — until the agent explicitly changes that same layout field again (last explicit action wins).
import { computed, reactive } from 'vue'
import type { Panel, ShellConfig, Side, SideLayout, Activity } from '../../lib/shell'
import { parseJournal, type JournalEntry } from './journal'

export type { Panel, ShellConfig, Side, Activity }

export interface FileState {
  text: string
  mtimeMs: number
  missing: boolean
  /** bumps on every (re)load: watchers re-render */
  version: number
  entries?: JournalEntry[]
  /** ids that appeared/changed with the last reload (highlight + scroll) */
  fresh: string[]
  loadedAt: number
}

const docKey = () => `shell:${location.pathname}`
function loadPrefs(): Record<Side, SideLayout> {
  try {
    const p = JSON.parse(localStorage.getItem(docKey()) ?? 'null')
    if (p?.left && p?.right) return p
  } catch {
    /* private mode */
  }
  return { left: {}, right: {} }
}

export const shell = reactive({
  config: null as ShellConfig | null,
  configError: null as string | null,
  connected: false,
  prefs: loadPrefs(),
  activity: [] as Activity[],
  files: {} as Record<string, FileState>,
  /** last "show this" request (agent `panel open`, a click on a D-3 reference); n increments every time */
  focus: null as { panel: string; entry: string | null; n: number; at: number } | null,
  /** panels added since load: their tab pulses once */
  newPanels: [] as string[],
  /** unseen changes per panel (a file panel that is not the active tab) */
  unseen: {} as Record<string, number>,
  /** journal comments the user sent, per entry id (local echo) */
  sentComments: {} as Record<string, { text: string; at: number; seq?: number }[]>,
  /** last activity of the agent itself (header) */
  lastAgent: null as Activity | null,
})

export function savePrefs() {
  try {
    localStorage.setItem(docKey(), JSON.stringify(shell.prefs))
  } catch {
    /* ignore */
  }
}

export const panelsOn = (side: Side) => computed(() => (shell.config?.panels ?? []).filter((p) => p.side === side))

export function sideState(side: Side) {
  const conf = shell.config?.layout[side] ?? {}
  const pref = shell.prefs[side]
  const panels = (shell.config?.panels ?? []).filter((p) => p.side === side)
  const valid = (id?: string) => (id && panels.some((p) => p.id === id) ? id : undefined)
  return {
    width: pref.width ?? conf.width ?? 340,
    collapsed: pref.collapsed ?? conf.collapsed ?? false,
    active: valid(pref.active) ?? valid(conf.active) ?? panels[0]?.id ?? null,
    panels,
  }
}

export function setSide(side: Side, patch: SideLayout) {
  Object.assign(shell.prefs[side], patch)
  savePrefs()
}

export function panelById(id: string) {
  return shell.config?.panels.find((p) => p.id === id) ?? null
}

/** activate a panel's tab (and expand its sidebar) */
export function showPanel(id: string, entry: string | null = null) {
  const p = panelById(id)
  if (!p) return false
  setSide(p.side, { active: id, collapsed: false })
  delete shell.unseen[id]
  shell.focus = { panel: id, entry, n: (shell.focus?.n ?? 0) + 1, at: Date.now() }
  return true
}

export const panelTitle = (p: Panel) =>
  p.title ?? ({ outline: 'Outline', comments: 'Comments', activity: 'Activity', links: 'Links', iframe: 'Web', file: p.path?.split('/').pop() ?? 'File' } as Record<string, string>)[p.type]

// ---------------------------------------------------------------- journal (the first file panel rendered as journal)
export const journalPanel = computed(() => shell.config?.panels.find((p) => p.type === 'file' && p.render === 'journal') ?? null)
export const journalEntries = computed(() => {
  const p = journalPanel.value
  return (p && shell.files[p.id]?.entries) || []
})
export const journalIndex = computed(() => new Map(journalEntries.value.map((e) => [e.id, e])))

export function jumpToEntry(id: string) {
  const p = journalPanel.value
  if (!p || !journalIndex.value.has(id)) return false
  return showPanel(p.id, id)
}

// ---------------------------------------------------------------- loading + SSE
export async function loadFile(id: string, hint?: { added?: string[]; changed?: string[] }) {
  const r = (await (await fetch(`/shell/panels/${id}/content`)).json()) as { text: string; mtimeMs: number; missing?: boolean; render?: string }
  const prev = shell.files[id]
  const st: FileState = { text: r.text ?? '', mtimeMs: r.mtimeMs, missing: !!r.missing, version: (prev?.version ?? 0) + 1, fresh: [], loadedAt: Date.now() }
  if (r.render === 'journal') {
    st.entries = parseJournal(st.text).entries
    if (prev?.entries) {
      const old = new Map(prev.entries.map((e) => [e.id, e.body]))
      st.fresh = st.entries.filter((e) => old.get(e.id) !== e.body).map((e) => e.id)
    }
    if (hint) st.fresh = [...new Set([...st.fresh, ...(hint.added ?? []), ...(hint.changed ?? [])])].filter((x) => st.entries!.some((e) => e.id === x))
  }
  shell.files[id] = st
  const p = panelById(id)
  if (prev && p && sideState(p.side).active !== id) shell.unseen[id] = (shell.unseen[id] ?? 0) + Math.max(1, st.fresh.length)
}

function applyConfig(next: ShellConfig, initial: boolean) {
  const prev = shell.config
  if (prev && !initial) {
    // the agent changed a layout field explicitly → that wins over the viewer's preference for that field
    for (const side of ['left', 'right'] as Side[]) {
      for (const k of ['width', 'collapsed', 'active'] as const) {
        if (next.layout[side][k] !== undefined && next.layout[side][k] !== prev.layout[side][k]) (shell.prefs[side] as Record<string, unknown>)[k] = next.layout[side][k]
      }
    }
    savePrefs()
    const before = new Set(prev.panels.map((p) => p.id))
    const added = next.panels.filter((p) => !before.has(p.id)).map((p) => p.id)
    if (added.length) {
      shell.newPanels.push(...added)
      setTimeout(() => (shell.newPanels = shell.newPanels.filter((x) => !added.includes(x))), 4000)
    }
  }
  shell.config = next
  shell.configError = null
  for (const p of next.panels) {
    const old = prev?.panels.find((x) => x.id === p.id)
    if (p.type === 'file' && (!shell.files[p.id] || old?.path !== p.path || old?.render !== p.render)) {
      if (old && (old.path !== p.path || old.render !== p.render)) delete shell.files[p.id]
      void loadFile(p.id)
    }
  }
}

export function connectShell() {
  const es = new EventSource('/shell/events')
  es.addEventListener('hello', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { config: ShellConfig; error: string | null }
    const reconnect = shell.connected === false && shell.config !== null
    applyConfig(d.config, !shell.config)
    shell.configError = d.error
    shell.connected = true
    if (reconnect) for (const p of d.config.panels) if (p.type === 'file') void loadFile(p.id)
  })
  es.addEventListener('config', (e) => applyConfig((JSON.parse((e as MessageEvent).data) as { config: ShellConfig }).config, false))
  es.addEventListener('config-error', (e) => (shell.configError = (JSON.parse((e as MessageEvent).data) as { error: string }).error))
  es.addEventListener('file', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { panel: string; added?: string[]; changed?: string[] }
    void loadFile(d.panel, d)
  })
  es.addEventListener('focus', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { panel: string; entry: string | null }
    showPanel(d.panel, d.entry)
  })
  es.addEventListener('activity', (e) => addActivity(JSON.parse((e as MessageEvent).data) as Activity))
  es.onerror = () => (shell.connected = false)
  void fetch('/shell/activity')
    .then((r) => r.json())
    .then((d: { activity: Activity[] }) => d.activity.forEach(addActivity))
  return es
}

function addActivity(a: Activity) {
  if (shell.activity.some((x) => x.seq === a.seq)) return
  shell.activity.push(a)
  shell.activity.sort((x, y) => x.seq - y.seq)
  if (shell.activity.length > 300) shell.activity.shift()
  if (a.kind === 'agent' || a.kind === 'file') shell.lastAgent = a
}

export async function sendJournalComment(entry: JournalEntry, text: string, by: string) {
  const r = await fetch('/shell/journal-comment', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ panel: journalPanel.value?.id, entry: entry.id, summary: entry.summary, text, by }),
  })
  const d = (await r.json()) as { ok: boolean; seq?: number; error?: string }
  if (!d.ok) throw new Error(d.error)
  ;(shell.sentComments[entry.id] ??= []).push({ text, at: Date.now(), seq: d.seq })
  return d.seq
}

export function ago(ts: string | number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  return `${Math.floor(s / 3600)} h ago`
}
