// Spike 11 PROTOTYPE: let the agent's edits write y-tiptap "position migrations", like the browser editor does.
//
// Found while measuring scenario 2: when a HUMAN turns a paragraph into a heading (or drags it), y-tiptap's sync plugin
// (3.0.10) derives from the ProseMirror transaction's step mapping which characters went where, and writes that as a
// record into a shared Y.Map (`__tiptap_position_migrations:root:default`). Every other client resolves its caret's
// relative position through that map (`resolvePositionMigration` inside `relativePositionToAbsolutePosition`), so a
// caret on a deleted character follows it into the re-created element. The agent's merge (updateYFragment on the
// server, no PM transaction) writes no such record: the caret's character is simply gone, and y-tiptap's fallback puts
// the caret somewhere else (measured: the start of the NEXT block).
//
// This prototype does it for the agent: before the merge it records the character ids of every textblock (single
// Y.XmlText child), after the merge it pairs each old textblock with its new version (same Y.XmlText, same block id,
// or same text), aligns old and new text (word-level diff, lib/livePatch fineDiff) and writes a transfer
// "old char id → new char id" for every old character that the merge deleted but whose text survived.
// Not covered: carets at the very end of a text (relative positions without an item → y-tiptap's boundary transfers),
// inline atoms, textblocks split or merged by the edit.
import * as Y from 'yjs'
import type { Node as PMNode } from '@tiptap/pm/model'
import { BLOCK_ID_ATTR } from '../src/extensions.ts'
import { fragmentOf, yToDocWithMapping } from './pipeline.ts'
import { fineDiff } from './livePatch.ts'

let enabled = false
export const setMigratePositions = (on: boolean) => {
  enabled = on
}
export const migrateEnabled = () => enabled
export const migrateStats = { records: 0, transfers: 0 }

interface TB {
  node: PMNode
  text: Y.XmlText
  ids: Y.ID[]
  str: string
  bid: string | null
}

/** every textblock of the current fragment with its Y.XmlText and the ids of its (live) characters */
function textblocks(ydoc: Y.Doc): TB[] {
  const { doc, meta } = yToDocWithMapping(ydoc)
  const yOf = new Map<PMNode, Y.XmlElement>()
  for (const [y, n] of meta.mapping as Map<unknown, unknown>) if (y instanceof Y.XmlElement && !Array.isArray(n)) yOf.set(n as PMNode, y)
  const out: TB[] = []
  doc.descendants((node, _pos, parent) => {
    if (!node.isTextblock) return true
    const el = yOf.get(node)
    const kids = el?.toArray() ?? []
    if (kids.length !== 1 || !(kids[0] instanceof Y.XmlText)) return false
    const text = kids[0] as Y.XmlText
    const ids: Y.ID[] = []
    let str = ''
    for (let it = text._start; it; it = it.right) {
      if (it.deleted || !it.countable || !(it.content instanceof Y.ContentString)) continue
      for (let k = 0; k < it.length; k++) ids.push(Y.createID(it.id.client, it.id.clock + k))
      str += (it.content as Y.ContentString).str
    }
    if (str !== node.textContent) return false
    // block id: on the textblock, or on its parent (a <p> inside a list item / quote)
    const bid = (node.attrs[BLOCK_ID_ATTR] as string | undefined) ?? ((parent?.attrs[BLOCK_ID_ATTR] as string | undefined) ?? null)
    out.push({ node, text, ids, str, bid })
    return false
  })
  return out
}

const alive = (ydoc: Y.Doc, id: Y.ID) => {
  const item = Y.getItem(ydoc.store, id) as Y.Item | undefined
  return !!item && !item.deleted
}

/** run `fn` (which changes `ydoc`'s fragment) and append a position-migration record for the characters it re-created */
export function withPositionMigration<T>(ydoc: Y.Doc, fn: () => T): T {
  if (!enabled) return fn()
  const before = textblocks(ydoc)
  const out = fn()
  const after = textblocks(ydoc)
  const byText = new Map(after.map((t) => [t.text, t]))
  const used = new Set<TB>()
  const transfers: { source: { client: number; clock: number; length: number }; target: { client: number; clock: number; type: { client: number; clock: number } } }[] = []
  for (const old of before) {
    // only blocks that lost characters matter
    if (old.ids.every((id) => alive(ydoc, id))) continue
    const neu = byText.get(old.text) ?? after.find((t) => !used.has(t) && old.bid && t.bid === old.bid) ?? after.find((t) => !used.has(t) && t.str === old.str)
    if (!neu) continue
    used.add(neu)
    // old index → new index outside the diff hunks
    const hunks = fineDiff(old.str, neu.str)
    let i = 0
    let shift = 0
    const map = (from: number, to: number) => {
      for (let k = from; k < to; k++) {
        const src = old.ids[k]
        const dst = neu.ids[k + shift]
        if (!dst || Y.compareIDs(src, dst) || alive(ydoc, src)) continue
        transfers.push({ source: { client: src.client, clock: src.clock, length: 1 }, target: { client: dst.client, clock: dst.clock, type: { client: neu.text._item!.id.client, clock: neu.text._item!.id.clock } } })
      }
    }
    for (const h of hunks) {
      map(i, h.index)
      shift += h.insert.length - h.remove
      i = h.index + h.remove
    }
    map(i, old.str.length)
  }
  if (transfers.length) {
    // merge runs (consecutive source clocks → consecutive target clocks in the same text), like y-tiptap does
    const merged: typeof transfers = []
    for (const t of transfers) {
      const p = merged[merged.length - 1]
      if (p && p.source.client === t.source.client && p.source.clock + p.source.length === t.source.clock && p.target.client === t.target.client && p.target.clock + p.source.length === t.target.clock && Y.compareIDs(p.target.type as Y.ID, t.target.type as Y.ID)) p.source.length++
      else merged.push({ source: { ...t.source }, target: t.target })
    }
    const store = ydoc.getMap(`__tiptap_position_migrations:root:${'default'}`)
    void fragmentOf
    const clock = Y.getState(ydoc.store, ydoc.clientID)
    store.set(`${ydoc.clientID}:${clock}`, { version: 1, client: ydoc.clientID, clock, seen: [...Y.decodeStateVector(Y.encodeStateVector(ydoc))], transfers: merged })
    migrateStats.records++
    migrateStats.transfers += merged.length
  }
  return out
}
