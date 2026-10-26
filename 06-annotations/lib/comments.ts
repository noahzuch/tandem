// Server side of spike 06's comments:
//
//   events    observe the Y.Map('comments') of the live Y.Doc. A new thread with delivery 'now' (Comment in "immediate" mode,
//             or Ask agent) → `annotation_created`; a new user message in a thread the agent already knows → `annotation_reply`;
//             "Send all to agent" → ONE `review_submitted` with every draft. The thread remembers the event seq (`sentSeq`,
//             `delivered`) in the Y.Doc itself, so a restart or a second browser never re-emits it.
//             The browser never talks to the queue: the comment is the source of truth, the event is derived from it
//             (works for comments written offline too — they are emitted when they sync).
//   sidecar   .collab/<doc>.comments.json — written with every store. The Y.Doc sidecar (.ystate) already holds the
//             comments map; this JSON is the readable mirror and the recovery path when the .ystate is stale (file edited
//             while the server was down → Y.Doc rebuilt from HTML → relative positions are dead → re-anchor by quote).
//   rescue    after an agent op / external file merge: orphaned anchors whose quote is still in their block are re-anchored.
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { yToDocWithMapping } from './pipeline.ts'
import { leafTextAt } from '../src/islands/source.ts'
import type { EventQueue } from './eventQueue.ts'
import {
  allThreads,
  blockContext,
  findQuote,
  makeAnchor,
  rescueInBlock,
  rescueOrphans,
  resolveAll,
  textAround,
  threadsOf,
  type Author,
  type Message,
  type Resolved,
  type ThreadSnapshot,
} from '../src/comments/model.ts'

export const AGENT: Author = { name: 'Claude', kind: 'agent', color: '#7a4fc4' }
const ORIGIN = 'server-comments'

export interface Annotation {
  thread: string
  kind: string
  ask: boolean
  target: string
  status: string
  author: string
  body: string
  messages: { author: string; agent: boolean; text: string }[]
  quote: string
  prefix: string
  suffix: string
  section: string | null
  block: { id: string | null; type: string; text: string }
  leaf: { path: string; text: string } | null
  orphaned: boolean
}

export class CommentsService {
  readonly sidecarPath: string
  readonly stats = { eventsEmitted: 0, rescued: 0, restored: 0, restoredOrphaned: 0, sidecarWrites: 0 }
  private observed = new WeakSet<Y.Doc>()
  private scanTimer: NodeJS.Timeout | null = null

  constructor(
    dir: string,
    readonly name: string,
    private queue: EventQueue,
    private log: (m: string) => void = () => {},
  ) {
    this.sidecarPath = path.join(dir, `${name}.comments.json`)
  }

  // ---------------------------------------------------------------- describe (what the agent sees)
  describeAll(ydoc: Y.Doc, filter: (t: ThreadSnapshot) => boolean = () => true): Annotation[] {
    const { doc, meta } = yToDocWithMapping(ydoc)
    const resolved = resolveAll(ydoc, doc, meta.mapping)
    return allThreads(ydoc)
      .filter(filter)
      .map((t) => this.describe(t, resolved.get(t.id) ?? null, doc))
  }

  private describe(t: ThreadSnapshot, r: Resolved | null, doc: ReturnType<typeof yToDocWithMapping>['doc']): Annotation {
    let quote = t.quote
    let prefix = t.prefix
    let suffix = t.suffix
    let block = { id: t.blockId, type: '?', text: '' }
    let section: string | null = null
    if (r) {
      if (t.target === 'text') ({ quote, prefix, suffix } = textAround(doc, r.from, r.to))
      const b = blockContext(doc, r.from)
      block = { id: b.blockId, type: b.blockType, text: b.blockText }
      section = b.section
      if (t.target !== 'text') quote = t.leaf?.text ?? b.blockText.slice(0, 200)
    }
    return {
      thread: t.id,
      kind: t.kind,
      ask: t.ask,
      target: t.target,
      status: t.status,
      author: t.author.name,
      body: t.messages[0]?.text ?? '',
      messages: t.messages.map((m) => ({ author: m.author.name, agent: m.author.kind === 'agent', text: m.text })),
      quote,
      prefix,
      suffix,
      section,
      block,
      leaf: t.leaf,
      orphaned: !r,
    }
  }

  // ---------------------------------------------------------------- events
  attach(ydoc: Y.Doc) {
    if (this.observed.has(ydoc)) return
    this.observed.add(ydoc)
    threadsOf(ydoc).observeDeep((_e, tr) => {
      if (tr.origin === ORIGIN) return
      if (this.scanTimer) clearTimeout(this.scanTimer)
      this.scanTimer = setTimeout(() => this.scan(ydoc), 0)
    })
    this.scan(ydoc) // threads written while nobody listened (e.g. offline browser that synced during load)
  }

  private delivered(t: Y.Map<unknown>): Y.Map<number> {
    let d = t.get('delivered')
    if (!(d instanceof Y.Map)) {
      d = new Y.Map<number>()
      t.set('delivered', d) // only the server writes this key → no concurrent creation
    }
    return d as Y.Map<number>
  }

  scan(ydoc: Y.Doc) {
    const created: ThreadSnapshot[] = []
    const replies: { t: ThreadSnapshot; m: Message }[] = []
    for (const t of allThreads(ydoc)) {
      if (t.delivery === 'now' && t.sentSeq == null) created.push(t)
      else if (t.sentSeq != null || t.delivery === 'none') {
        const d = threadsOf(ydoc).get(t.id)!.get('delivered') as Y.Map<number> | undefined
        for (const m of t.messages) if (m.author.kind === 'user' && !d?.has(m.id)) replies.push({ t, m })
      }
    }
    if (!created.length && !replies.length) return
    const byId = new Map(this.describeAll(ydoc).map((a) => [a.thread, a]))
    const marks: { id: string; seq: number; msgIds: string[]; thread: boolean }[] = []
    for (const t of created) {
      const a = byId.get(t.id)!
      const ev = this.queue.add('annotation_created', { ...a, respond: respondHint(t.id) })
      marks.push({ id: t.id, seq: ev.seq, msgIds: t.messages.map((m) => m.id), thread: true })
    }
    for (const { t, m } of replies) {
      const a = byId.get(t.id)!
      const ev = this.queue.add('annotation_reply', { thread: t.id, kind: t.kind, quote: a.quote, orphaned: a.orphaned, author: m.author.name, text: m.text, messages: a.messages, respond: respondHint(t.id) })
      marks.push({ id: t.id, seq: ev.seq, msgIds: [m.id], thread: false })
    }
    this.stats.eventsEmitted += marks.length
    ydoc.transact(() => {
      for (const mk of marks) {
        const t = threadsOf(ydoc).get(mk.id)
        if (!t) continue
        if (mk.thread) t.set('sentSeq', mk.seq)
        const d = this.delivered(t)
        for (const id of mk.msgIds) d.set(id, mk.seq)
      }
    }, ORIGIN)
  }

  /** lavish-style review round: every open draft in ONE event */
  submitReview(ydoc: Y.Doc, by: string): { count: number; seq: number | null } {
    const drafts = allThreads(ydoc).filter((t) => t.delivery === 'review' && t.sentSeq == null && t.status === 'open')
    if (!drafts.length) return { count: 0, seq: null }
    const ids = new Set(drafts.map((t) => t.id))
    const annotations = this.describeAll(ydoc, (t) => ids.has(t.id))
    const ev = this.queue.add('review_submitted', {
      by,
      count: drafts.length,
      annotations,
      respond: 'per thread: npm run collab -- reply <thread> "<text>" [--resolve]; edit with npm run collab -- <edit op> …',
    })
    this.stats.eventsEmitted++
    ydoc.transact(() => {
      for (const t of drafts) {
        const m = threadsOf(ydoc).get(t.id)!
        m.set('sentSeq', ev.seq)
        const d = this.delivered(m)
        for (const msg of t.messages) d.set(msg.id, ev.seq)
      }
    }, ORIGIN)
    return { count: drafts.length, seq: ev.seq }
  }

  // ---------------------------------------------------------------- sidecar
  /**
   * Keep each thread's last-known quote/context (and label text, block id) in step with the document. They are what an
   * orphan shows, what the agent gets when the anchor is gone, and what re-anchoring after a rebuild searches for.
   */
  refresh(ydoc: Y.Doc) {
    const { doc, meta } = yToDocWithMapping(ydoc)
    const resolved = resolveAll(ydoc, doc, meta.mapping)
    const updates: { t: Y.Map<unknown>; fields: Record<string, unknown> }[] = []
    threadsOf(ydoc).forEach((t, id) => {
      const r = resolved.get(id)
      if (!r) return
      const fields: Record<string, unknown> = {}
      const target = t.get('target')
      if (target === 'text') Object.assign(fields, textAround(doc, r.from, r.to))
      else {
        const node = doc.nodeAt(r.from)
        const leaf = t.get('leaf') as { path: string; text: string } | null
        if (leaf && node?.type.name.startsWith('htmlIsland')) {
          const text = leafTextAt(String(node.attrs.html), leaf.path)
          if (text !== null) fields.leaf = { path: leaf.path, text }
          if (text !== null) fields.quote = text
        }
      }
      const bid = blockContext(doc, r.from).blockId
      if (bid) fields.blockId = bid
      for (const [k, v] of Object.entries(fields)) if (JSON.stringify(t.get(k)) === JSON.stringify(v)) delete fields[k]
      if (Object.keys(fields).length) updates.push({ t, fields })
    })
    if (!updates.length) return
    ydoc.transact(() => {
      for (const { t, fields } of updates) for (const [k, v] of Object.entries(fields)) t.set(k, v)
    }, ORIGIN)
  }

  writeSidecar(ydoc: Y.Doc) {
    const threads = allThreads(ydoc).map((t) => {
      const d = threadsOf(ydoc).get(t.id)?.get('delivered') as Y.Map<number> | undefined
      return { ...t, delivered: d ? d.toJSON() : {} }
    })
    const body = JSON.stringify({ version: 1, doc: this.name, threads }, null, 2)
    let current = ''
    try {
      current = fs.readFileSync(this.sidecarPath, 'utf8')
    } catch {
      /* none */
    }
    if (current === body) return
    fs.mkdirSync(path.dirname(this.sidecarPath), { recursive: true })
    fs.writeFileSync(this.sidecarPath, body)
    this.stats.sidecarWrites++
  }

  /** the Y.Doc was rebuilt from HTML: bring the threads back from the JSON sidecar, re-anchored by quote */
  restore(ydoc: Y.Doc) {
    let data: { threads: (ThreadSnapshot & { delivered?: Record<string, number> })[] }
    try {
      data = JSON.parse(fs.readFileSync(this.sidecarPath, 'utf8'))
    } catch {
      return
    }
    const { doc, meta } = yToDocWithMapping(ydoc)
    let orphaned = 0
    ydoc.transact(() => {
      for (const t of data.threads) {
        let r: Resolved | null = null
        if (t.target === 'text') r = rescueInBlock(doc, t.blockId, t.quote, t.prefix, t.suffix) ?? findQuote(doc, t.quote, t.prefix, t.suffix)
        else {
          doc.descendants((n, p) => {
            if (r) return false
            const isIsland = n.type.name.startsWith('htmlIsland')
            const hit = t.target === 'block' ? !!t.blockId && n.attrs.bid === t.blockId : isIsland && (t.leaf ? String(n.attrs.html).includes(`>${t.leaf.text}<`) : String(n.attrs.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').includes(t.quote.slice(0, 40)))
            if (hit) r = { from: p, to: p + n.nodeSize }
            return !hit
          })
        }
        if (!r) orphaned++
        const m = new Y.Map<unknown>()
        const msgs = new Y.Array<Message>()
        const d = new Y.Map<number>()
        for (const [k, v] of Object.entries(t)) if (!['messages', 'anchor', 'delivered'].includes(k)) m.set(k, v)
        m.set('anchor', r ? makeAnchor(ydoc, meta.mapping, (r as Resolved).from, (r as Resolved).to) : null)
        msgs.push(t.messages)
        m.set('messages', msgs)
        for (const [k, v] of Object.entries(t.delivered ?? {})) d.set(k, v)
        m.set('delivered', d)
        threadsOf(ydoc).set(t.id, m)
      }
    }, ORIGIN)
    this.stats.restored += data.threads.length
    this.stats.restoredOrphaned += orphaned
    this.log(`comments: restored ${data.threads.length} thread(s) from ${path.basename(this.sidecarPath)} by quote (${orphaned} orphaned)`)
  }

  rescue(ydoc: Y.Doc): string[] {
    const { doc, meta } = yToDocWithMapping(ydoc)
    const ids = rescueOrphans(ydoc, doc, meta.mapping, ORIGIN)
    if (ids.length) {
      this.stats.rescued += ids.length
      this.log(`comments: re-anchored ${ids.join(', ')} by quote (anchor lost in a block rewrite)`)
    }
    return ids
  }
}

export const respondHint = (id: string) => `npm run collab -- reply ${id} "<text>" [--resolve]`
