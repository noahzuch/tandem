// The agent's edit operations, expressed on a ProseMirror doc and applied to a Y.Doc as minimal CRDT ops.
//
//   plan:   PM doc (from the Y fragment, with the Y→PM node mapping) → Transform
//   apply:  updateYFragment(ydoc, fragment, transformedDoc, mapping) — the same reconciler y-prosemirror's
//           sync plugin uses for local editor changes. Unchanged nodes keep their identity through the
//           Transform, so the mapping lets the reconciler skip them and only the touched block becomes ops.
//
// Used by the agent CLI (as a Hocuspocus client) and by the server's /agent/op endpoint (direct connection).
import type { Fragment, Node as PMNode } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import * as Y from 'yjs'
import { absolutePositionToRelativePosition, updateYFragment } from '@tiptap/y-tiptap'
import { BLOCK_ID_ATTR, BLOCK_ID_TYPES, generateBlockId } from '../src/extensions.ts'
import { fragmentOf, htmlToBlocks, yToDocWithMapping } from './pipeline.ts'

export type Op =
  | { op: 'replace-text'; find: string; replace: string; all?: boolean }
  | { op: 'insert-after-heading'; heading: string; html: string }
  | { op: 'append-section'; html: string }
  | { op: 'set-block'; id: string; html: string }
  | { op: 'set-island-text'; find: string; replace: string }
  /** insert `text` right after `find` (used by `type`, one character per call) */
  | { op: 'insert-after-text'; find: string; text: string }
  /** spike 08: insert HTML after the list item / table row / top-level block that contains `find` */
  | { op: 'insert-after'; find: string; html: string }
  /** spike 08: move the section starting at heading `heading` (up to the next heading of the same or higher level) before heading `before` ('$end' = to the end) */
  | { op: 'move-section'; heading: string; before: string }

export const OP_NAMES: Op['op'][] = ['replace-text', 'insert-after-heading', 'append-section', 'set-block', 'set-island-text', 'insert-after-text', 'insert-after', 'move-section']

/** top-level section of a heading: [heading, next heading of the same or higher level) */
function sectionRange(doc: PMNode, heading: string): { from: number; to: number; title: string } | null {
  const needle = heading.trim().toLowerCase()
  let from = -1
  let level = 0
  let title = ''
  let to = -1
  doc.forEach((node, pos) => {
    if (to >= 0) return
    if (from < 0) {
      if (node.type.name === 'heading' && node.textContent.trim().toLowerCase().includes(needle)) {
        from = pos
        level = node.attrs.level as number
        title = node.textContent
      }
      return
    }
    if (node.type.name === 'heading' && (node.attrs.level as number) <= level) to = pos
  })
  if (from < 0) return null
  if (to < 0) {
    const last = doc.lastChild
    to = last && last.type.name === 'paragraph' && last.content.size === 0 ? doc.content.size - last.nodeSize : doc.content.size
  }
  return { from, to, title }
}

export interface Plan {
  tr: Transform
  /** range in the NEW doc that the op touched (for the agent's caret / selection) */
  from: number
  to: number
  summary: string
}

interface TextHit {
  from: number
  to: number
}

/** find `needle` in the text of a textblock; inline leaves count as one position (￼), like textBetween */
function findText(doc: PMNode, needle: string, after = 0): TextHit | null {
  let hit: TextHit | null = null
  doc.descendants((node, pos) => {
    if (hit || !node.isTextblock) return
    let text = ''
    const offsets: number[] = [] // offsets[i] = doc pos of text char i
    node.forEach((child, offset) => {
      const s = child.isText ? child.text! : '￼'
      for (let i = 0; i < s.length; i++) offsets.push(pos + 1 + offset + i)
      text += s
    })
    const start = pos + 1 >= after ? 0 : Math.max(0, after - (pos + 1))
    const i = text.indexOf(needle, start)
    if (i >= 0) hit = { from: offsets[i], to: offsets[i + needle.length - 1] + 1 }
    return false
  })
  return hit
}

function findBlock(doc: PMNode, id: string): { node: PMNode; pos: number } | null {
  const bare = id.replace(/^#/, '')
  let found: { node: PMNode; pos: number } | null = null
  doc.descendants((node, pos) => {
    if (found || node.isText) return
    const htmlId = (node.attrs.htmlAttrs as Record<string, string> | null)?.id
    if (node.attrs[BLOCK_ID_ATTR] === bare || htmlId === bare || (id.startsWith('#') && htmlId === bare)) found = { node, pos }
  })
  return found
}

function findHeading(doc: PMNode, text: string): { node: PMNode; pos: number } | null {
  const needle = text.trim().toLowerCase()
  let found: { node: PMNode; pos: number } | null = null
  doc.descendants((node, pos) => {
    if (found || node.type.name !== 'heading') return
    if (node.textContent.trim().toLowerCase().includes(needle)) found = { node, pos }
  })
  return found
}

/** new blocks from agent HTML get ids; `keepId` carries an existing id over when exactly one block replaces one */
function assignIds(tr: Transform, from: number, to: number, keepId: string | null) {
  const nodes: { node: PMNode; pos: number }[] = []
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (BLOCK_ID_TYPES.includes(node.type.name) && pos >= from && pos + node.nodeSize <= to) nodes.push({ node, pos })
  })
  // the blocks directly inside the range's parent (the range may sit inside a container / list item)
  const parentDepth = tr.doc.resolve(from).depth
  const tops = nodes.filter((n) => tr.doc.resolve(n.pos).depth === parentDepth)
  for (const { node, pos } of nodes) {
    const id = keepId && tops.length === 1 && tops[0].node === node ? keepId : node.attrs[BLOCK_ID_ATTR] || generateBlockId()
    if (node.attrs[BLOCK_ID_ATTR] !== id) tr.setNodeMarkup(pos, undefined, { ...node.attrs, [BLOCK_ID_ATTR]: id })
  }
}

/** Transaction.insertText for a plain Transform: keeps the marks at `from` (same as typing there) */
function insertText(tr: Transform, text: string, from: number, to: number) {
  if (!text) {
    if (to > from) tr.delete(from, to)
    return
  }
  const $from = tr.doc.resolve(from)
  const marks = to > from ? tr.doc.nodeAt(from)?.marks ?? $from.marks() : $from.marks()
  tr.replaceWith(from, to, tr.doc.type.schema.text(text, marks))
}

export function planOp(doc: PMNode, op: Op): Plan {
  const tr = new Transform(doc)
  switch (op.op) {
    case 'replace-text': {
      let hit = findText(doc, op.find)
      if (!hit) throw new Error(`text not found: ${JSON.stringify(op.find)}`)
      let count = 0
      let first = -1
      let last = -1
      while (hit) {
        const from = tr.mapping.map(hit.from)
        const to = tr.mapping.map(hit.to)
        insertText(tr, op.replace, from, to)
        if (first < 0) first = from
        last = from + op.replace.length
        count++
        if (!op.all) break
        hit = findText(doc, op.find, hit.to)
      }
      return { tr, from: first, to: last, summary: `replaced ${count}× ${JSON.stringify(op.find)} → ${JSON.stringify(op.replace)}` }
    }
    case 'insert-after-text': {
      const hit = findText(doc, op.find)
      if (!hit) throw new Error(`text not found: ${JSON.stringify(op.find)}`)
      insertText(tr, op.text, hit.to, hit.to)
      return { tr, from: hit.to, to: hit.to + op.text.length, summary: `inserted ${JSON.stringify(op.text)} after ${JSON.stringify(op.find)}` }
    }
    case 'insert-after': {
      const hit = findText(doc, op.find)
      if (!hit) throw new Error(`text not found: ${JSON.stringify(op.find)}`)
      const $pos = doc.resolve(hit.from)
      let content: Fragment | null = null
      let at = -1
      for (let d = $pos.depth; d > 0; d--) {
        const n = $pos.node(d)
        const parent = $pos.node(d - 1)
        if (n.type.name === 'listItem' || n.type.name === 'taskItem') {
          const wrap = parent.type.name === 'orderedList' ? ['<ol>', '</ol>'] : parent.type.name === 'taskList' ? ['<ul data-type="taskList">', '</ul>'] : ['<ul>', '</ul>']
          content = htmlToBlocks(`${wrap[0]}${op.html}${wrap[1]}`).firstChild!.content
          at = $pos.after(d)
          break
        }
        if (n.type.name === 'tableRow') {
          content = htmlToBlocks(`<table><tbody>${op.html}</tbody></table>`).firstChild!.content
          at = $pos.after(d)
          break
        }
      }
      if (at < 0) {
        content = htmlToBlocks(op.html)
        at = $pos.after(1)
      }
      tr.insert(at, content!)
      assignIds(tr, at, at + content!.size, null)
      return { tr, from: at, to: at + content!.size, summary: `inserted ${content!.childCount} node(s) (${content!.firstChild?.type.name}) after the one containing ${JSON.stringify(op.find)}` }
    }
    case 'move-section': {
      const sec = sectionRange(doc, op.heading)
      if (!sec) throw new Error(`heading not found: ${JSON.stringify(op.heading)}`)
      let target: number
      if (op.before === '$end') {
        const last = doc.lastChild
        target = last && last.type.name === 'paragraph' && last.content.size === 0 ? doc.content.size - last.nodeSize : doc.content.size
      } else {
        const t = sectionRange(doc, op.before)
        if (!t) throw new Error(`heading not found: ${JSON.stringify(op.before)}`)
        target = t.from
      }
      if (target >= sec.from && target <= sec.to) throw new Error('target is inside the moved section')
      const slice = doc.slice(sec.from, sec.to).content
      tr.delete(sec.from, sec.to)
      const at = tr.mapping.map(target)
      tr.insert(at, slice)
      return { tr, from: at, to: at + slice.size, summary: `moved section "${sec.title}" (${slice.childCount} blocks) before ${op.before === '$end' ? 'the end' : JSON.stringify(op.before)}` }
    }
    case 'insert-after-heading': {
      const h = findHeading(doc, op.heading)
      if (!h) throw new Error(`heading not found: ${JSON.stringify(op.heading)}`)
      const blocks = htmlToBlocks(op.html)
      const at = h.pos + h.node.nodeSize
      tr.insert(at, blocks)
      assignIds(tr, at, at + blocks.size, null)
      return { tr, from: at, to: at + blocks.size, summary: `inserted ${blocks.childCount} block(s) after heading "${h.node.textContent}"` }
    }
    case 'append-section': {
      const blocks = htmlToBlocks(op.html)
      const last = doc.lastChild
      // StarterKit's TrailingNode keeps an empty paragraph at the end: insert before it
      const at = last && last.type.name === 'paragraph' && last.content.size === 0 ? doc.content.size - last.nodeSize : doc.content.size
      tr.insert(at, blocks)
      assignIds(tr, at, at + blocks.size, null)
      return { tr, from: at, to: at + blocks.size, summary: `appended ${blocks.childCount} block(s)` }
    }
    case 'set-block': {
      const b = findBlock(doc, op.id)
      if (!b) throw new Error(`block not found: ${op.id}`)
      const blocks: Fragment = htmlToBlocks(op.html)
      tr.replaceWith(b.pos, b.pos + b.node.nodeSize, blocks)
      assignIds(tr, b.pos, b.pos + blocks.size, (b.node.attrs[BLOCK_ID_ATTR] as string | null) ?? null)
      return { tr, from: b.pos, to: b.pos + blocks.size, summary: `replaced block ${op.id} (${b.node.type.name}) with ${blocks.childCount} block(s)` }
    }
    case 'set-island-text': {
      let found: { node: PMNode; pos: number } | null = null
      doc.descendants((node, pos) => {
        if (!found && (node.type.name === 'htmlIsland' || node.type.name === 'htmlIslandInline') && String(node.attrs.html).includes(op.find)) found = { node, pos }
      })
      if (!found) throw new Error(`no island contains ${JSON.stringify(op.find)}`)
      const { node, pos } = found as { node: PMNode; pos: number }
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, html: String(node.attrs.html).replace(op.find, op.replace) })
      return { tr, from: pos, to: pos + node.nodeSize, summary: `island: ${JSON.stringify(op.find)} → ${JSON.stringify(op.replace)} (whole html attribute rewritten)` }
    }
  }
}

export interface Applied {
  summary: string
  /** bytes of the Yjs update this op produced */
  updateBytes: number
  /** relative positions of the touched range in the new doc (for awareness cursor) */
  anchor: Y.RelativePosition
  head: Y.RelativePosition
  from: number
  to: number
}

/** Apply one op to a live Y.Doc. `origin` is the Yjs transaction origin (shows up in observers / Hocuspocus hooks). */
export function applyOp(ydoc: Y.Doc, op: Op, origin: unknown = 'agent'): Applied {
  const frag = fragmentOf(ydoc)
  const { doc, meta } = yToDocWithMapping(ydoc)
  const plan = planOp(doc, op)
  if (!plan.tr.steps.length) {
    const rel = absolutePositionToRelativePosition(plan.from, frag, meta.mapping)
    return { summary: `${plan.summary} (no change)`, updateBytes: 0, anchor: rel, head: rel, from: plan.from, to: plan.to }
  }
  const sv = Y.encodeStateVector(ydoc)
  ydoc.transact(() => updateYFragment(ydoc, frag, plan.tr.doc, meta), origin)
  const updateBytes = Y.encodeStateAsUpdate(ydoc, sv).length
  // the reconciler updated meta.mapping for the new doc → relative positions of the touched range
  const anchor = absolutePositionToRelativePosition(plan.from, frag, meta.mapping)
  const head = absolutePositionToRelativePosition(plan.to, frag, meta.mapping)
  return { summary: plan.summary, updateBytes, anchor, head, from: plan.from, to: plan.to }
}

/** relative positions of a range in the CURRENT doc (to point the agent's selection at the target before editing) */
export function locate(ydoc: Y.Doc, op: Op): { anchor: Y.RelativePosition; head: Y.RelativePosition } | null {
  const frag = fragmentOf(ydoc)
  const { doc, meta } = yToDocWithMapping(ydoc)
  let range: { from: number; to: number } | null = null
  if (op.op === 'replace-text' || op.op === 'insert-after-text' || op.op === 'insert-after') range = findText(doc, op.find)
  else if (op.op === 'move-section') {
    const s = sectionRange(doc, op.heading)
    if (s) range = { from: s.from, to: s.to }
  }
  else if (op.op === 'set-block') {
    const b = findBlock(doc, op.id)
    if (b) range = { from: b.pos, to: b.pos + b.node.nodeSize }
  } else if (op.op === 'insert-after-heading') {
    const h = findHeading(doc, op.heading)
    if (h) range = { from: h.pos + 1, to: h.pos + h.node.nodeSize - 1 }
  } else if (op.op === 'append-section') range = { from: doc.content.size, to: doc.content.size }
  else if (op.op === 'set-island-text') {
    doc.descendants((node, pos) => {
      if (!range && (node.type.name === 'htmlIsland' || node.type.name === 'htmlIslandInline') && String(node.attrs.html).includes(op.find)) range = { from: pos, to: pos + node.nodeSize }
    })
  }
  if (!range) return null
  const r = range as { from: number; to: number }
  return { anchor: absolutePositionToRelativePosition(r.from, frag, meta.mapping), head: absolutePositionToRelativePosition(r.to, frag, meta.mapping) }
}

/** html of the first island containing `find` (for the soft-lock check before set-island-text) */
export function findIslandHtml(doc: PMNode, find: string): string | null {
  let html: string | null = null
  doc.descendants((node) => {
    if (html === null && (node.type.name === 'htmlIsland' || node.type.name === 'htmlIslandInline') && String(node.attrs.html).includes(find)) html = node.attrs.html
  })
  return html
}

export interface BlockInfo {
  type: string
  bid: string | null
  id: string | null
  text: string
}

/** top-level blocks with their ids — how the agent sees the document ("list" command) */
export function listBlocks(doc: PMNode): BlockInfo[] {
  const out: BlockInfo[] = []
  doc.forEach((node) => {
    out.push({
      type: node.type.name === 'container' ? `container<${node.attrs.tag}>` : node.type.name,
      bid: (node.attrs[BLOCK_ID_ATTR] as string | null) ?? null,
      id: (node.attrs.htmlAttrs as Record<string, string> | null)?.id ?? null,
      text: node.type.name.startsWith('htmlIsland') ? String(node.attrs.html).replace(/\s+/g, ' ').slice(0, 70) : node.textContent.replace(/\s+/g, ' ').slice(0, 70),
    })
  })
  return out
}
