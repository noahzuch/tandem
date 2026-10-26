// Spike 06: comment threads that live NEXT TO the document in the same Y.Doc (anchoring model (b)).
//
//   ydoc.getMap('comments')            thread id → Y.Map (one per thread, so concurrent edits of two threads never collide)
//     thread.get('anchor')             { start, end } = Y.RelativePosition JSON into the 'default' XmlFragment, or null (orphaned)
//     thread.get('messages')           Y.Array<Message> (user and agent can reply at the same time: CRDT array, no LWW)
//     quote/prefix/suffix              W3C TextQuoteSelector-style text copy: shown for orphans, used to re-anchor after a
//                                      rebuild from HTML (sidecar stale), sent to the agent as context
//
// Anchor semantics ("inclusive edges", chosen by experiments/anchoring.ts):
//   start = relative position with assoc -1 on the character BEFORE the range (y-tiptap's default for text)
//   end   = relative position with assoc  0 on the character AFTER the range
// → typing at either edge extends the range, and a replace of the whole quoted text (agent fixes what the comment is
//   about) keeps the anchor on the new text. Deleting the whole quoted text collapses the range → orphaned.
//
// Shared by the browser (decorations, sidebar), the server (events, sidecar, re-anchoring) and the experiment.
import * as Y from 'yjs'
import type { Node as PMNode } from '@tiptap/pm/model'
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, type ProsemirrorMapping } from '@tiptap/y-tiptap'

export const COMMENTS_KEY = 'comments'
export const FRAGMENT_KEY = 'default'

export type Kind = 'comment' | 'question' | 'change' | 'approve'
export const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: 'comment', label: 'Comment', hint: 'a note; the agent may act on it' },
  { id: 'question', label: 'Question', hint: 'answer in the thread, do not edit' },
  { id: 'change', label: 'Change request', hint: 'edit the document, then reply + resolve' },
  { id: 'approve', label: 'Looks good', hint: 'no action needed' },
]
export type Target = 'text' | 'block' | 'island'
/** 'now' = event on creation; 'review' = draft until "Send all to agent"; 'none' = agent-created / never sent */
export type Delivery = 'now' | 'review' | 'none'

export interface Author {
  name: string
  kind: 'user' | 'agent'
  color?: string
}
export interface Message {
  id: string
  author: Author
  text: string
  ts: number
  /** event seq that delivered this message to the agent (user messages only) */
  sentSeq?: number | null
}
export interface AnchorJSON {
  start: unknown
  end: unknown
}
export interface ThreadSnapshot {
  id: string
  kind: Kind
  status: 'open' | 'resolved'
  target: Target
  anchor: AnchorJSON | null
  quote: string
  prefix: string
  suffix: string
  blockId: string | null
  /** island comments: the label inside the island (data-leaf-path) */
  leaf: { path: string; text: string } | null
  author: Author
  createdAt: number
  delivery: Delivery
  /** "ask agent" (explicit question to the agent) vs a plain comment */
  ask: boolean
  sentSeq: number | null
  resolvedBy: string | null
  resolvedAt: number | null
  messages: Message[]
  /** spike 08 suggestion mode: the agent's proposed patch ({old,new} html edits) + a text preview */
  proposal: { edits: { old: string; new: string; all?: boolean }[]; preview: string } | null
}

export const threadsOf = (ydoc: Y.Doc) => ydoc.getMap<Y.Map<unknown>>(COMMENTS_KEY)
export const fragmentOf = (ydoc: Y.Doc) => ydoc.getXmlFragment(FRAGMENT_KEY)

export function newId(prefix = 't'): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = prefix
  for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)]
  return s
}

export function snapshot(t: Y.Map<unknown>): ThreadSnapshot {
  const msgs = t.get('messages') as Y.Array<Message> | undefined
  return {
    id: t.get('id') as string,
    kind: (t.get('kind') as Kind) ?? 'comment',
    status: (t.get('status') as 'open' | 'resolved') ?? 'open',
    target: (t.get('target') as Target) ?? 'text',
    anchor: (t.get('anchor') as AnchorJSON | null) ?? null,
    quote: (t.get('quote') as string) ?? '',
    prefix: (t.get('prefix') as string) ?? '',
    suffix: (t.get('suffix') as string) ?? '',
    blockId: (t.get('blockId') as string | null) ?? null,
    leaf: (t.get('leaf') as { path: string; text: string } | null) ?? null,
    author: (t.get('author') as Author) ?? { name: '?', kind: 'user' },
    createdAt: (t.get('createdAt') as number) ?? 0,
    delivery: (t.get('delivery') as Delivery) ?? 'now',
    ask: !!t.get('ask'),
    sentSeq: (t.get('sentSeq') as number | null) ?? null,
    resolvedBy: (t.get('resolvedBy') as string | null) ?? null,
    resolvedAt: (t.get('resolvedAt') as number | null) ?? null,
    messages: msgs ? msgs.toArray() : [],
    proposal: (t.get('proposal') as ThreadSnapshot['proposal']) ?? null,
  }
}

export function allThreads(ydoc: Y.Doc): ThreadSnapshot[] {
  const out: ThreadSnapshot[] = []
  threadsOf(ydoc).forEach((t) => out.push(snapshot(t)))
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

// ---------------------------------------------------------------- anchors
/** relative positions for [from, to) in the CURRENT doc (mapping = y-tiptap's Y type → PM node map of that doc) */
export function makeAnchor(ydoc: Y.Doc, mapping: ProsemirrorMapping, from: number, to: number, variant: 'inclusive' | 'exclusive' = 'inclusive'): AnchorJSON {
  const frag = fragmentOf(ydoc)
  let start = absolutePositionToRelativePosition(from, frag, mapping)
  let end = absolutePositionToRelativePosition(to, frag, mapping)
  // y-tiptap encodes a text position as (XmlText, index, assoc -1) = "after the character before".
  const retarget = (rp: Y.RelativePosition, assoc: number) => {
    const abs = Y.createAbsolutePositionFromRelativePosition(rp, ydoc)
    if (!abs || !(abs.type instanceof Y.XmlText)) return rp
    return Y.createRelativePositionFromTypeIndex(abs.type, abs.index, assoc)
  }
  if (variant === 'inclusive') end = retarget(end, 0) // stick to the character after the range
  else {
    start = retarget(start, 0) // stick to the first character inside
    // end keeps assoc -1 = stick to the last character inside
  }
  return { start: Y.relativePositionToJSON(start), end: Y.relativePositionToJSON(end) }
}

export interface Resolved {
  from: number
  to: number
}

/** current [from, to) of an anchor, or null = orphaned (anchored content deleted / unknown items) */
export function resolveAnchor(ydoc: Y.Doc, mapping: ProsemirrorMapping, anchor: AnchorJSON | null): Resolved | null {
  if (!anchor) return null
  const frag = fragmentOf(ydoc)
  try {
    const from = relativePositionToAbsolutePosition(ydoc, frag, Y.createRelativePositionFromJSON(anchor.start), mapping)
    const to = relativePositionToAbsolutePosition(ydoc, frag, Y.createRelativePositionFromJSON(anchor.end), mapping)
    if (from === null || to === null || to <= from) return null
    return { from, to }
  } catch {
    return null
  }
}

/** an anchor that resolves to a range with no text and no atom (e.g. only the boundaries of an emptied paragraph) is orphaned too */
export function isEmptyRange(doc: PMNode, r: Resolved): boolean {
  let content = false
  doc.nodesBetween(r.from, r.to, (n) => {
    if (content) return false
    if ((n.isText && n.text!.trim()) || n.isAtom) content = true
    return !content
  })
  return !content
}

// ---------------------------------------------------------------- context (quote, prefix, suffix, block)
const LEAF = '￼'
export function textAround(doc: PMNode, from: number, to: number, n = 80) {
  const quote = doc.textBetween(from, to, '\n', LEAF)
  const prefix = doc.textBetween(Math.max(0, from - n * 2), from, '\n', LEAF).slice(-n)
  const suffix = doc.textBetween(to, Math.min(doc.content.size, to + n * 2), '\n', LEAF).slice(0, n)
  return { quote, prefix, suffix }
}

export interface BlockContext {
  blockId: string | null
  blockType: string
  blockText: string
  section: string | null
}
/** innermost block with a block id around `pos`, its text, and the nearest heading above it */
export function blockContext(doc: PMNode, pos: number): BlockContext {
  const $pos = doc.resolve(Math.min(pos, doc.content.size))
  let block: PMNode | null = null
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d)
    if (n.attrs.bid) {
      block = n
      break
    }
  }
  if (!block) block = $pos.depth > 0 ? $pos.node(1) : doc.nodeAt(pos)
  let section: string | null = null
  doc.nodesBetween(0, pos, (n, p) => {
    if (n.type.name === 'heading' && p < pos) section = n.textContent
    return true
  })
  const text = block ? (block.type.name.startsWith('htmlIsland') ? String(block.attrs.html).replace(/<[^>]+>/g, ' ') : block.textContent) : ''
  return {
    blockId: (block?.attrs.bid as string | null) ?? null,
    blockType: block?.type.name ?? 'doc',
    blockText: text.replace(/\s+/g, ' ').trim().slice(0, 500),
    section,
  }
}

/** all occurrences of `quote` in the doc text → doc ranges; pick the one whose surroundings match prefix/suffix best */
export function findQuote(doc: PMNode, quote: string, prefix = '', suffix = ''): Resolved | null {
  if (!quote) return null
  // walk textblocks; quotes spanning blocks are matched within the doc's flattened text with '\n' separators
  // positions are relative to the content start of `doc` (a doc, or any block node when called from rescueInBlock)
  const chars: { ch: string; pos: number }[] = []
  const visit = (node: PMNode, pos: number) => {
    if (chars.length) chars.push({ ch: '\n', pos: -1 })
    node.forEach((child, offset) => {
      const s = child.isText ? child.text! : LEAF
      for (let i = 0; i < s.length; i++) chars.push({ ch: s[i], pos: pos + 1 + offset + i })
    })
  }
  if (doc.isTextblock) visit(doc, -1)
  else
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true
      visit(node, pos)
      return false
    })
  const text = chars.map((c) => c.ch).join('')
  let best: { i: number; score: number } | null = null
  for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) {
    let score = 0
    const before = text.slice(Math.max(0, i - prefix.length), i)
    const after = text.slice(i + quote.length, i + quote.length + suffix.length)
    for (let k = 1; k <= Math.min(before.length, prefix.length) && before[before.length - k] === prefix[prefix.length - k]; k++) score++
    for (let k = 0; k < Math.min(after.length, suffix.length) && after[k] === suffix[k]; k++) score++
    if (!best || score > best.score) best = { i, score }
  }
  if (!best) return null
  const first = chars[best.i]
  const last = chars[best.i + quote.length - 1]
  if (first.pos < 0 || last.pos < 0) return null
  return { from: first.pos, to: last.pos + 1 }
}

// ---------------------------------------------------------------- mutations (one Y transaction each)
export interface NewThread {
  kind: Kind
  target: Target
  anchor: AnchorJSON
  quote: string
  prefix: string
  suffix: string
  blockId: string | null
  leaf?: { path: string; text: string } | null
  author: Author
  text: string
  delivery: Delivery
  ask?: boolean
}

export function createThread(ydoc: Y.Doc, t: NewThread, origin: unknown = 'comments'): string {
  const id = newId('t')
  ydoc.transact(() => {
    const m = new Y.Map<unknown>()
    const msgs = new Y.Array<Message>()
    m.set('id', id)
    m.set('kind', t.kind)
    m.set('status', 'open')
    m.set('target', t.target)
    m.set('anchor', t.anchor)
    m.set('quote', t.quote)
    m.set('prefix', t.prefix)
    m.set('suffix', t.suffix)
    m.set('blockId', t.blockId)
    m.set('leaf', t.leaf ?? null)
    m.set('author', t.author)
    m.set('createdAt', Date.now())
    m.set('delivery', t.delivery)
    m.set('ask', !!t.ask)
    m.set('sentSeq', null)
    m.set('resolvedBy', null)
    m.set('resolvedAt', null)
    if (t.text) msgs.push([{ id: newId('m'), author: t.author, text: t.text, ts: Date.now(), sentSeq: null }])
    m.set('messages', msgs)
    threadsOf(ydoc).set(id, m)
  }, origin)
  return id
}

export function addMessage(ydoc: Y.Doc, threadId: string, author: Author, text: string, origin: unknown = 'comments'): Message {
  const t = threadsOf(ydoc).get(threadId)
  if (!t) throw new Error(`no thread ${threadId}`)
  const msg: Message = { id: newId('m'), author, text, ts: Date.now(), sentSeq: null }
  ydoc.transact(() => (t.get('messages') as Y.Array<Message>).push([msg]), origin)
  return msg
}

export function setStatus(ydoc: Y.Doc, threadId: string, status: 'open' | 'resolved', by: string, origin: unknown = 'comments') {
  const t = threadsOf(ydoc).get(threadId)
  if (!t) throw new Error(`no thread ${threadId}`)
  ydoc.transact(() => {
    t.set('status', status)
    t.set('resolvedBy', status === 'resolved' ? by : null)
    t.set('resolvedAt', status === 'resolved' ? Date.now() : null)
  }, origin)
}

export function deleteThread(ydoc: Y.Doc, threadId: string, origin: unknown = 'comments') {
  ydoc.transact(() => threadsOf(ydoc).delete(threadId), origin)
}

/** threads whose anchor resolves to a range with content; everything else is orphaned */
export function resolveAll(ydoc: Y.Doc, doc: PMNode, mapping: ProsemirrorMapping): Map<string, Resolved | null> {
  const out = new Map<string, Resolved | null>()
  threadsOf(ydoc).forEach((t, id) => {
    const r = resolveAnchor(ydoc, mapping, (t.get('anchor') as AnchorJSON | null) ?? null)
    out.set(id, r && r.to <= doc.content.size && !isEmptyRange(doc, r) ? r : null)
  })
  return out
}

// ---------------------------------------------------------------- rescue (re-anchor by quote)
/** find `quote` inside the block with block id `bid` only (positions in `doc`) */
export function rescueInBlock(doc: PMNode, bid: string | null, quote: string, prefix = '', suffix = ''): Resolved | null {
  if (!bid || !quote) return null
  let hit: Resolved | null = null
  doc.descendants((n, p) => {
    if (hit) return false
    if (n.attrs.bid === bid) {
      const r = findQuote(n, quote, prefix, suffix)
      if (r) hit = { from: p + 1 + r.from, to: p + 1 + r.to }
      return false
    }
    return true
  })
  return hit
}

/**
 * Re-anchor text threads by their last-known quote, inside their own block only. Runs after an agent op / external file
 * merge, because y-prosemirror reconciles a rewritten paragraph (agent `set-block`, file edit) with ONE contiguous text
 * diff, which does one of two wrong things to an unchanged quote between two changes (experiments/anchoring.ts S5b):
 *   - orphaned: the quote was deleted + re-inserted, the anchor collapsed
 *   - drifted:  the anchor's edge characters were deleted, the range now spans the whole rewritten middle
 * Both are detected as "covered text ≠ last-known quote, but the quote is still in the block". A deliberate deletion or
 * rewrite of the quote itself (quote gone from the block) is left alone.
 */
export function rescueOrphans(ydoc: Y.Doc, doc: PMNode, mapping: ProsemirrorMapping, origin: unknown = 'comments-rescue'): string[] {
  const rescued: string[] = []
  const resolved = resolveAll(ydoc, doc, mapping)
  const todo: { t: Y.Map<unknown>; r: Resolved }[] = []
  threadsOf(ydoc).forEach((t, id) => {
    if (t.get('target') !== 'text') return
    const quote = t.get('quote') as string
    const cur = resolved.get(id)
    if (cur && doc.textBetween(cur.from, cur.to, '\n', LEAF) === quote) return
    const r = rescueInBlock(doc, t.get('blockId') as string | null, quote, t.get('prefix') as string, t.get('suffix') as string)
    if (r && (!cur || r.from !== cur.from || r.to !== cur.to)) todo.push({ t, r })
  })
  if (!todo.length) return rescued
  ydoc.transact(() => {
    for (const { t, r } of todo) {
      t.set('anchor', makeAnchor(ydoc, mapping, r.from, r.to))
      rescued.push(t.get('id') as string)
    }
  }, origin)
  return rescued
}
