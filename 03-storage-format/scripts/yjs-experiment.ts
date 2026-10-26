// Small Yjs experiment (spike 07/08 go deep): the server holds a Y.Doc, a browser is connected and the
// user is typing, and the agent edits the HTML file on disk. How do we turn the file change into Y ops
// without losing the user's concurrent edit?
//
//   naive      rebuild the Y fragment from the file (delete all + insert all)
//   2-way      updateYFragment(liveDoc, fileDoc): diff the file against the *live* Y doc
//   3-way      fork a Y.Doc from the snapshot the file was last written from (base), updateYFragment(fork, fileDoc),
//              merge the fork's update into the live doc → the file change becomes CRDT ops relative to base
//
// y-prosemirror's updateYFragment is the same function its sync plugin uses for local editor changes.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import * as Y from 'yjs'
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { Transform } from '@tiptap/pm/transform'
import type { Node as PMNode } from '@tiptap/pm/model'
import { canonicalHtml, loadHtml, toYDoc, schema, Y_FRAGMENT } from '../lib/pipeline.ts'
import { EDITS, applyEdit } from '../lib/edits.ts'

const meta = () => ({ mapping: new Map(), isOMark: new Map() })
const frag = (d: Y.Doc) => d.getXmlFragment(Y_FRAGMENT)
const pmOf = (d: Y.Doc) => yXmlFragmentToProseMirrorRootNode(frag(d), schema)
const clone = (d: Y.Doc) => {
  const c = new Y.Doc()
  Y.applyUpdate(c, Y.encodeStateAsUpdate(d))
  return c
}
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}
const text = (d: PMNode) => d.textBetween(0, d.content.size, '\n', ' ')

/** the user types `insert` after `anchor` in the browser (same path as y-prosemirror's sync plugin) */
function userTypes(browser: Y.Doc, anchor: string, insert: string) {
  const doc = pmOf(browser)
  let pos = -1
  doc.descendants((n, p) => {
    if (pos < 0 && n.isText && n.text!.includes(anchor)) pos = p + n.text!.indexOf(anchor) + anchor.length
  })
  if (pos < 0) throw new Error(`anchor not found: ${anchor}`)
  updateYFragment(browser, frag(browser), new Transform(doc).insert(pos, schema.text(insert)).doc, meta())
}

/** user edits the text of an island (SVG label) — one string attribute, like spike 04's replaceLeafText */
function userEditsIsland(browser: Y.Doc, from: string, to: string) {
  const doc = pmOf(browser)
  let done = false
  const tr = new Transform(doc)
  doc.descendants((n, p) => {
    if (!done && n.type.name === 'htmlIsland' && (n.attrs.html as string).includes(from)) {
      tr.setNodeMarkup(p, undefined, { ...n.attrs, html: (n.attrs.html as string).replace(from, to) })
      done = true
    }
  })
  updateYFragment(browser, frag(browser), tr.doc, meta())
}

type Strategy = 'naive' | '2-way' | '3-way'

/** server applies the agent's new file content to its live doc */
function applyFile(live: Y.Doc, base: Uint8Array, fileDoc: PMNode, strategy: Strategy) {
  if (strategy === 'naive') {
    const fresh = toYDoc({ parts: { before: '', body: '', after: '' }, doc: fileDoc })
    live.transact(() => {
      frag(live).delete(0, frag(live).length)
      frag(live).insert(0, frag(fresh).toArray().map((n) => (n as Y.XmlElement).clone()))
    })
  } else if (strategy === '2-way') {
    updateYFragment(live, frag(live), fileDoc, meta())
  } else {
    const fork = new Y.Doc()
    Y.applyUpdate(fork, base)
    const sv = Y.encodeStateVector(fork)
    updateYFragment(fork, frag(fork), fileDoc, meta())
    Y.applyUpdate(live, Y.encodeStateAsUpdate(fork, sv))
  }
}

export interface Scenario {
  id: string
  strategy: Strategy
  /** the browser had already synced the user's typing to the server before the file change arrived */
  userEditReachedServerFirst: boolean
  converged: boolean
  agentEditSurvived: boolean
  userEditSurvived: boolean
  note: string
}

export async function runYjsExperiment(sample = 'samples/spec.html'): Promise<Scenario[]> {
  const canon = await canonicalHtml(readFileSync(sample, 'utf8'))
  const base = loadHtml(canon)
  const out: Scenario[] = []
  const USER = ' (user typing here)'
  const e2 = EDITS.find((e) => e.id === 'e2-add-list-item')!
  const e1 = EDITS.find((e) => e.id === 'e1-rewrite-paragraph')!

  // A: user types in the "Online" paragraph, agent adds a list item elsewhere
  for (const strategy of ['naive', '2-way', '3-way'] as Strategy[])
    for (const first of [false, true]) {
      const server = toYDoc(base)
      const baseState = Y.encodeStateAsUpdate(server) // = what the file on disk was written from
      const browser = clone(server)
      userTypes(browser, 'Each save is pushed immediately.', USER)
      if (first) sync(browser, server)
      const fileDoc = loadHtml(applyEdit(canon, e2)).doc // agent read the file BEFORE the user typed
      applyFile(server, baseState, fileDoc, strategy)
      sync(server, browser)
      const s = text(pmOf(server))
      out.push({
        id: 'different-blocks',
        strategy,
        userEditReachedServerFirst: first,
        converged: pmOf(server).eq(pmOf(browser)),
        agentEditSurvived: s.includes('The outbox survives app restarts'),
        userEditSurvived: s.includes(USER.trim()),
        note: `user edit counted ${s.split(USER.trim()).length - 1}×`,
      })
    }

  // B: same paragraph — user types in the intro while the agent rewrites the intro (3-way only)
  {
    const server = toYDoc(base)
    const baseState = Y.encodeStateAsUpdate(server)
    const browser = clone(server)
    userTypes(browser, 'Field technicians', ' (and auditors)')
    sync(browser, server)
    applyFile(server, baseState, loadHtml(applyEdit(canon, e1)).doc, '3-way')
    sync(server, browser)
    const intro = pmOf(server).child(1).textContent
    out.push({
      id: 'same-paragraph',
      strategy: '3-way',
      userEditReachedServerFirst: true,
      converged: pmOf(server).eq(pmOf(browser)),
      agentEditSurvived: intro.includes('regularly work without connectivity'),
      userEditSurvived: intro.includes('(and auditors)'),
      note: `merged: "${intro.slice(0, 90)}…"`,
    })
  }

  // C: same island — user edits an SVG label while the agent edits the figcaption of the same <figure>
  {
    const server = toYDoc(base)
    const baseState = Y.encodeStateAsUpdate(server)
    const browser = clone(server)
    userEditsIsland(browser, '>Outbox queue<', '>Durable outbox<')
    sync(browser, server)
    const agentFile = canon.replace('Figure 1: Notes flow', 'Figure 1: Each note flows')
    applyFile(server, baseState, loadHtml(agentFile).doc, '3-way')
    sync(server, browser)
    const isl = (() => {
      let h = ''
      pmOf(server).descendants((n) => {
        if (n.type.name === 'htmlIsland' && (n.attrs.html as string).includes('<figure')) h = n.attrs.html
      })
      return h
    })()
    out.push({
      id: 'same-island',
      strategy: '3-way',
      userEditReachedServerFirst: true,
      converged: pmOf(server).eq(pmOf(browser)),
      agentEditSurvived: isl.includes('Each note flows'),
      userEditSurvived: isl.includes('Durable outbox'),
      note: 'island = one string attribute → one side wins for the whole island (which one depends on the random Yjs client ids)',
    })
  }
  return out
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = await runYjsExperiment()
  console.log('scenario           strategy  user-edit-synced-first  converged  agent-edit  user-edit  note')
  for (const r of rows)
    console.log(
      `${r.id.padEnd(18)} ${r.strategy.padEnd(9)} ${String(r.userEditReachedServerFirst).padEnd(23)} ${String(r.converged).padEnd(10)} ${String(r.agentEditSurvived).padEnd(11)} ${String(r.userEditSurvived).padEnd(10)} ${r.note}`,
    )
}
