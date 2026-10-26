// npm run anchoring — headless experiment: where does a comment's anchor live?
//
//   (a)  mark      a Tiptap `comment` mark (threadId attr, excludes '' so comments may overlap) inside the document
//   (b)  relpos    Y.RelativePosition start/end in a separate Y.Map next to the document (src/comments/model.ts),
//                  in two flavours: "inclusive" edges (start sticks to the char before, end to the char after — chosen)
//                  and "exclusive" edges (start sticks to the first char inside, end to the last char inside)
//
// Two Y.Docs ("user" in the browser, "agent" = Claude) edit concurrently and are synced afterwards, exactly like two
// Hocuspocus clients. User edits are ProseMirror transforms reconciled with updateYFragment (what y-prosemirror does for
// a keystroke); agent edits are the spike 07 agent ops (lib/agentOps.ts). Every scenario prints what each model shows
// afterwards; the `EXPECT` lines are the claims the README makes (exit 1 if one does not hold).
import { JSDOM } from 'jsdom'
import { Mark, getSchema, mergeAttributes } from '@tiptap/core'
import { DOMParser as PMDOMParser, DOMSerializer, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import * as Y from 'yjs'
import { initProseMirrorDoc, prosemirrorToYXmlFragment, updateYFragment } from '@tiptap/y-tiptap'
import fs from 'node:fs'
import path from 'node:path'
import { buildExtensions } from '../src/extensions.ts'
import { prepareForEditor } from '../src/islands/source.ts'
import { planOp, applyOp, type Op } from '../lib/agentOps.ts'
import { loadHtml, withBlockIds, schema as schemaB, docToRawBody } from '../lib/pipeline.ts'
import { makeAnchor, resolveAnchor, findQuote, isEmptyRange, rescueInBlock, type AnchorJSON } from '../src/comments/model.ts'
import { root } from '../lib/serverProc.ts'

// ---------------------------------------------------------------- schema with a comment mark (model a)
const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '', // several comments on the same text
  priority: 1100,
  addAttributes: () => ({ threadId: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute('data-comment'), renderHTML: (a: { threadId: string }) => ({ 'data-comment': a.threadId }) } }),
  parseHTML: () => [{ tag: 'span[data-comment]', priority: 100 }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes({ class: 'comment' }, HTMLAttributes), 0],
})
const schemaA: Schema = getSchema([...buildExtensions(), CommentMark])

const win = new JSDOM('<!DOCTYPE html><html><body></body></html>').window
const parse = (html: string, schema: Schema) => {
  const host = win.document.createElement('div')
  host.innerHTML = prepareForEditor(html).html
  return PMDOMParser.fromSchema(schema).parse(host as unknown as globalThis.Node)
}
const serialize = (doc: PMNode, schema: Schema) => {
  const wrap = win.document.createElement('div')
  DOMSerializer.fromSchema(schema).serializeFragment(doc.content, { document: win.document as unknown as Document }, wrap as unknown as HTMLElement)
  return wrap.innerHTML
}

// ---------------------------------------------------------------- Y helpers
const sample = fs.readFileSync(path.resolve(root, '../samples/spec.html'), 'utf8')
const FRAG = 'default'
function seed(): Uint8Array {
  const y = new Y.Doc()
  prosemirrorToYXmlFragment(withBlockIds(loadHtml(sample).doc), y.getXmlFragment(FRAG))
  return Y.encodeStateAsUpdate(y)
}
const seeded = seed()
function pair() {
  const user = new Y.Doc()
  const agent = new Y.Doc()
  Y.applyUpdate(user, seeded)
  Y.applyUpdate(agent, seeded)
  return { user, agent }
}
function sync(a: Y.Doc, b: Y.Doc) {
  const ua = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))
  const ub = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))
  Y.applyUpdate(b, ua)
  Y.applyUpdate(a, ub)
}
const pm = (y: Y.Doc, schema: Schema) => initProseMirrorDoc(y.getXmlFragment(FRAG), schema)
/** apply a ProseMirror edit to a Y.Doc the way y-prosemirror does for a local change */
function edit(y: Y.Doc, schema: Schema, fn: (tr: Transform, doc: PMNode) => void) {
  const { doc, meta } = pm(y, schema)
  const tr = new Transform(doc)
  fn(tr, doc)
  y.transact(() => updateYFragment(y, y.getXmlFragment(FRAG), tr.doc, meta), 'user')
}
/** like typing: the new text takes the marks the caret has at that position (respects inclusive: false) */
function typeText(tr: Transform, text: string, pos: number) {
  tr.insert(pos, tr.doc.type.schema.text(text, tr.doc.resolve(pos).marks()))
}
function findRange(doc: PMNode, needle: string): { from: number; to: number } {
  const r = findQuote(doc, needle)
  if (!r) throw new Error(`not found: ${needle}`)
  return r
}
const userInsert = (y: Y.Doc, schema: Schema, after: string, text: string) =>
  edit(y, schema, (tr, doc) => {
    const r = findRange(doc, after)
    typeText(tr, text, r.to)
  })
const userInsertBefore = (y: Y.Doc, schema: Schema, before: string, text: string) =>
  edit(y, schema, (tr, doc) => typeText(tr, text, findRange(doc, before).from))
const userDelete = (y: Y.Doc, schema: Schema, text: string) =>
  edit(y, schema, (tr, doc) => {
    const r = findRange(doc, text)
    tr.delete(r.from, r.to)
  })
/** agent op on schema A (marks): planOp works on any schema for text ops */
function agentOpA(y: Y.Doc, op: Op) {
  const { doc, meta } = pm(y, schemaA)
  const plan = planOp(doc, op)
  y.transact(() => updateYFragment(y, y.getXmlFragment(FRAG), plan.tr.doc, meta), 'agent')
}
function agentSetBlockA(y: Y.Doc, startsWith: string, html: string) {
  const { doc, meta } = pm(y, schemaA)
  let at = -1
  let node: PMNode | null = null
  doc.descendants((n, p) => {
    if (at < 0 && n.type.name === 'paragraph' && n.textContent.startsWith(startsWith)) {
      at = p
      node = n
    }
  })
  const blocks = parse(html, schemaA).content
  const tr = new Transform(doc)
  tr.replaceWith(at, at + node!.nodeSize, blocks)
  tr.setNodeMarkup(at, undefined, { ...tr.doc.nodeAt(at)!.attrs, bid: node!.attrs.bid })
  y.transact(() => updateYFragment(y, y.getXmlFragment(FRAG), tr.doc, meta), 'agent')
}
const bidOfPara = (doc: PMNode, startsWith: string) => {
  let id = ''
  doc.descendants((n) => {
    if (!id && n.type.name === 'paragraph' && n.textContent.startsWith(startsWith)) id = n.attrs.bid
  })
  return id
}

// ---------------------------------------------------------------- the two models behind one interface
interface Model {
  name: string
  /** add a comment on `quote` in doc y; returns a handle */
  add(y: Y.Doc, id: string, quote: string): void
  /** text each comment covers now, or null = gone/orphaned */
  covered(y: Y.Doc, id: string): string | null
}
const markModel: Model = {
  name: '(a) mark',
  add(y, id, quote) {
    edit(y, schemaA, (tr, doc) => {
      const r = findRange(doc, quote)
      tr.addMark(r.from, r.to, schemaA.marks.comment.create({ threadId: id }))
    })
  },
  covered(y, id) {
    const { doc } = pm(y, schemaA)
    let text = ''
    let found = false
    let last = -1
    doc.descendants((n, pos) => {
      if (!n.isText) return
      if (n.marks.some((m) => m.type.name === 'comment' && m.attrs.threadId === id)) {
        if (found && pos !== last) text += '…' // the mark got split into pieces
        text += n.text
        found = true
        last = pos + n.nodeSize
      }
    })
    return found ? text : null
  },
}
function relposModel(variant: 'inclusive' | 'exclusive'): Model & { anchors: Map<string, AnchorJSON> } {
  const anchors = new Map<string, AnchorJSON>()
  return {
    name: `(b) relpos ${variant}`,
    anchors,
    add(y, id, quote) {
      const { doc, meta } = pm(y, schemaB)
      const r = findRange(doc, quote)
      anchors.set(id, makeAnchor(y, meta.mapping, r.from, r.to, variant))
    },
    covered(y, id) {
      const { doc, meta } = pm(y, schemaB)
      const r = resolveAnchor(y, meta.mapping, anchors.get(id) ?? null)
      if (!r || isEmptyRange(doc, r)) return null
      return doc.textBetween(r.from, r.to, '\n', '￼')
    },
  }
}
const schemaOf = (m: Model) => (m === markModel ? schemaA : schemaB)
const agentOp = (m: Model, y: Y.Doc, op: Op) => (m === markModel ? agentOpA(y, op) : applyOp(y, op, 'agent'))

// ---------------------------------------------------------------- run
let failures = 0
const rows: string[][] = []
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'EXPECT ok  ' : 'EXPECT FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const show = (s: string | null) => (s === null ? '— (gone)' : JSON.stringify(s))
const models = () => [markModel, relposModel('inclusive'), relposModel('exclusive')]

function scenario(title: string, fn: (m: Model) => string | null): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const m of models()) out[m.name] = fn(m)
  rows.push([title, ...Object.values(out).map(show)])
  return out
}

// S1 concurrent: user types before and inside the anchor while the agent edits before and after it in the same paragraph
const s1 = scenario('S1 concurrent edits before/inside/after the anchor (user ∥ agent)', (m) => {
  const { user, agent } = pair()
  const s = schemaOf(m)
  m.add(user, 'c1', 'client-side queue')
  sync(user, agent)
  userInsert(user, s, 'Field technicians', ' and auditors') // before
  userInsert(user, s, 'client-side', ' (durable)') // inside
  agentOp(m, agent, { op: 'replace-text', find: 'conflict handling', replace: 'conflict resolution' }) // after
  agentOp(m, agent, { op: 'replace-text', find: 'Notes taken offline', replace: 'Notes written offline' }) // before
  sync(user, agent)
  const a = m.covered(user, 'c1')
  const b = m.covered(agent, 'c1')
  return a === b ? a : `${a} ≠ ${b}`
})
for (const [k, v] of Object.entries(s1)) expect(`S1 ${k}: highlight still covers exactly the (edited) quote on both peers`, v === 'client-side (durable) queue', show(v))

// S2 overlapping comments
const s2 = scenario('S2 two overlapping comments', (m) => {
  const { user, agent } = pair()
  m.add(user, 'c1', 'client-side queue')
  m.add(agent, 'c2', 'queue, the /sync endpoint')
  sync(user, agent)
  return `${m.covered(user, 'c1')} | ${m.covered(user, 'c2')}`
})
for (const [k, v] of Object.entries(s2)) expect(`S2 ${k}: both overlapping comments survive the sync`, v === 'client-side queue | queue, the /sync endpoint', String(v))

// S3 typing exactly at the edges
const s3 = scenario('S3 user types at the start edge ("X") and end edge ("Y")', (m) => {
  const { user } = pair()
  const s = schemaOf(m)
  m.add(user, 'c1', 'client-side queue')
  userInsertBefore(user, s, 'client-side queue', 'X')
  userInsert(user, s, 'Xclient-side queue', 'Y')
  return m.covered(user, 'c1')
})

// S4 the agent replaces exactly the quoted text (the typical "change request" fix)
const s4 = scenario('S4 agent replaces the whole quoted text (replace-text)', (m) => {
  const { user, agent } = pair()
  m.add(user, 'c1', 'client-side queue')
  sync(user, agent)
  agentOp(m, agent, { op: 'replace-text', find: 'client-side queue', replace: 'durable outbox' })
  sync(user, agent)
  return m.covered(user, 'c1')
})
expect('S4 (b) inclusive: anchor moves onto the replacement text', s4['(b) relpos inclusive'] === 'durable outbox', show(s4['(b) relpos inclusive']))
expect('S4 (b) exclusive: anchor collapses (orphaned) — why "exclusive" was rejected', s4['(b) relpos exclusive'] === null, show(s4['(b) relpos exclusive']))

// S5 the agent rewrites the whole paragraph from HTML (set-block, same node type). y-prosemirror reconciles a changed
// paragraph with ONE contiguous text diff (common prefix + common suffix): a change only after the quote keeps it in the
// common prefix; changes on BOTH sides of the quote put it inside the replaced middle.
const P_END =
  '<p>Field technicians lose connectivity on site. Notes taken offline must <strong>sync without data loss</strong> once the device is back online. This spec covers the <em>client-side queue</em>, the <code>/sync</code> endpoint and conflict handling.</p>'
const P_BOTH = P_END.replace('Field technicians', 'Field crews')
function setBlock(m: Model, html: string, rescue: boolean) {
  const { user, agent } = pair()
  m.add(user, 'c1', 'client-side queue')
  sync(user, agent)
  if (m === markModel) agentSetBlockA(agent, 'Field technicians', html)
  else applyOp(agent, { op: 'set-block', id: bidOfPara(pm(agent, schemaB).doc, 'Field technicians'), html }, 'agent')
  sync(user, agent)
  if (rescue && m !== markModel) {
    // server-side rescue after an agent op: re-anchor an orphan by its quote, but only inside its own block
    const rm = m as ReturnType<typeof relposModel>
    if (m.covered(user, 'c1') === null) {
      const { doc, meta } = pm(user, schemaB)
      const bid = bidOfPara(doc, 'Field technicians') || bidOfPara(doc, 'Field crews')
      const r = rescueInBlock(doc, bid, 'client-side queue', 'This spec covers the ', ', the /sync')
      if (r) rm.anchors.set('c1', makeAnchor(user, meta.mapping, r.from, r.to))
    }
  }
  return m.covered(user, 'c1')
}
const s5a = scenario('S5a agent set-block, paragraph changed only AFTER the quote', (m) => setBlock(m, P_END, false))
const s5b = scenario('S5b agent set-block, changed BEFORE and AFTER the quote', (m) => setBlock(m, P_BOTH, false))
const s5c = scenario('S5c = S5b + server rescue (re-anchor by quote within the same block)', (m) => (m === markModel ? null : setBlock(m, P_BOTH, true)))
expect("S5a (a) mark: the agent's HTML carries no comment mark → the comment silently disappears", s5a['(a) mark'] === null, show(s5a['(a) mark']))
expect('S5a (b) inclusive: quote in the common prefix of the text diff → anchor survives', s5a['(b) relpos inclusive'] === 'client-side queue', show(s5a['(b) relpos inclusive']))
expect('S5b (b) inclusive: quote inside the diff middle → anchor lost (y-prosemirror diffs a text as ONE replace)', s5b['(b) relpos inclusive'] === null, show(s5b['(b) relpos inclusive']))
expect('S5c (b) inclusive + rescue: re-anchored on the unchanged quote', s5c['(b) relpos inclusive'] === 'client-side queue', show(s5c['(b) relpos inclusive']))

// S6 the anchored text is deleted
const s6 = scenario('S6 user deletes the anchored text', (m) => {
  const { user, agent } = pair()
  m.add(user, 'c1', 'client-side queue')
  sync(user, agent)
  userDelete(user, schemaOf(m), 'client-side queue')
  sync(user, agent)
  return m.covered(agent, 'c1')
})
for (const [k, v] of Object.entries(s6)) expect(`S6 ${k}: deleted anchor → no range (orphan detectable)`, v === null, show(v))

// S6c delete, then type new text at the same spot (= a replace done in two steps)
const s6c = scenario('S6c user deletes the quote, then types "outbox" in its place', (m) => {
  const { user } = pair()
  const s = schemaOf(m)
  m.add(user, 'c1', 'client-side queue')
  userDelete(user, s, 'client-side queue')
  const orphanedInBetween = m.covered(user, 'c1') === null
  userInsert(user, s, 'This spec covers the ', 'outbox')
  return `${orphanedInBetween ? 'orphan → ' : ''}${show(m.covered(user, 'c1'))}`
})
expect('S6c (b) inclusive: re-attaches to the new text (replace semantics, same as S4)', s6c['(b) relpos inclusive'] === 'orphan → "outbox"', String(s6c['(b) relpos inclusive']))

// S6b the whole paragraph is deleted
const s6b = scenario('S6b user deletes the whole paragraph', (m) => {
  const { user, agent } = pair()
  m.add(user, 'c1', 'client-side queue')
  sync(user, agent)
  edit(user, schemaOf(m), (tr, doc) => {
    const r = findRange(doc, 'client-side queue')
    const $r = doc.resolve(r.from)
    tr.delete($r.before($r.depth), $r.after($r.depth))
  })
  sync(user, agent)
  return m.covered(agent, 'c1')
})
for (const [k, v] of Object.entries(s6b)) expect(`S6b ${k}: deleted paragraph → orphan`, v === null, show(v))

// S7 what ends up in the HTML file
const s7 = scenario('S7 saved HTML contains comment markup?', (m) => {
  const { user } = pair()
  m.add(user, 'c1', 'client-side queue')
  const html = m === markModel ? serialize(pm(user, schemaA).doc, schemaA) : docToRawBody(pm(user, schemaB).doc)
  const hit = /<span[^>]*data-comment="c1"[^>]*>/.exec(html)
  return hit ? hit[0].slice(0, 70) : 'clean'
})
expect('S7 (a) mark: the file carries <span data-comment> unless stripped on save', s7['(a) mark'] !== 'clean', String(s7['(a) mark']))
expect('S7 (b) relpos: the file stays clean', s7['(b) relpos inclusive'] === 'clean')

// S8 the HTML file is edited on disk (the agent's Edit tool) → spike 07's 3-way merge (fork at base → updateYFragment)
const s8 = scenario('S8 file edited on disk → 3-way merge (marks stripped on save)', (m) => {
  const { user } = pair()
  const s = schemaOf(m)
  m.add(user, 'c1', 'client-side queue')
  const base = Y.encodeStateAsUpdate(user)
  let doc = pm(user, s).doc
  if (m === markModel) {
    const tr = new Transform(doc)
    tr.removeMark(0, doc.content.size, schemaA.marks.comment) // strip-on-save: the file must stay a clean spec
    doc = tr.doc
  }
  const fileHtml = serialize(doc, s).replace('Field technicians', 'Field crews') // the external edit (same paragraph!)
  const fileDoc = parse(fileHtml, s)
  const fork = new Y.Doc()
  Y.applyUpdate(fork, base)
  const { meta } = pm(fork, s)
  const sv = Y.encodeStateVector(fork)
  fork.transact(() => updateYFragment(fork, fork.getXmlFragment(FRAG), fileDoc, meta), 'file')
  Y.applyUpdate(user, Y.encodeStateAsUpdate(fork, sv))
  const t = pm(user, s).doc.textContent
  if (!t.includes('Field crews')) return 'merge failed'
  return m.covered(user, 'c1')
})
expect('S8 (a) mark + strip-on-save: the merge removes every comment mark (file has none)', s8['(a) mark'] === null, show(s8['(a) mark']))
expect('S8 (b) relpos: anchor survives the 3-way merge', s8['(b) relpos inclusive'] === 'client-side queue', show(s8['(b) relpos inclusive']))

// S9 comments on an island (whole <figure>) and on a whole block — relpos only (a mark cannot sit on an atom block)
{
  const { user, agent } = pair()
  const { doc, meta } = pm(user, schemaB)
  let fig = -1
  let figSize = 0
  let para = -1
  let paraSize = 0
  doc.descendants((n, p) => {
    if (fig < 0 && n.type.name === 'htmlIsland' && String(n.attrs.html).startsWith('<figure')) {
      fig = p
      figSize = n.nodeSize
    }
    if (para < 0 && n.type.name === 'paragraph' && n.textContent.startsWith('Each save is pushed')) {
      para = p
      paraSize = n.nodeSize
    }
  })
  const aFig = makeAnchor(user, meta.mapping, fig, fig + figSize)
  const aPara = makeAnchor(user, meta.mapping, para, para + paraSize)
  sync(user, agent)
  applyOp(agent, { op: 'set-island-text', find: '>Sync server<', replace: '>Sync API<' }, 'agent')
  const bid = bidOfPara(pm(agent, schemaB).doc, 'Each save is pushed')
  applyOp(agent, { op: 'set-block', id: bid, html: '<p>Each save is pushed right away; the outbox stays empty.</p>' }, 'agent')
  userInsert(user, schemaB, 'Each operation carries', ' always') // unrelated concurrent typing
  sync(user, agent)
  const after = pm(user, schemaB)
  const rf = resolveAnchor(user, after.meta.mapping, aFig)
  const rp = resolveAnchor(user, after.meta.mapping, aPara)
  const nodeAtFig = rf ? after.doc.nodeAt(rf.from) : null
  const nodeAtPara = rp ? after.doc.nodeAt(rp.from) : null
  expect('S9 island anchor (relpos around the atom) still spans exactly the figure after the agent rewrote a label', !!rf && nodeAtFig?.type.name === 'htmlIsland' && rf.to - rf.from === nodeAtFig.nodeSize && String(nodeAtFig.attrs.html).includes('Sync API'))
  expect('S9 block anchor still spans exactly the paragraph after set-block (same type)', !!rp && nodeAtPara?.type.name === 'paragraph' && rp.to - rp.from === nodeAtPara.nodeSize && nodeAtPara.textContent.includes('right away'), nodeAtPara?.textContent)
  rows.push(['S9 island + block anchors (relpos) after agent edits', 'n/a (marks cannot cover an atom block; needs a node attr = in the file + LWW)', `island ✓ · block ✓ (${nodeAtPara?.textContent.slice(0, 30)}…)`, '—'])
}

// S10 sidecar stale (file edited while the server was down) → Y.Doc rebuilt from HTML → relpos are dead → re-anchor by quote
{
  const { user } = pair()
  const { doc, meta } = pm(user, schemaB)
  const r = findRange(doc, 'client-side queue')
  const anchor = makeAnchor(user, meta.mapping, r.from, r.to)
  const fresh = new Y.Doc()
  prosemirrorToYXmlFragment(withBlockIds(loadHtml(sample.replace('Field technicians', 'Field crews')).doc), fresh.getXmlFragment(FRAG))
  const f = pm(fresh, schemaB)
  const dead = resolveAnchor(fresh, f.meta.mapping, anchor)
  const ctx = { prefix: doc.textBetween(Math.max(0, r.from - 40), r.from), suffix: doc.textBetween(r.to, r.to + 40) }
  const re = findQuote(f.doc, 'client-side queue', ctx.prefix, ctx.suffix)
  expect('S10 relpos into a rebuilt Y.Doc do not resolve (different item ids)', dead === null)
  expect('S10 re-anchoring by quote + prefix/suffix finds the text again', !!re && f.doc.textBetween(re.from, re.to) === 'client-side queue')
  rows.push(['S10 Y.Doc rebuilt from HTML (stale sidecar)', 'marks come back only if they are in the file', 'relpos dead → re-anchored by quote ✓', '(same)'])
}

// ---------------------------------------------------------------- table
const header = ['scenario', ...models().map((m) => m.name)]
const widths = header.map((_, i) => Math.min(60, Math.max(...[header, ...rows].map((r) => (r[i] ?? '').length))))
const line = (r: string[]) => '| ' + r.map((c, i) => (c ?? '').slice(0, 60).padEnd(widths[i])).join(' | ') + ' |'
console.log('\n' + line(header))
console.log('|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|')
for (const r of rows) console.log(line(r))
console.log(`\nS3 (typing at the edges, observation): ${Object.entries(s3).map(([k, v]) => `${k} → ${show(v)}`).join(' · ')}`)
console.log(failures === 0 ? '\nANCHORING: ALL EXPECTATIONS HOLD' : `\nANCHORING: ${failures} EXPECTATION(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
