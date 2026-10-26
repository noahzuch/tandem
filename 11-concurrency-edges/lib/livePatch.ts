// Spike 08: the agent edits the LIVE document with Edit-tool ergonomics, without touching the file.
//
//   read    the live Y.Doc rendered exactly as the server would write the file (canonical body HTML, prettier),
//           optionally only one section, with line numbers, or as an outline with block ids + where human carets are.
//   patch   a list of {old, new, all?} search/replace edits (the Edit tool's old_string/new_string contract) applied to
//           that canonical HTML, then merged into the live doc as a 3-way merge against the snapshot the HTML was
//           rendered from. User typing that arrives while the patch is computed (prettier is async) is kept.
//   merge   the same 3-way merge for a whole file (P4 "export → edit a scratch copy → apply").
//
// Matching rules (what the agent is told on failure):
//   exact substring first; if that fails, whitespace-run-insensitive (a space in `old` matches any run of
//   whitespace incl. newlines + indentation), because the server re-wraps lines with prettier whenever the user types. 0 hits → NOT_FOUND with the closest block's CURRENT html (so the agent can retry without a re-read);
//   >1 hits without `all` → AMBIGUOUS with line numbers + context. Edits apply in order (like MultiEdit); all or nothing.
import * as Y from 'yjs'
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, updateYFragment } from '@tiptap/y-tiptap'
import { BLOCK_ID_ATTR } from '../src/extensions.ts'
import { bodyToDoc, docToBody, fragmentOf, htmlToBlocks, withBlockIds, yToDocWithMapping } from './pipeline.ts'
import { splitDocument } from './htmlDoc.ts'
import { withPositionMigration } from './migrate.ts'

export interface Edit {
  old: string
  new: string
  all?: boolean
}

export class PatchError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'AMBIGUOUS' | 'NO_CHANGE' | 'USER_IN_BLOCK' | 'USER_IN_SPAN' | 'BAD_REQUEST',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------- human carets (awareness)
export interface Caret {
  name: string
  pos: number
  /** index of the top-level block the caret is in */
  block: number
  bid: string | null
  text: string
  /** top-level node and innermost textblock the caret is in (instances of the doc passed to humanCarets) */
  top: PMNode | null
  textblock: PMNode | null
}

type AwarenessLike = { getStates(): Map<number, Record<string, unknown>>; clientID: number }

/** carets of everyone except the agent, resolved against the given Y.Doc/PM doc (same snapshot) */
export function humanCarets(ydoc: Y.Doc, awareness: AwarenessLike | null, doc: PMNode, mapping: Map<unknown, unknown>): Caret[] {
  if (!awareness) return []
  const out: Caret[] = []
  for (const [id, st] of awareness.getStates()) {
    if (id === awareness.clientID) continue
    const user = st.user as { name?: string } | undefined
    const cursor = st.cursor as { head?: unknown } | undefined
    if (!user?.name || user.name === 'Claude' || !cursor?.head) continue
    try {
      const rel = Y.createRelativePositionFromJSON(cursor.head)
      const pos = relativePositionToAbsolutePosition(ydoc, fragmentOf(ydoc), rel, mapping as never)
      if (pos === null) continue
      const { index, node } = topLevelAt(doc, pos)
      const $pos = doc.resolve(Math.min(pos, doc.content.size))
      const textblock = $pos.parent.isTextblock ? $pos.parent : null
      out.push({ name: user.name, pos, block: index, bid: (node?.attrs[BLOCK_ID_ATTR] as string) ?? null, text: (textblock ?? node)?.textContent.slice(0, 60) ?? '', top: node, textblock })
    } catch {
      /* unresolvable caret (deleted content) */
    }
  }
  return out
}

function topLevelAt(doc: PMNode, pos: number): { index: number; node: PMNode | null; from: number } {
  let index = -1
  let node: PMNode | null = null
  let from = 0
  doc.forEach((n, offset, i) => {
    if (index < 0 && pos >= offset && pos <= offset + n.nodeSize) {
      index = i
      node = n
      from = offset
    }
  })
  return { index, node, from }
}

// ---------------------------------------------------------------- reading
export interface Rendered {
  html: string
  doc: PMNode
  /** Y update of the snapshot `html` was rendered from (base of the 3-way merge) */
  base: Uint8Array
  /** short revision id: hash of the state vector */
  rev: string
}

/** snapshot the live doc synchronously, then render it (async: prettier). Concurrent updates after the snapshot are not in `html`. */
export async function render(ydoc: Y.Doc, pretty = true): Promise<Rendered & { mapping: Map<unknown, unknown> }> {
  const base = Y.encodeStateAsUpdate(ydoc)
  const { doc, meta } = yToDocWithMapping(ydoc)
  const sv = Y.encodeStateVector(ydoc)
  let h = 0
  for (const b of sv) h = (h * 31 + b) >>> 0
  const html = await docToBody(doc, pretty)
  return { html, doc, base, rev: h.toString(36), mapping: meta.mapping as Map<unknown, unknown> }
}

export interface OutlineEntry {
  line: number
  type: string
  bid: string | null
  id: string | null
  text: string
  carets: string[]
}

/** top-level blocks with the line they start at in the canonical HTML (top-level tags start at column 0) */
export function outline(html: string, doc: PMNode, carets: Caret[]): OutlineEntry[] {
  const lines = html.split('\n')
  const starts: number[] = []
  lines.forEach((l, i) => {
    if (/^<(?!\/)/.test(l)) starts.push(i + 1)
  })
  const out: OutlineEntry[] = []
  doc.forEach((node, _o, i) => {
    out.push({
      line: starts[i] ?? -1,
      type: node.type.name === 'heading' ? `h${node.attrs.level}` : node.type.name === 'container' ? `<${node.attrs.tag}>` : node.type.name,
      bid: (node.attrs[BLOCK_ID_ATTR] as string | null) ?? null,
      id: (node.attrs.htmlAttrs as Record<string, string> | null)?.id ?? null,
      text: (node.type.name.startsWith('htmlIsland') ? String(node.attrs.html) : node.textBetween(0, node.content.size, ' ', ' ')).replace(/\s+/g, ' ').trim().slice(0, 70),
      carets: carets.filter((c) => c.block === i).map((c) => c.name),
    })
  })
  return out
}

/** lines [from, to) of the section that starts with the heading containing `heading` (1-based, inclusive from) */
export function sectionLines(html: string, doc: PMNode, heading: string): { from: number; to: number; title: string } | null {
  const ol = outline(html, doc, [])
  const needle = heading.trim().toLowerCase()
  const i = ol.findIndex((e) => /^h\d$/.test(e.type) && e.text.toLowerCase().includes(needle))
  if (i < 0) return null
  const level = Number(ol[i].type.slice(1))
  let j = i + 1
  while (j < ol.length && !(/^h\d$/.test(ol[j].type) && Number(ol[j].type.slice(1)) <= level)) j++
  const total = html.split('\n').length
  return { from: ol[i].line, to: j < ol.length ? ol[j].line : total + 1, title: ol[i].text }
}

export const numbered = (html: string, from = 1, to = Infinity) =>
  html
    .split('\n')
    .map((l, i) => [i + 1, l] as const)
    .filter(([n]) => n >= from && n < to)
    .map(([n, l]) => `${String(n).padStart(4)}\t${l}`)
    .join('\n')

// ---------------------------------------------------------------- matching
interface Hit {
  index: number
  length: number
  fuzzy: boolean
}

const WS_RE = /((?:\s|&nbsp;| )+)/
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function fuzzyRegex(old: string): RegExp {
  let src = ''
  for (const part of old.trim().split(WS_RE)) {
    if (!part) continue
    // whitespace runs are interchangeable (prettier re-wraps lines whenever the document changes); whitespace
    // that is absent stays absent (between inline tags and text it is significant)
    if (!part.trim()) src += '\\s+'
    else src += escapeRe(part)
  }
  return new RegExp(src, 'g')
}

export function findAll(html: string, old: string): Hit[] {
  const hits: Hit[] = []
  for (let i = html.indexOf(old); i >= 0 && old; i = html.indexOf(old, i + old.length)) hits.push({ index: i, length: old.length, fuzzy: false })
  if (hits.length || !old.trim()) return hits
  for (const m of html.matchAll(fuzzyRegex(old))) if (m[0].length) hits.push({ index: m.index!, length: m[0].length, fuzzy: true })
  return hits
}

const lineOf = (s: string, index: number) => s.slice(0, index).split('\n').length

const words = (s: string) =>
  new Set(
    s
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .toLowerCase()
      .split(/[^\p{L}\p{N}_/-]+/u)
      .filter((w) => w.length > 2),
  )

/** the top-level chunk of `html` (lines from one column-0 tag to the next) that shares most words with `old` */
export function closestChunk(html: string, old: string): { line: number; html: string; score: number } | null {
  const want = words(old)
  if (!want.size) return null
  const lines = html.split('\n')
  let best: { line: number; html: string; score: number } | null = null
  let start = 0
  const flush = (end: number) => {
    if (end <= start) return
    const chunk = lines.slice(start, end).join('\n')
    const have = words(chunk)
    let common = 0
    for (const w of want) if (have.has(w)) common++
    const score = common / want.size
    if (!best || score > best.score) best = { line: start + 1, html: chunk.length > 1500 ? chunk.slice(0, 1500) + '\n…' : chunk, score }
    start = end
  }
  lines.forEach((l, i) => {
    if (i > 0 && /^<(?!\/)/.test(l)) flush(i)
  })
  flush(lines.length)
  return best && (best as { score: number }).score > 0 ? best : null
}

/** apply the edits to `html` in order; throws PatchError (nothing applied) on the first edit that does not match exactly once */
export function applyEdits(html: string, edits: Edit[]): { html: string; fuzzy: number[]; replaced: number[] } {
  let cur = html
  const fuzzy: number[] = []
  const replaced: number[] = []
  edits.forEach((e, k) => {
    if (typeof e.old !== 'string' || typeof e.new !== 'string') throw new PatchError('BAD_REQUEST', `edit ${k + 1}: old and new must be strings`)
    if (!e.old) throw new PatchError('BAD_REQUEST', `edit ${k + 1}: old is empty (use append-section / insert-after for pure inserts, or include an anchor in old)`)
    if (e.old === e.new) throw new PatchError('NO_CHANGE', `edit ${k + 1}: old and new are identical`)
    const hits = findAll(cur, e.old)
    if (hits.length === 0) {
      const near = closestChunk(cur, e.old)
      throw new PatchError(
        'NOT_FOUND',
        `edit ${k + 1}/${edits.length}: old string not found in the live document${k ? ' (after applying the previous edits of this patch)' : ''}. ` +
          `The document may have changed since you read it (the user is editing too), or the string never matched. ` +
          (near ? `The closest block is at line ${near.line}; its CURRENT html is in "closest". Copy old from there and retry.` : `Run \`collab read\` and copy old from it.`),
        { edit: k + 1, closest: near },
      )
    }
    if (hits.length > 1 && !e.all) {
      throw new PatchError('AMBIGUOUS', `edit ${k + 1}/${edits.length}: old string matches ${hits.length} times (lines ${hits.map((h) => lineOf(cur, h.index)).join(', ')}). Add surrounding context to make it unique, or set all=true to replace every occurrence.`, {
        edit: k + 1,
        matches: hits.map((h) => ({ line: lineOf(cur, h.index), context: cur.slice(Math.max(0, h.index - 40), h.index + h.length + 40) })),
      })
    }
    if (hits.some((h) => h.fuzzy)) fuzzy.push(k + 1)
    let out = ''
    let last = 0
    for (const h of hits) {
      // a fuzzy match ignores the old string's leading/trailing whitespace → drop the new string's too
      const repl = h.fuzzy ? e.new.trim() : e.new
      out += cur.slice(last, h.index) + repl
      last = h.index + h.length
    }
    cur = out + cur.slice(last)
    replaced.push(hits.length)
  })
  return { html: cur, fuzzy, replaced }
}

// ---------------------------------------------------------------- 3-way merge into the live doc
export interface Merged {
  updateBytes: number
  /** relative positions (valid in the live doc) of the first changed range, for the agent's caret */
  anchor: Y.RelativePosition | null
  head: Y.RelativePosition | null
  /** top-level block indices (in the base doc) the change touched */
  touched: [number, number] | null
  /** spike 11: what the update does to each human caret (see caretProbe) */
  caretImpact: CaretImpact[]
}

/**
 * Fork a Y.Doc at `base`, reconcile the fork to `target` (updateYFragment = y-prosemirror's own reconciler), and merge
 * the fork's update into `live`. Edits made in `live` after `base` (the user typing) are concurrent ops → kept.
 */
export function mergeInto(live: Y.Doc, base: Uint8Array, makeTarget: (baseDoc: PMNode, prefer: Set<PMNode>) => PMNode, origin: unknown, twoPass = true, awareness: AwarenessLike | null = null, apply = true): Merged {
  const fork = new Y.Doc()
  Y.applyUpdate(fork, base)
  const { doc: baseDoc, meta } = yToDocWithMapping(fork)
  const prefer = new Set(humanCarets(fork, awareness, baseDoc, meta.mapping as Map<unknown, unknown>).flatMap((c) => (c.top ? [c.top] : [])))
  // built from the FORK's doc: its node instances are the ones in the reconciler's mapping (identity = "unchanged")
  const target = makeTarget(baseDoc, prefer)
  if (baseDoc.eq(target)) {
    fork.destroy()
    return { updateBytes: 0, anchor: null, head: null, touched: null, caretImpact: [] }
  }
  const start = baseDoc.content.findDiffStart(target.content)
  const end = baseDoc.content.findDiffEnd(target.content)
  const sv = Y.encodeStateVector(fork)
  const probe = caretProbe(fork, awareness)
  withPositionMigration(fork, () => reconcile(fork, baseDoc, meta, target, twoPass, 'agent-merge', prefer, live)) // spike 11 PROTOTYPE (off unless --migrate-positions)
  const caretImpact = probe()
  const update = Y.encodeStateAsUpdate(fork, sv)
  let anchor: Y.RelativePosition | null = null
  let head: Y.RelativePosition | null = null
  let touched: [number, number] | null = null
  if (start != null && end) {
    const frag = fragmentOf(fork)
    const a = Math.min(start, target.content.size)
    const b = Math.min(Math.max(end.b, a), target.content.size)
    try {
      anchor = absolutePositionToRelativePosition(a, frag, meta.mapping)
      head = absolutePositionToRelativePosition(b, frag, meta.mapping)
    } catch {
      /* caret is cosmetic */
    }
    touched = [topLevelAt(baseDoc, start).index, topLevelAt(baseDoc, Math.max(start, end.a)).index]
  }
  if (apply) Y.applyUpdate(live, update, origin)
  fork.destroy()
  return { updateBytes: update.length, anchor, head, touched, caretImpact }
}

/** canonical body html (as the agent edited it) → PM doc with block ids (new blocks get fresh ids, duplicated ids are renewed) */
export function htmlToDoc(bodyHtml: string): PMNode {
  return withBlockIds(bodyToDoc(bodyHtml))
}

/** a whole file (shell + body) → PM doc */
export function fileToDoc(file: string): PMNode {
  return htmlToDoc(splitDocument(file).body)
}

/** top-level block index range [first, last] (in `base`) that differs from `target`, or null if equal */
export function touchedBlocks(base: PMNode, target: PMNode): [number, number] | null {
  const start = base.content.findDiffStart(target.content)
  const end = base.content.findDiffEnd(target.content)
  if (start == null || !end) return null
  return [topLevelAt(base, start).index, topLevelAt(base, Math.max(start, end.a)).index]
}

export const caretsIn = (carets: Caret[], range: [number, number] | null) => (range ? carets.filter((c) => c.block >= range[0] && c.block <= range[1]) : [])

// ---------------------------------------------------------------- block-level splice (found in the P1 run)
// Re-parsing the WHOLE html is not lossless for blocks the agent did not touch: a block that ends in a space the user
// just typed ("…the ops lead |") is rendered as "lead\n</p>", parses back without the space, and the 3-way merge then
// deletes the user's space ("leadreads", measured). So only the top-level blocks whose html text changed are parsed;
// every other block is taken from the base doc as is.

/** split canonical body html into top-level chunks (prettier puts every top-level tag at column 0) */
export function chunks(html: string): string[] {
  const out: string[] = []
  let cur: string[] = []
  for (const l of html.trim().split('\n')) {
    if (/^<(?!\/)/.test(l) && cur.length) {
      out.push(cur.join('\n'))
      cur = []
    }
    cur.push(l)
  }
  if (cur.length) out.push(cur.join('\n'))
  return out
}

/** `newHtml` as a doc, reusing the base doc's nodes for every unchanged top-level chunk. Falls back to a full parse when
 *  the chunks don't line up with the base doc's top-level nodes (e.g. an island with column-0 inner lines). */
export function spliceDoc(baseDoc: PMNode, baseHtml: string, newHtml: string): { doc: PMNode; spliced: boolean; parsedChunks: number } {
  const a = chunks(baseHtml)
  const b = chunks(newHtml)
  if (a.length !== baseDoc.childCount) return { doc: htmlToDoc(newHtml), spliced: false, parsedChunks: b.length }
  // LCS over the chunk strings: every new chunk that equals a base chunk (in order) reuses the base node
  const n = a.length
  const m = b.length
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const kids: PMNode[] = []
  let parsed = 0
  let pending: string[] = []
  const flush = () => {
    if (!pending.length) return
    const html = pending.join('\n')
    if (html.trim()) htmlToBlocks(html).forEach((nd) => kids.push(nd))
    parsed += pending.length
    pending = []
  }
  let i = 0
  let j = 0
  while (j < m) {
    if (i < n && a[i] === b[j]) {
      flush()
      kids.push(baseDoc.child(i))
      i++
      j++
    } else if (i < n && L[i + 1][j] >= L[i][j + 1]) i++ // base chunk deleted (or changed)
    else pending.push(b[j++]) // new / changed chunk
  }
  flush()
  const doc = baseDoc.type.create(baseDoc.attrs, Fragment.fromArray(kids))
  return { doc: withBlockIds(doc), spliced: true, parsedChunks: parsed }
}

// ---------------------------------------------------------------- node reuse (found in the P3 run)
// updateYFragment pairs Y elements with PM nodes by identity (its mapping) first, by equality second, and otherwise
// updates the LEFTMOST candidate in place. A re-parsed block has no identity, and `equalYTypePNode` fails on
// object-valued attrs and on a trailing space the html cannot carry. Measured: inserting a new <li> before an item the
// user was typing in rewrote THAT item's Y.Text into the new item ("Sync ).uses at most 2 % battery") and the user's
// sentence was torn apart. Fix: before reconciling, put the base doc's own node instances back wherever the target
// has an unchanged node (deep `eq`, or a textblock that differs only in whitespace), recursively, so the reconciler
// sees identity exactly where nothing changed and inserts/updates only the agent's nodes.

const normWs = (s: string) => s.replace(/\s+/g, ' ').trim()

/** same textblock up to whitespace (what an html round trip can't preserve): same type/attrs, same inline structure */
function wsEqual(a: PMNode, b: PMNode): boolean {
  if (!a.isTextblock || !b.isTextblock || !a.sameMarkup(b) || a.childCount !== b.childCount) return false
  if (normWs(a.textContent) !== normWs(b.textContent)) return false
  for (let i = 0; i < a.childCount; i++) {
    const x = a.child(i)
    const y = b.child(i)
    if (x.type !== y.type || !x.sameMarkup(y)) return false
    if (!x.isText && !x.eq(y)) return false
  }
  return true
}

const same = (a: PMNode, b: PMNode) => a === b || a.eq(b) || wsEqual(a, b)

function similarity(a: PMNode, b: PMNode): number {
  if (a.type !== b.type) return 0
  const wa = new Set(normWs(a.textContent).toLowerCase().split(' ').filter(Boolean))
  const wb = new Set(normWs(b.textContent).toLowerCase().split(' ').filter(Boolean))
  if (!wa.size && !wb.size) return 0.5
  let c = 0
  for (const w of wa) if (wb.has(w)) c++
  return (2 * c) / (wa.size + wb.size)
}

const bidOf = (n: PMNode) => (n.attrs[BLOCK_ID_ATTR] as string | null | undefined) ?? null

/**
 * Align the children of a base node with the children of its target version.
 * Two children MATCH when they are the same (deep eq / whitespace-equal) or carry the same block id (= the same block,
 * possibly modified by the agent). A weighted LCS picks which matches stay in place; when it has a choice (a move:
 * Yjs has no move op, one side gets deleted + re-created) it keeps, in this order: blocks with a user's caret (1000),
 * blocks the agent modified (10 — re-creating them would drop the user's concurrent typing in them), unchanged ones (1).
 * Unmatched children form gaps; inside a gap, changed children without ids are paired by text similarity.
 */
type Step = { kind: 'keep'; a: PMNode; b: PMNode } | { kind: 'gap'; as: PMNode[]; bs: PMNode[] }
function align(base: PMNode, target: PMNode, prefer?: Set<PMNode>): Step[] {
  const a: PMNode[] = []
  const b: PMNode[] = []
  base.forEach((n) => a.push(n))
  target.forEach((n) => b.push(n))
  const n = a.length
  const m = b.length
  const match = (x: PMNode, y: PMNode) => same(x, y) || (bidOf(x) !== null && bidOf(x) === bidOf(y) && x.type === y.type)
  const w = (x: PMNode, y: PMNode) => (prefer?.has(x) ? 1000 : same(x, y) ? 1 : 10)
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = Math.max(match(a[i], b[j]) ? L[i + 1][j + 1] + w(a[i], b[j]) : 0, L[i + 1][j], L[i][j + 1])
  const steps: Step[] = []
  let gap: { as: PMNode[]; bs: PMNode[] } = { as: [], bs: [] }
  const flush = () => {
    if (gap.as.length || gap.bs.length) steps.push({ kind: 'gap', ...gap })
    gap = { as: [], bs: [] }
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && match(a[i], b[j]) && L[i][j] === L[i + 1][j + 1] + w(a[i], b[j])) {
      flush()
      steps.push({ kind: 'keep', a: a[i++], b: b[j++] })
    } else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) gap.as.push(a[i++])
    else gap.bs.push(b[j++])
  }
  flush()
  return steps
}

/** inside a gap: pair changed base children with changed target children (same type, most similar, in order) */
function pairGap(as: PMNode[], bs: PMNode[]): Map<number, PMNode> {
  let from = 0
  const paired = new Map<number, PMNode>() // index in bs → base node
  for (const x of as) {
    let best = -1
    let bestSim = 0.5
    for (let k = from; k < bs.length; k++) {
      const s = similarity(x, bs[k])
      if (s > bestSim) {
        best = k
        bestSim = s
      }
    }
    if (best >= 0) {
      paired.set(best, x)
      from = best + 1
    }
  }
  return paired
}

const descend = (base: PMNode, target: PMNode) => base.type === target.type && !base.isLeaf && !target.isLeaf && !base.isTextblock && !target.isTextblock

/** `target` with the base's node instances wherever nothing changed (see above) */
export function reuseNodes(base: PMNode, target: PMNode, prefer?: Set<PMNode>): PMNode {
  if (same(base, target)) return base
  if (!descend(base, target)) return target
  const kids: PMNode[] = []
  for (const s of align(base, target, prefer)) {
    if (s.kind === 'keep') kids.push(same(s.a, s.b) ? s.a : reuseNodes(s.a, s.b))
    else {
      const paired = pairGap(s.as, s.bs)
      s.bs.forEach((y, k) => kids.push(paired.has(k) ? reuseNodes(paired.get(k)!, y) : y))
    }
  }
  return target.type.create(target.attrs, Fragment.fromArray(kids), target.marks)
}

/** the target for a 3-way merge: changed top-level chunks parsed, everything unchanged reused from `baseDoc` */
export function targetFromHtml(baseDoc: PMNode, baseHtml: string | null, newHtml: string, prefer?: Set<PMNode>): PMNode {
  return reuseNodes(baseDoc, spliceDoc(baseDoc, baseHtml ?? '', newHtml).doc, prefer)
}

/** `base` with only the in-place modifications of `target` applied: nodes paired with a changed counterpart are
 *  replaced by it (recursively), unpaired inserts are dropped, unpaired deletes are kept. Pass 1 of mergeInto. */
export function modsOnly(base: PMNode, target: PMNode, prefer?: Set<PMNode>): PMNode {
  if (same(base, target)) return base
  if (!descend(base, target)) return target
  const kids: PMNode[] = []
  for (const s of align(base, target, prefer)) {
    if (s.kind === 'keep') kids.push(same(s.a, s.b) ? s.a : modsOnly(s.a, s.b))
    else {
      const paired = pairGap(s.as, s.bs)
      const byBase = new Map<PMNode, PMNode>()
      for (const [k, x] of paired) byBase.set(x, s.bs[k])
      for (const x of s.as) kids.push(byBase.has(x) ? modsOnly(x, byBase.get(x)!) : x)
    }
  }
  return base.type.create(base.attrs, Fragment.fromArray(kids), base.marks)
}

/** reconcile the fork's fragment to `target` (two passes, see mergeInto). `meta.mapping` is updated in place. */
export function reconcile(fork: Y.Doc, baseDoc: PMNode, meta: { mapping: Map<unknown, unknown> }, target: PMNode, twoPass = true, origin = 'agent-merge', prefer?: Set<PMNode>, live?: Y.Doc) {
  if (!twoPass) {
    fork.transact(() => updateYFragment(fork, fragmentOf(fork), target, meta as never), origin)
    return
  }
  // pass 1: change the paired (modified) nodes IN PLACE, no inserts/deletes yet. Otherwise a gap like
  // [B] → [N, B'] (agent inserts N before B AND edits B) is resolved by the reconciler's left-first tie-break:
  // B's Y element becomes N, and the user's text/caret in B ends up in N (measured: caret-structural "both").
  let mods = modsOnly(baseDoc, target, prefer)
  if (!mods.eq(baseDoc))
    fork.transact(() => {
      if (fineTextDiff) mods = fineTextPrepass(baseDoc, mods, meta.mapping)
      updateYFragment(fork, fragmentOf(fork), mods, meta as never)
    }, `${origin}-1`)
  // pass 2: inserts/deletes; every node pass 1 already updated is now identical → identity in the new mapping
  const { doc: doc2, meta: meta2 } = yToDocWithMapping(fork)
  // keep pass 1's choices for moves: blocks modified in pass 1 or holding a caret stay in place in pass 2 as well
  const preferBids = new Set<string>()
  baseDoc.forEach((x, _o, i) => {
    const bid = bidOf(x)
    if (bid && (prefer?.has(x) || (i < mods.childCount && mods.child(i) !== x))) preferBids.add(bid)
  })
  const prefer2 = new Set<PMNode>()
  doc2.forEach((x) => {
    if (bidOf(x) && preferBids.has(bidOf(x)!)) prefer2.add(x)
  })
  // moved blocks are re-inserted with their CURRENT live content (withLiveMoves) — after the alignment, so a re-created
  // block is never mistaken for an in-place edit (that would re-apply the user's own text as agent ops = duplicates)
  const aligned = reuseNodes(doc2, target, prefer2)
  const target2 = live ? withLiveMoves(doc2, aligned, live) : aligned
  if (!doc2.eq(target2)) fork.transact(() => updateYFragment(fork, fragmentOf(fork), target2, meta2), `${origin}-2`)
  meta.mapping = meta2.mapping as Map<unknown, unknown>
}

/** carets whose textblock (or top-level block) does not survive into `target` by identity = the agent changed it */
export function caretsAffected(carets: Caret[], target: PMNode): Caret[] {
  const kept = new Set<PMNode>()
  target.descendants((n) => {
    kept.add(n)
  })
  return carets.filter((c) => (c.textblock ? !kept.has(c.textblock) : c.top ? !kept.has(c.top) : false))
}

/**
 * Moves (found in the P1/P4 runs): Yjs has no move, so a moved block is deleted + re-inserted, and the re-inserted
 * copy is the AGENT's copy — as old as the merge base (P1: the last store, up to ~3 s; P4: the export, minutes).
 * Whatever the user typed into that block since the base was lost. Fix: a top-level block that the agent moved without
 * changing it (same block id as a base block that is gone from its place, same content as in the base) is re-inserted
 * with its CURRENT content from the live doc.
 */
export function withLiveMoves(baseDoc: PMNode, target: PMNode, live: Y.Doc): PMNode {
  const kept = new Set<PMNode>()
  target.forEach((n) => kept.add(n))
  const gone = new Map<string, PMNode>()
  baseDoc.forEach((n) => {
    const bid = n.attrs[BLOCK_ID_ATTR] as string | undefined
    if (bid && !kept.has(n)) gone.set(bid, n)
  })
  if (!gone.size) return target
  let liveDoc: PMNode | null = null
  const kids: PMNode[] = []
  let changed = false
  target.forEach((n) => {
    const bid = n.attrs[BLOCK_ID_ATTR] as string | undefined
    const was = bid ? gone.get(bid) : undefined
    if (was && n !== was && same(was, n)) {
      liveDoc ??= yToDocWithMapping(live).doc
      let cur: PMNode | null = null
      ;(liveDoc as PMNode).forEach((l) => {
        if (!cur && l.attrs[BLOCK_ID_ATTR] === bid) cur = l
      })
      if (cur && !(cur as PMNode).eq(n)) {
        kids.push(cur)
        changed = true
        return
      }
    }
    kids.push(n)
  })
  return changed ? target.type.create(target.attrs, Fragment.fromArray(kids), target.marks) : target
}

// ---------------------------------------------------------------- spike 11 PROTOTYPE: fine-grained text diff
// y-tiptap's updateYText turns a changed textblock into ONE delete + ONE insert (lib0 simpleDiff: common prefix +
// common suffix). An agent edit that changes two words far apart therefore deletes and re-inserts everything between
// them, including what the user typed there, and the user's caret (a relative position on a now deleted character)
// falls back to the start of that span. This pre-pass applies the text change of every textblock that pass 1 modifies
// in place as a word-level diff (LCS over word/space/punctuation tokens, then common prefix/suffix inside each hunk),
// so updateYText afterwards only finds equal text (it still applies the marks via applyDelta).
// Only for textblocks whose Y element holds exactly one Y.XmlText and whose PM content is text only (no inline atoms).
let fineTextDiff = false
export const setFineTextDiff = (on: boolean) => {
  fineTextDiff = on
}
export const fineStats = { textblocks: 0, hunks: 0 }

export interface Hunk {
  index: number
  remove: number
  insert: string
}

/** word-level diff of a → b as hunks in ascending order (indices in a) */
export function fineDiff(a: string, b: string): Hunk[] {
  const tok = (s: string) => s.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? []
  const A = tok(a)
  const B = tok(b)
  const n = A.length
  const m = B.length
  const L: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  let pos = 0 // char offset in a
  let cur: { index: number; del: string; ins: string } | null = null
  const flush = () => {
    if (!cur) return
    // trim common prefix/suffix inside the hunk (character level)
    let p = 0
    while (p < cur.del.length && p < cur.ins.length && cur.del[p] === cur.ins[p]) p++
    let q = 0
    while (q < cur.del.length - p && q < cur.ins.length - p && cur.del[cur.del.length - 1 - q] === cur.ins[cur.ins.length - 1 - q]) q++
    if (cur.del.length - p - q > 0 || cur.ins.length - p - q > 0) hunks.push({ index: cur.index + p, remove: cur.del.length - p - q, insert: cur.ins.slice(p, cur.ins.length - q) })
    cur = null
  }
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      flush()
      pos += A[i].length
      i++
      j++
    } else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) {
      cur ??= { index: pos, del: '', ins: '' }
      cur.del += A[i]
      pos += A[i].length
      i++
    } else {
      cur ??= { index: pos, del: '', ins: '' }
      cur.ins += B[j]
      j++
    }
  }
  flush()
  return hunks
}

/** a whitespace-only deletion next to whitespace = the html round trip collapsed a run the user just typed ("qd4␣␣and"
 *  renders and re-parses as "qd4␣and"); the agent did not mean it (measured: the user's space vanished, "qh8and") */
const collapseOnly = (a: string, h: Hunk) => !h.insert && h.remove > 0 && /^\s+$/.test(a.slice(h.index, h.index + h.remove)) && (/\s/.test(a[h.index - 1] ?? '') || /\s/.test(a[h.index + h.remove] ?? ''))

/** returns `mods` with every textblock whose text the pre-pass changed replaced by its new text (so updateYText finds
 *  equal text and only applies marks) */
function fineTextPrepass(base: PMNode, mods: PMNode, mapping: Map<unknown, unknown>): PMNode {
  const yOf = new Map<PMNode, Y.XmlElement>()
  for (const [y, n] of mapping) if (y instanceof Y.XmlElement && !Array.isArray(n)) yOf.set(n as PMNode, y)
  const textOnly = (n: PMNode) => {
    let ok = true
    n.forEach((c) => {
      if (!c.isText) ok = false
    })
    return ok
  }
  const walk = (b: PMNode, m: PMNode): PMNode => {
    if (b === m) return m
    if (b.isTextblock && m.isTextblock) {
      if (b.type !== m.type || !textOnly(b) || !textOnly(m)) return m
      const el = yOf.get(b)
      const kids = el?.toArray() ?? []
      if (kids.length !== 1 || !(kids[0] instanceof Y.XmlText)) return m
      const yt = kids[0] as Y.XmlText
      const str = (yt.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === 'string' ? d.insert : '\u0000')).join('')
      if (str !== b.textContent) return m
      const hunks = fineDiff(str, m.textContent).filter((h) => !collapseOnly(str, h))
      let out = str
      for (const h of hunks.slice().reverse()) {
        if (h.remove) yt.delete(h.index, h.remove)
        if (h.insert) yt.insert(h.index, h.insert)
        out = out.slice(0, h.index) + h.insert + out.slice(h.index + h.remove)
      }
      fineStats.textblocks++
      fineStats.hunks += hunks.length
      if (out === m.textContent) return m
      // kept a collapsed space: the target must carry it too, or updateYText deletes it again (only for unmarked/uniform text)
      const marks = m.childCount ? m.child(0).marks : []
      let uniform = true
      m.forEach((c) => {
        if (!c.sameMarkup(m.child(0))) uniform = false
      })
      return uniform ? m.type.create(m.attrs, out ? m.type.schema.text(out, marks) : null, m.marks) : m
    }
    if (b.type === m.type && !b.isLeaf && b.childCount === m.childCount) {
      let changed = false
      const kids: PMNode[] = []
      for (let k = 0; k < b.childCount; k++) {
        const x = walk(b.child(k), m.child(k))
        if (x !== m.child(k)) changed = true
        kids.push(x)
      }
      return changed ? m.type.create(m.attrs, Fragment.fromArray(kids), m.marks) : m
    }
    return m
  }
  return walk(base, mods)
}

// ---------------------------------------------------------------- spike 11: what an update does to a human caret
// A caret is a Yjs relative position. y-tiptap creates it with assoc -1: "right after character X", X = the character
// LEFT of the caret. After a remote update the browser resolves it again:
//   none          X still exists → the caret stays exactly where it was (edits elsewhere in the block, even the word
//                 right after the caret, are harmless)
//   inside-span   X was deleted (it was inside the span the update deleted): the caret resolves to the START of the
//                 deleted span, and y-tiptap's simpleDiff makes ONE span from the first to the last changed character
//                 of a textblock → the user's next keystrokes land there (also when X is the last letter of a word
//                 the agent replaced: then they land before the replacement)
//   recreated     X's whole element was deleted (type change, re-created block): the position does not resolve and
//                 y-tiptap guesses (measured: the start of the next block) unless a position migration covers X
// Computed on the fork, so the server knows it BEFORE applying (dry run). Ignores position migrations.
export type Impact = 'none' | 'inside-span' | 'recreated'
export interface CaretImpact {
  name: string
  impact: Impact
}

/** call before changing `ydoc`; the returned function classifies every human caret afterwards */
export function caretProbe(ydoc: Y.Doc, awareness: AwarenessLike | null): () => CaretImpact[] {
  if (!awareness) return () => []
  // remember the Y.XmlText the caret's character lives in NOW: after a type change it is deleted and garbage collected
  // (its children become GC structs without a parent), so it cannot be found from the character afterwards
  const before: { name: string; rel: Y.RelativePosition; text: Y.ID | null }[] = []
  for (const [id, st] of awareness.getStates()) {
    if (id === awareness.clientID) continue
    const user = st.user as { name?: string } | undefined
    const cursor = st.cursor as { head?: unknown } | undefined
    if (!user?.name || user.name === 'Claude' || !cursor?.head) continue
    try {
      const rel = Y.createRelativePositionFromJSON(cursor.head)
      let text: Y.ID | null = rel.type
      if (rel.item) {
        const item = Y.getItem(ydoc.store, rel.item) as Y.Item
        text = (item.parent as Y.AbstractType<unknown> | null)?._item?.id ?? null
      }
      before.push({ name: user.name, rel, text })
    } catch {
      /* typed in flight: the fork does not have this character yet */
    }
  }
  const deleted = (id: Y.ID | null) => {
    if (!id) return false
    try {
      return (Y.getItem(ydoc.store, id) as { deleted: boolean }).deleted
    } catch {
      return false
    }
  }
  return () =>
    before.map(({ name, rel, text }): CaretImpact => {
      if (deleted(text)) return { name, impact: 'recreated' }
      if (rel.item && deleted(rel.item)) return { name, impact: 'inside-span' }
      return { name, impact: 'none' }
    })
}
