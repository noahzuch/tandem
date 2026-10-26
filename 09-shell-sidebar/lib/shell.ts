// Spike 09: the configurable shell around the editor.
//
// Config file: --shell <file>, default <docdir>/.collab/<doc>.shell.json (next to <doc>.comments.json). Hand-editable,
// and the agent changes it through the server (`collab panel add|set|remove|open`). The server watches the config file
// and every file panel's file and pushes changes to the browsers over SSE (GET /shell/events).
//
//   {
//     "version": 1,
//     "title": "Brainstorming · offline sync",          optional subtitle in the header
//     "layout": { "left":  { "width": 340, "collapsed": false, "active": "journal" },
//                 "right": { "width": 340, "active": "comments" } },
//     "panels": [                                         order in this array = tab order per side
//       { "id": "journal",  "type": "file", "title": "Journal", "path": "decisions.md", "render": "journal", "side": "left" },
//       { "id": "outline",  "type": "outline", "side": "left" },
//       { "id": "comments", "type": "comments", "side": "right" },
//       { "id": "activity", "type": "activity", "side": "right" },
//       { "id": "mockup",   "type": "file", "path": "banner.html", "render": "html", "side": "right" },
//       { "id": "ci",       "type": "iframe", "url": "http://localhost:3000", "side": "right" },
//       { "id": "links",    "type": "links", "links": [{ "title": "ADR 0007", "href": "https://…" }], "side": "right" }
//     ]
//   }
//
// File panel paths are relative to the document's directory (a brainstorm folder holds spec + decisions.md together).
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { parseJournal, diffEntries, type JournalEntry } from '../src/shell/journal.ts'

export type Side = 'left' | 'right'
export type PanelType = 'outline' | 'comments' | 'activity' | 'file' | 'iframe' | 'links'
export type Render = 'markdown' | 'journal' | 'html' | 'text'
export interface Panel {
  id: string
  type: PanelType
  title?: string
  side: Side
  path?: string
  render?: Render
  url?: string
  links?: { title: string; href: string }[]
}
export interface SideLayout {
  width?: number
  collapsed?: boolean
  active?: string
}
export interface ShellConfig {
  version: 1
  title?: string
  layout: { left: SideLayout; right: SideLayout }
  panels: Panel[]
}

export const PANEL_TYPES: PanelType[] = ['outline', 'comments', 'activity', 'file', 'iframe', 'links']
const RENDERS: Render[] = ['markdown', 'journal', 'html', 'text']

export function defaultConfig(): ShellConfig {
  // = spike 08's layout: outline left, comments right
  return {
    version: 1,
    layout: { left: { active: 'outline' }, right: { active: 'comments' } },
    panels: [
      { id: 'outline', type: 'outline', side: 'left' },
      { id: 'comments', type: 'comments', side: 'right' },
      { id: 'activity', type: 'activity', side: 'right' },
    ],
  }
}

export function guessRender(p: string): Render {
  if (/(^|\/)decisions\.md$|journal/i.test(p)) return 'journal'
  if (/\.(md|markdown)$/i.test(p)) return 'markdown'
  if (/\.html?$/i.test(p)) return 'html'
  return 'text'
}

/** validate + normalise; throws with every problem listed (the agent sees this text) */
export function validate(raw: unknown): ShellConfig {
  const errs: string[] = []
  const o = (raw ?? {}) as Record<string, unknown>
  if (o.version !== 1) errs.push('version: must be 1')
  const panels = Array.isArray(o.panels) ? (o.panels as Record<string, unknown>[]) : (errs.push('panels: must be an array'), [])
  const ids = new Set<string>()
  const out: Panel[] = []
  panels.forEach((p, i) => {
    const at = `panels[${i}]`
    const type = p.type as PanelType
    if (!PANEL_TYPES.includes(type)) return errs.push(`${at}.type: one of ${PANEL_TYPES.join(', ')}`)
    const id = String(p.id ?? (type === 'file' || type === 'iframe' || type === 'links' ? '' : type))
    if (!/^[\w-]+$/.test(id)) return errs.push(`${at}.id: required for ${type} panels, [A-Za-z0-9_-]+`)
    if (ids.has(id)) return errs.push(`${at}.id: duplicate "${id}"`)
    ids.add(id)
    const side = (p.side ?? 'right') as Side
    if (side !== 'left' && side !== 'right') errs.push(`${at}.side: left | right`)
    const panel: Panel = { id, type, side, ...(p.title ? { title: String(p.title) } : {}) }
    if (type === 'file') {
      if (typeof p.path !== 'string' || !p.path) errs.push(`${at}.path: required for file panels`)
      panel.path = String(p.path ?? '')
      panel.render = (p.render as Render) ?? guessRender(panel.path)
      if (!RENDERS.includes(panel.render)) errs.push(`${at}.render: one of ${RENDERS.join(', ')}`)
    }
    if (type === 'iframe') {
      if (typeof p.url !== 'string' || !/^https?:\/\//.test(p.url)) errs.push(`${at}.url: http(s) URL required for iframe panels`)
      panel.url = String(p.url ?? '')
    }
    if (type === 'links') {
      const links = Array.isArray(p.links) ? (p.links as { title?: unknown; href?: unknown }[]) : []
      panel.links = links.map((l) => ({ title: String(l.title ?? l.href ?? ''), href: String(l.href ?? '') }))
    }
    out.push(panel)
  })
  const lay = (o.layout ?? {}) as Record<string, SideLayout>
  const side = (s: Side): SideLayout => {
    const l = lay[s] ?? {}
    const r: SideLayout = {}
    if (l.width !== undefined) r.width = Math.max(200, Math.min(720, Number(l.width) || 320))
    if (l.collapsed !== undefined) r.collapsed = !!l.collapsed
    if (l.active !== undefined) r.active = String(l.active)
    return r
  }
  if (errs.length) throw new Error(`invalid shell config:\n  ${errs.join('\n  ')}`)
  return { version: 1, ...(o.title ? { title: String(o.title) } : {}), layout: { left: side('left'), right: side('right') }, panels: out }
}

export interface Activity {
  seq: number
  ts: string
  /** agent | user | file | shell | event */
  kind: string
  text: string
  /** journal ids an entry is about (click → jump) */
  ids?: string[]
}

type Client = http.ServerResponse

export class ShellService {
  config: ShellConfig
  readonly configPath: string
  readonly docDir: string
  readonly activity: Activity[] = []
  readonly stats = { configLoads: 0, configWrites: 0, configErrors: 0, fileChanges: 0, sseClients: 0, broadcasts: 0 }
  lastError: string | null = null
  private clients = new Set<Client>()
  private seq = 0
  private lastWritten = ''
  private watchers = new Map<string, fs.FSWatcher>()
  private fileState = new Map<string, { sig: string; entries?: JournalEntry[] }>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(docPath: string, configPath: string | undefined, private log: (m: string) => void) {
    this.docDir = path.dirname(docPath)
    this.configPath = configPath ? path.resolve(configPath) : path.join(this.docDir, '.collab', `${path.basename(docPath)}.shell.json`)
    this.config = this.load() ?? defaultConfig()
    this.rewatch()
  }

  private load(): ShellConfig | null {
    let text: string
    try {
      text = fs.readFileSync(this.configPath, 'utf8')
    } catch {
      return null
    }
    try {
      const c = validate(JSON.parse(text))
      this.lastWritten = text // late watcher events for this same content are no-ops
      this.stats.configLoads++
      this.lastError = null
      return c
    } catch (e) {
      this.stats.configErrors++
      this.lastError = (e as Error).message
      this.log(`shell config ${this.configPath}: ${this.lastError}`)
      return null
    }
  }

  resolve(p: Panel) {
    return path.resolve(this.docDir, p.path ?? '')
  }

  // ---------------------------------------------------------------- watching (config + file panels)
  /** watch the DIRECTORY of each file (editors and the Write tool replace files: a watch on the file itself dies) */
  private rewatch() {
    const want = new Map<string, Set<string>>() // dir → basenames
    const add = (f: string) => {
      const d = path.dirname(f)
      if (!want.has(d)) want.set(d, new Set())
      want.get(d)!.add(path.basename(f))
    }
    add(this.configPath)
    for (const p of this.config.panels) if (p.type === 'file') add(this.resolve(p))
    for (const [d, w] of this.watchers) if (!want.has(d)) (w.close(), this.watchers.delete(d))
    for (const d of want.keys()) {
      if (this.watchers.has(d)) continue
      try {
        fs.mkdirSync(d, { recursive: true })
        const w = fs.watch(d, (_ev, name) => name && this.onFsEvent(path.join(d, name.toString())))
        this.watchers.set(d, w)
      } catch (e) {
        this.log(`cannot watch ${d}: ${(e as Error).message}`)
      }
    }
    for (const p of this.config.panels) if (p.type === 'file' && !this.fileState.has(p.id)) this.fileState.set(p.id, this.snapshot(p))
  }

  private onFsEvent(file: string) {
    // coalesce the burst of events of one write (40 ms), then compare content signatures
    clearTimeout(this.timers.get(file))
    this.timers.set(
      file,
      setTimeout(() => {
        this.timers.delete(file)
        if (file === this.configPath) return this.onConfigFile()
        for (const p of this.config.panels) if (p.type === 'file' && this.resolve(p) === file) this.onPanelFile(p)
      }, 40),
    )
  }

  private onConfigFile() {
    let text = ''
    try {
      text = fs.readFileSync(this.configPath, 'utf8')
    } catch {
      return
    }
    if (text === this.lastWritten) return // our own write
    const c = this.load()
    if (!c) {
      this.broadcast('config-error', { error: this.lastError })
      this.addActivity('shell', `config not applied: ${this.lastError}`)
      return
    }
    this.config = c
    this.rewatch()
    this.addActivity('shell', `config reloaded from disk (${c.panels.length} panels)`)
    this.broadcast('config', { config: c })
  }

  private snapshot(p: Panel): { sig: string; entries?: JournalEntry[]; text?: string } {
    try {
      const f = this.resolve(p)
      const text = fs.readFileSync(f, 'utf8')
      return { sig: `${text.length}:${hash(text)}`, entries: p.render === 'journal' ? parseJournal(text).entries : undefined }
    } catch {
      return { sig: 'missing' }
    }
  }

  private onPanelFile(p: Panel) {
    const before = this.fileState.get(p.id)
    const now = this.snapshot(p)
    if (before?.sig === now.sig) return
    this.fileState.set(p.id, now)
    this.stats.fileChanges++
    const data: Record<string, unknown> = { panel: p.id, path: p.path, missing: now.sig === 'missing' }
    let text = `${p.path} changed`
    if (p.render === 'journal' && now.entries) {
      const d = diffEntries(before?.entries ?? [], now.entries)
      data.added = d.added.map((e) => e.id)
      data.changed = d.changed.map((e) => e.id)
      if (d.added.length) text = `${p.path}: +${d.added.map((e) => `${e.id} “${e.summary.slice(0, 60)}”`).join(', ')}`
      else if (d.changed.length) text = `${p.path}: changed ${d.changed.map((e) => e.id).join(', ')}`
      this.addActivity('file', text, [...d.added, ...d.changed].map((e) => e.id))
    } else this.addActivity('file', text)
    this.broadcast('file', data)
  }

  // ---------------------------------------------------------------- mutations (server/CLI)
  save(next: ShellConfig, why: string) {
    const c = validate(next)
    this.config = c
    const text = JSON.stringify(c, null, 2) + '\n'
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
    this.lastWritten = text
    fs.writeFileSync(this.configPath, text)
    this.stats.configWrites++
    this.rewatch()
    this.addActivity('shell', why)
    this.broadcast('config', { config: c })
    return c
  }

  addPanel(p: Partial<Panel> & { index?: number; open?: boolean }) {
    const { index, open, ...panel } = p
    const cfg = structuredClone(this.config)
    if (!panel.id) panel.id = panel.type === 'file' ? slug(panel.title ?? path.basename(panel.path ?? 'file', path.extname(panel.path ?? ''))) : String(panel.type)
    if (cfg.panels.some((x) => x.id === panel.id)) throw new Error(`a panel with id "${panel.id}" exists (use "panel set" or another --id)`)
    panel.side ??= 'right'
    insertAt(cfg, panel as Panel, index)
    if (open) cfg.layout[panel.side].active = panel.id
    return this.save(cfg, `panel added: ${panel.title ?? panel.id} (${panel.type}${panel.path ? ` ${panel.path}` : ''}) → ${panel.side}`)
  }

  updatePanel(id: string, patch: Partial<Panel> & { index?: number }) {
    const cfg = structuredClone(this.config)
    const i = cfg.panels.findIndex((x) => x.id === id)
    if (i < 0) throw new Error(`no panel "${id}" (have: ${cfg.panels.map((p) => p.id).join(', ')})`)
    const { index, ...rest } = patch
    const p = { ...cfg.panels[i], ...rest } as Panel
    cfg.panels.splice(i, 1)
    insertAt(cfg, p, index ?? (rest.side && rest.side !== this.config.panels[i].side ? undefined : sideIndex(this.config, i)))
    return this.save(cfg, `panel changed: ${id} ${JSON.stringify(patch)}`)
  }

  removePanel(id: string) {
    const cfg = structuredClone(this.config)
    const before = cfg.panels.length
    cfg.panels = cfg.panels.filter((p) => p.id !== id)
    if (cfg.panels.length === before) throw new Error(`no panel "${id}"`)
    this.fileState.delete(id)
    return this.save(cfg, `panel removed: ${id}`)
  }

  setLayout(side: Side, l: SideLayout) {
    const cfg = structuredClone(this.config)
    cfg.layout[side] = { ...cfg.layout[side], ...l }
    return this.save(cfg, `layout ${side}: ${JSON.stringify(l)}`)
  }

  /** transient: tell the browsers to show a panel (and an entry in it) — not stored in the config */
  focus(panel: string, entry?: string) {
    if (!this.config.panels.some((p) => p.id === panel)) throw new Error(`no panel "${panel}"`)
    this.broadcast('focus', { panel, entry: entry ?? null })
    this.addActivity('agent', `showed ${panel}${entry ? ` → ${entry}` : ''}`, entry ? [entry] : undefined)
  }

  content(id: string) {
    const p = this.config.panels.find((x) => x.id === id)
    if (!p || p.type !== 'file') throw new Error(`no file panel "${id}"`)
    const f = this.resolve(p)
    try {
      const st = fs.statSync(f)
      return { id, path: p.path, abs: f, render: p.render, mtimeMs: st.mtimeMs, text: fs.readFileSync(f, 'utf8') }
    } catch {
      return { id, path: p.path, abs: f, render: p.render, mtimeMs: 0, text: '', missing: true }
    }
  }

  // ---------------------------------------------------------------- activity + SSE
  addActivity(kind: string, text: string, ids?: string[]) {
    const a: Activity = { seq: ++this.seq, ts: new Date().toISOString(), kind, text, ...(ids?.length ? { ids } : {}) }
    this.activity.push(a)
    if (this.activity.length > 300) this.activity.shift()
    this.broadcast('activity', a)
    return a
  }

  sse(req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(`event: hello\ndata: ${JSON.stringify({ config: this.config, error: this.lastError })}\n\n`)
    this.clients.add(res)
    this.stats.sseClients = this.clients.size
    const ping = setInterval(() => res.write(': ping\n\n'), 15000)
    req.on('close', () => {
      clearInterval(ping)
      this.clients.delete(res)
      this.stats.sseClients = this.clients.size
    })
  }

  broadcast(event: string, data: unknown) {
    this.stats.broadcasts++
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const c of this.clients) c.write(msg)
  }

  close() {
    for (const w of this.watchers.values()) w.close()
    for (const c of this.clients) c.end()
  }
}

function insertAt(cfg: ShellConfig, p: Panel, index?: number) {
  // index = position among the panels of the same side
  const same = cfg.panels.map((x, i) => [x, i] as const).filter(([x]) => x.side === p.side)
  if (index === undefined || index >= same.length) {
    const last = same.at(-1)
    cfg.panels.splice(last ? last[1] + 1 : cfg.panels.length, 0, p)
  } else cfg.panels.splice(same[Math.max(0, index)][1], 0, p)
}
function sideIndex(cfg: ShellConfig, i: number) {
  const side = cfg.panels[i].side
  return cfg.panels.slice(0, i).filter((p) => p.side === side).length
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'panel'
function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}
