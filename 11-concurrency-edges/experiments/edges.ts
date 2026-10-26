// Spike 11: concurrency edge cases, agent vs. a second human.
//
//   npm run edges -- [--scenario N] [--party agent|human] [--variant id] [--runs 5] [--parallel 3] [--out file.json]
//
// Every run: fresh server (temp copy of the edges doc), user A ("Noah") types a marked string T at human speed
// (80–140 ms per key, real keyboard events) into the "Phase one ships…" paragraph while the other party edits:
//   agent  = HTTP calls the `collab` CLI makes (POST /agent/patch = `collab patch`, POST /agent/op = the P2 ops)
//   human  = a second browser context ("Pat") using the editor UI with real keyboard/mouse input
// The other party starts at a different offset into A's typing in every run (OFFSETS), so the edit lands at
// different points. Afterwards: A's doc, the other side's doc (B's browser or the server), the file on disk.
//
// Classification of a run (A's point of view):
//   lost       characters A typed are missing anywhere (multiset count against the doc + the other's change)
//   garbled    all characters there, but T is not contiguous (torn apart, other text mixed into A's words)
//   misplaced  T intact, but the block it ends in is not the ideal (other's change + T at A's caret)
//   clean      A's block == ideal
// plus: otherOk (the other party's intended change is in the doc as intended), caret jump (T in > 1 piece),
// converged (A == other side), fileOk (the file on disk has A's final blocks).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { chromium, type Browser, type Page } from 'playwright'
import { root, startServer } from '../lib/serverProc.ts'
import { edgesDocHtml, P_A, P_A_TYPOS, P_PREV } from '../lib/edgesDoc.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const norm = (s: string) => s.replace(/[\s ]+/g, ' ').trim()

export type Party = 'agent' | 'human'
export type Cls = 'lost' | 'garbled' | 'misplaced' | 'clean'

interface Ctx {
  url: string
  a: Page
  b: Page | null
  typed: () => number
  log: (s: string) => void
}
export interface Variant {
  id: string
  scenario: number
  party: Party
  label: string
  serverArgs?: string[]
  /** extra fields for POST /agent/patch (e.g. { avoidCaret: 'span' }) */
  patchOpts?: Record<string, unknown>
  /** initial text of A's paragraph */
  p0?: string
  /** A's caret goes right after this text inside A's paragraph */
  caretAfter: string
  typed: string
  /** A pauses with the caret in place while the other party edits, then types (instead of typing throughout) */
  pauseFirst?: boolean
  /** the other party's action; returns whether the request was accepted (agent: HTTP ok) */
  other: (c: Ctx) => Promise<{ ok: boolean; info: string; impact?: string }>
  /** the other party's change on plain text (A's block incl. T); null = no ideal defined */
  ideal: ((s: string) => string) | null
  /** the other party's change applied to the plain text of the doc without T (for the lost-chars count) */
  otherText: (s: string) => string
  /** expected block path of A's block (default: paragraph) */
  path?: string
  /** extra check of the other party's intent on A's final blocks */
  otherOk: (blocks: Block[], text: string) => boolean
}

interface Block {
  path: string
  text: string
}

// ---------------------------------------------------------------- page helpers (A and B)
async function openEditor(browser: Browser, url: string, user: string) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const page = await ctx.newPage()
  await page.goto(`${url}/?user=${user}`)
  await page.waitForFunction(() => (window as any).__editor && (window as any).__provider?.synced, null, { timeout: 30000 })
  return { ctx, page }
}

/** select [from,to) of `needle` inside the textblock containing `anchor` (to = from → caret), focus the editor */
async function select(page: Page, anchor: string, needle: string, mode: 'select' | 'after' | 'before' = 'select', occurrence = 0) {
  const ok = await page.evaluate(
    ({ anchor, needle, mode, occurrence }) => {
      const ed = (window as any).__editor
      let r: { from: number; to: number } | null = null
      ed.state.doc.descendants((n: any, pos: number) => {
        if (r || !n.isTextblock || !n.textContent.includes(anchor)) return !r
        let i = -1
        for (let k = 0; k <= occurrence; k++) i = n.textContent.indexOf(needle, i + 1)
        if (i < 0) return false
        const s = pos + 1 + i
        r = mode === 'select' ? { from: s, to: s + needle.length } : mode === 'after' ? { from: s + needle.length, to: s + needle.length } : { from: s, to: s }
        return false
      })
      if (!r) return false
      ed.commands.setTextSelection(r)
      ed.view.focus()
      const dom = ed.view.domAtPos((r as any).from).node
      ;(dom.nodeType === 1 ? dom : dom.parentElement).scrollIntoView({ block: 'center' })
      return true
    },
    { anchor, needle, mode, occurrence },
  )
  if (!ok) throw new Error(`select: ${JSON.stringify(needle)} not found in block ${JSON.stringify(anchor)}`)
}

/** current text of the textblock containing `anchor` (B selects what B sees) */
const blockText = (page: Page, anchor: string) =>
  page.evaluate((anchor) => {
    let t = ''
    ;(window as any).__editor.state.doc.descendants((n: any) => {
      if (!t && n.isTextblock && n.textContent.includes(anchor)) t = n.textContent
      return !t
    })
    return t
  }, anchor)

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const ed = (window as any).__editor
    const doc = ed.state.doc
    const blocks: { path: string; text: string }[] = []
    doc.descendants((n: any, pos: number) => {
      if (!n.isTextblock) return true
      const $p = doc.resolve(pos + 1)
      const names: string[] = []
      for (let d = 1; d <= $p.depth; d++) names.push($p.node(d).type.name === 'heading' ? `h${$p.node(d).attrs.level}` : $p.node(d).type.name)
      blocks.push({ path: names.join('>'), text: n.textContent })
      return false
    })
    const sel = ed.state.selection
    const $h = sel.$head
    const caret = { path: $h.parent.type.name, left: $h.parent.textContent.slice(Math.max(0, $h.parentOffset - 24), $h.parentOffset), right: $h.parent.textContent.slice($h.parentOffset, $h.parentOffset + 12) }
    return { text: doc.textBetween(0, doc.content.size, '\n', '￼'), blocks, caret, caretFixed: (window as any).__caretFix?.corrected ?? 0 }
  })
}

// ---------------------------------------------------------------- agent helpers (what `collab read` / `collab patch` send)
const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, json: (await r.json()) as any }
}
async function readHtml(url: string): Promise<string> {
  const r = (await (await fetch(`${url}/agent/read`)).json()) as any
  if (!r.ok) throw new Error(JSON.stringify(r))
  return r.html as string
}
/** the canonical html chunk of the top-level <p> that contains `needle` (as `collab read` shows it) */
function pChunk(html: string, needle: string): string {
  const i = html.indexOf(needle)
  if (i < 0) throw new Error(`not in read: ${needle}`)
  const s = html.lastIndexOf('<p', i)
  const e = html.indexOf('</p>', i) + 4
  return html.slice(s, e)
}
/** extra fields for POST /agent/patch per server (e.g. avoidCaret), set by runOnce */
const patchOpts = new Map<string, Record<string, unknown>>()
const impactOf = (j: any) => ((j.caretImpact ?? []) as { impact: string }[]).map((c) => c.impact).join(',')
async function patch(url: string, edits: { old: string; new: string }[]) {
  const r = await post(`${url}/agent/patch`, { edits, ...patchOpts.get(url) })
  const j = r.json
  return { ok: !!j.ok, impact: impactOf(j), info: j.ok ? `patch ok ${j.ms} ms, ${j.updateBytes} B${j.warnings?.length ? ', warning: caret in changed block' : ''}` : `patch ${j.code}` }
}
/** read → build edits from the fresh html → patch; on NOT_FOUND (A typed inside the SEARCH text meanwhile) re-read and
 *  retry, as the agent would (up to 10 attempts) */
async function freshPatch(url: string, build: (html: string) => { old: string; new: string }[]) {
  let last: { ok: boolean; info: string; impact?: string } = { ok: false, info: '' }
  for (let attempt = 1; attempt <= 10; attempt++) {
    last = await patch(url, build(await readHtml(url)))
    if (last.ok || !last.info.includes('NOT_FOUND')) return { ...last, info: `${last.info}${attempt > 1 ? ` (attempt ${attempt}: ${attempt - 1}× NOT_FOUND)` : ''}` }
  }
  return { ...last, info: `${last.info} ×10` }
}
async function op(url: string, o: Record<string, unknown>) {
  const r = await post(`${url}/agent/op`, { op: o })
  return { ok: !!r.json.ok, impact: impactOf(r.json), info: r.json.ok ? `op ${o.op} ok ${r.json.ms} ms` : `op ${o.op} failed: ${r.json.error}` }
}

// ---------------------------------------------------------------- human helpers (B = "Pat", real keyboard + UI)
const KEY = 70 // B types a bit faster than A
async function humanReplace(b: Page, anchor: string, word: string, by: string, occurrence = 0) {
  await select(b, anchor, word, 'select', occurrence)
  await b.keyboard.type(by, { delay: KEY })
}
async function turnInto(b: Page, id: string) {
  await select(b, 'Phase one', 'Phase', 'after')
  await b.getByTestId('tb-blocktype').click()
  await b.getByTestId(`tb-blocktype-${id}`).click()
}

// ---------------------------------------------------------------- the scenarios
const T_MID = ' qa1 qb2 qc3 qd4 qe5 qf6 qg7 qh8'
const T_BEFORE_WORD = 'qa1 qb2 qc3 qd4 qe5 qf6 qg7 qh8 '
const rep = (pairs: [string, string][]) => (s: string) => pairs.reduce((acc, [a, b]) => acc.replace(a, b), s)
const has = (yes: string[], no: string[] = []) => (_b: Block[], text: string) => yes.every((y) => text.includes(y)) && no.every((n) => !text.includes(n))
const aBlock = (blocks: Block[]) => blocks.find((b) => b.text.includes('Phase one') || b.text.includes('Phase two'))
const idx = (blocks: Block[], s: string) => blocks.findIndex((b) => b.text.includes(s))
const SENT = 'The rollout team collects feedback every week and reports blockers to the sync owner.'
const SENT_NEW = 'Feedback is collected weekly; blockers go to the sync owner.'

const S1A = rep([
  ['northern', 'southern'],
  ['crash rate', 'error rate'],
])
const S1B = rep([['every week', 'every month']])
const S1C = rep([['reports blockers', 'escalates blockers']])
const S5 = rep([
  ['pilto', 'pilot'],
  ['feedbak', 'feedback'],
  ['folows', 'follows'],
])
const sameText = (s: string) => s

function typeChange(party: Party, kind: 'h2' | 'li' | 'quote', how: 'patch' | 'set-block' | 'ui'): Variant {
  const path = kind === 'h2' ? 'h2' : kind === 'li' ? 'bulletList>listItem>paragraph' : 'blockquote>paragraph'
  return {
    id: `2${kind === 'h2' ? (how === 'set-block' ? 'b' : 'a') : kind === 'li' ? 'c' : 'd'}-${party}`,
    scenario: 2,
    party,
    label: `turn A's paragraph into ${kind === 'h2' ? 'a heading' : kind === 'li' ? 'a list item' : 'a quote'} (${how === 'ui' ? 'toolbar "Turn into…"' : how === 'patch' ? 'patch <p>…</p> → ' + (kind === 'h2' ? '<h2>' : kind === 'li' ? '<ul><li>' : '<blockquote>') : 'set-block <h2>'})`,
    caretAfter: 'every week',
    typed: T_MID,
    path,
    ideal: sameText,
    otherText: sameText,
    otherOk: (blocks) => aBlock(blocks)?.path === path && blocks.filter((b) => b.text.includes('Phase one')).length === 1,
    other: async ({ url, b }) => {
      if (party === 'human') {
        await turnInto(b!, kind === 'h2' ? 'h2' : kind === 'li' ? 'bulletList' : 'blockquote')
        return { ok: true, info: 'Turn into' }
      }
      if (how === 'set-block') {
        const old = pChunk(await readHtml(url), 'Phase one') // fresh read right before the op
        const bid = /data-bid="([^"]+)"/.exec(old)![1]
        const inner = old.replace(/^<p[^>]*>/, '').replace(/<\/p>$/, '')
        return op(url, { op: 'set-block', id: bid, html: `<h2>${inner}</h2>` })
      }
      // fresh read right before the patch (a stale SEARCH would not match: A is typing in it)
      return freshPatch(url, (html) => {
        const old = pChunk(html, 'Phase one')
        return [{ old, new: kind === 'h2' ? old.replace(/^<p/, '<h2').replace(/<\/p>$/, '</h2>') : kind === 'li' ? `<ul>\n<li>${old}</li>\n</ul>` : `<blockquote>${old}</blockquote>` }]
      })
    },
  }
}

export const VARIANTS: Variant[] = [
  // 1: typing inside / next to the agent's span
  {
    id: '1a-agent',
    scenario: 1,
    party: 'agent',
    label: 'two words far apart (one patch, 2 SEARCH blocks), A types between them',
    caretAfter: 'every week',
    typed: T_MID,
    ideal: S1A,
    otherText: S1A,
    otherOk: has(['southern region', 'error rate'], ['northern', 'crash']),
    other: ({ url }) =>
      patch(url, [
        { old: 'northern region', new: 'southern region' },
        { old: 'the crash rate', new: 'the error rate' },
      ]),
  },
  {
    id: '1a-human',
    scenario: 1,
    party: 'human',
    label: 'B selects "northern" → types "southern", then "crash" → "error"',
    caretAfter: 'every week',
    typed: T_MID,
    ideal: S1A,
    otherText: S1A,
    otherOk: has(['southern region', 'error rate'], ['northern', 'crash']),
    other: async ({ b }) => {
      await humanReplace(b!, 'Phase one', 'northern', 'southern')
      await humanReplace(b!, 'Phase one', 'crash', 'error')
      return { ok: true, info: 'typed' }
    },
  },
  {
    id: '1b-agent',
    scenario: 1,
    party: 'agent',
    label: 'the word right before A\'s caret ("week" → "month")',
    caretAfter: 'every week',
    typed: T_MID,
    ideal: S1B,
    otherText: S1B,
    otherOk: has(['every month'], ['every week']),
    other: ({ url }) => patch(url, [{ old: 'every week', new: 'every month' }]),
  },
  {
    id: '1b-human',
    scenario: 1,
    party: 'human',
    label: 'B selects "week" right before A\'s caret → types "month"',
    caretAfter: 'every week',
    typed: T_MID,
    ideal: S1B,
    otherText: S1B,
    otherOk: has(['every month'], ['every week']),
    other: async ({ b }) => {
      await humanReplace(b!, 'Phase one', 'week', 'month')
      return { ok: true, info: 'typed' }
    },
  },
  {
    id: '1d-agent',
    scenario: 1,
    party: 'agent',
    label: 'A pauses with the caret right after "week"; the agent replaces "week" → "month"; A goes on typing',
    caretAfter: 'every week',
    typed: T_MID,
    pauseFirst: true,
    ideal: S1B,
    otherText: S1B,
    otherOk: has(['month and'], ['week']),
    other: ({ url }) => patch(url, [{ old: 'every week', new: 'every month' }]),
  },
  {
    id: '1d-human',
    scenario: 1,
    party: 'human',
    label: 'A pauses with the caret right after "week"; B selects "week" → types "month"; A goes on typing',
    caretAfter: 'every week',
    typed: T_MID,
    pauseFirst: true,
    ideal: S1B,
    otherText: S1B,
    otherOk: has(['month and'], ['week']),
    other: async ({ b }) => {
      await humanReplace(b!, 'Phase one', 'week', 'month')
      return { ok: true, info: 'typed' }
    },
  },
  {
    id: '1c-agent',
    scenario: 1,
    party: 'agent',
    label: 'the word right after A\'s caret, adjacent ("reports" → "escalates")',
    caretAfter: 'week and ',
    typed: T_BEFORE_WORD,
    ideal: S1C,
    otherText: S1C,
    otherOk: has(['escalates blockers'], ['reports']),
    other: ({ url }) => patch(url, [{ old: 'reports blockers', new: 'escalates blockers' }]),
  },
  {
    id: '1c-human',
    scenario: 1,
    party: 'human',
    label: 'B selects "reports" right after A\'s caret → types "escalates"',
    caretAfter: 'week and ',
    typed: T_BEFORE_WORD,
    ideal: S1C,
    otherText: S1C,
    otherOk: has(['escalates blockers'], ['reports']),
    other: async ({ b }) => {
      await humanReplace(b!, 'Phase one', 'reports', 'escalates')
      return { ok: true, info: 'typed' }
    },
  },
  // 2: block type change under the caret
  typeChange('agent', 'h2', 'patch'),
  typeChange('agent', 'h2', 'set-block'),
  typeChange('agent', 'li', 'patch'),
  typeChange('agent', 'quote', 'patch'),
  typeChange('human', 'h2', 'ui'),
  typeChange('human', 'li', 'ui'),
  typeChange('human', 'quote', 'ui'),
  // 3: same words rewritten
  {
    id: '3a-agent',
    scenario: 3,
    party: 'agent',
    label: 'agent replaces the sentence A types in (fresh read right before the patch, so SEARCH includes A\'s text so far)',
    caretAfter: 'collects feedback',
    typed: T_MID,
    ideal: null,
    otherText: (s) => s.replace(SENT, SENT_NEW),
    otherOk: has([SENT_NEW], ['collects feedback']),
    other: ({ url }) =>
      freshPatch(url, (html) => {
        const text = norm(pChunk(html, 'Phase one').replace(/<[^>]*>/g, ''))
        const s = text.indexOf('The rollout')
        const e = text.indexOf('owner.') + 'owner.'.length
        return [{ old: text.slice(s, e), new: SENT_NEW }]
      }),
  },
  {
    id: '3b-agent',
    scenario: 3,
    party: 'agent',
    label: 'agent replaces the sentence with a STALE SEARCH (read before A started typing)',
    caretAfter: 'collects feedback',
    typed: T_MID,
    ideal: (s) => s, // the patch must be refused: ideal = A's text where A typed it
    otherText: sameText,
    otherOk: has(['collects feedback']), // "ok" here = the stale patch did NOT land
    other: ({ url }) => patch(url, [{ old: SENT, new: SENT_NEW }]),
  },
  {
    id: '3-human',
    scenario: 3,
    party: 'human',
    label: 'B selects the sentence (as B sees it, incl. A\'s text so far) and types a replacement',
    caretAfter: 'collects feedback',
    typed: T_MID,
    ideal: null,
    otherText: (s) => s.replace(SENT, SENT_NEW),
    otherOk: has([SENT_NEW], ['collects feedback']),
    other: async ({ b }) => {
      const t = await blockText(b!, 'Phase one')
      const s = t.indexOf('The rollout')
      const e = t.indexOf('owner.') + 'owner.'.length
      await humanReplace(b!, 'Phase one', t.slice(s, e), SENT_NEW)
      return { ok: true, info: `replaced ${e - s} chars` }
    },
  },
  // 4: moved block edited on both sides
  {
    id: '4a-agent',
    scenario: 4,
    party: 'agent',
    label: 'move-section "6. Rollout" before "5. Open tasks" (A types in it)',
    caretAfter: 'every week',
    typed: T_MID,
    ideal: sameText,
    otherText: sameText,
    otherOk: (blocks) => idx(blocks, '6. Rollout') >= 0 && idx(blocks, '6. Rollout') < idx(blocks, '5. Open tasks') && blocks.filter((b) => b.text.includes('Phase one')).length === 1,
    other: ({ url }) => op(url, { op: 'move-section', heading: '6. Rollout', before: '5. Open tasks' }),
  },
  {
    id: '4b-agent',
    scenario: 4,
    party: 'agent',
    label: 'patch that moves A\'s paragraph above the previous one AND edits it ("northern" → "southern"), fresh read',
    caretAfter: 'every week',
    typed: T_MID,
    ideal: rep([['northern', 'southern']]),
    otherText: rep([['northern', 'southern']]),
    otherOk: (blocks, text) => idx(blocks, 'Phase one') >= 0 && idx(blocks, 'Phase one') < idx(blocks, P_PREV) && text.includes('southern') && blocks.filter((b) => b.text.includes('Phase one')).length === 1,
    other: ({ url }) =>
      freshPatch(url, (html) => {
        const prev = pChunk(html, P_PREV.slice(0, 20))
        const pa = pChunk(html, 'Phase one')
        const old = html.slice(html.indexOf(prev), html.indexOf(pa) + pa.length)
        return [{ old, new: `${pa.replace('northern', 'southern')}\n${prev}` }]
      }),
  },
  {
    id: '4a-human',
    scenario: 4,
    party: 'human',
    label: 'B puts the caret in A\'s paragraph and presses Alt+Shift+↑ (move block up)',
    caretAfter: 'every week',
    typed: T_MID,
    ideal: sameText,
    otherText: sameText,
    otherOk: (blocks) => idx(blocks, 'Phase one') >= 0 && idx(blocks, 'Phase one') < idx(blocks, P_PREV) && blocks.filter((b) => b.text.includes('Phase one')).length === 1,
    other: async ({ b }) => {
      await select(b!, 'Phase one', 'Phase', 'after')
      await b!.keyboard.press('Alt+Shift+ArrowUp')
      return { ok: true, info: 'Alt+Shift+Up' }
    },
  },
  {
    id: '4b-human',
    scenario: 4,
    party: 'human',
    label: 'B drags A\'s paragraph with the drag handle above the previous paragraph',
    caretAfter: 'every week',
    typed: T_MID,
    ideal: sameText,
    otherText: sameText,
    otherOk: (blocks) => idx(blocks, 'Phase one') >= 0 && idx(blocks, 'Phase one') < idx(blocks, P_PREV) && blocks.filter((b) => b.text.includes('Phase one')).length === 1,
    other: async ({ b }) => {
      const page = b!
      const pa = page.locator('.ProseMirror p', { hasText: 'Phase one ships' })
      const prev = page.locator('.ProseMirror p', { hasText: P_PREV })
      await prev.scrollIntoViewIfNeeded()
      const pb = (await pa.boundingBox())!
      await page.mouse.move(pb.x + 40, pb.y + 8)
      const grip = page.getByTestId('bh-grip')
      await grip.waitFor({ state: 'visible', timeout: 3000 })
      const gb = (await grip.boundingBox())!
      const tb = (await prev.boundingBox())!
      await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2)
      await page.mouse.down()
      await page.mouse.move(tb.x + 60, tb.y + 4, { steps: 8 })
      await page.mouse.move(tb.x + 60, tb.y + 2, { steps: 2 })
      await page.mouse.up()
      return { ok: true, info: 'dragged' }
    },
  },
  // 5: proofread
  {
    id: '5-agent',
    scenario: 5,
    party: 'agent',
    label: 'agent fixes 3 typos spread across A\'s paragraph (one patch, 3 SEARCH blocks), A types in the middle',
    p0: P_A_TYPOS,
    caretAfter: 'every week',
    typed: T_MID,
    ideal: S5,
    otherText: S5,
    otherOk: has(['pilot devices', 'feedback every', 'follows once'], ['pilto', 'feedbak', 'folows']),
    other: ({ url }) =>
      patch(url, [
        { old: 'pilto', new: 'pilot' },
        { old: 'feedbak', new: 'feedback' },
        { old: 'folows', new: 'follows' },
      ]),
  },
  {
    id: '5-agent-whole',
    scenario: 5,
    party: 'agent',
    label: 'agent proofreads by sending the whole paragraph (fresh read right before; SEARCH = <p>…</p>, REPLACE = fixed <p>)',
    p0: P_A_TYPOS,
    caretAfter: 'every week',
    typed: T_MID,
    ideal: S5,
    otherText: S5,
    otherOk: has(['pilot devices', 'feedback every', 'follows once'], ['pilto', 'feedbak', 'folows']),
    other: ({ url }) =>
      freshPatch(url, (html) => {
        const old = pChunk(html, 'Phase one')
        return [{ old, new: S5(old) }]
      }),
  },
  {
    id: '5-human',
    scenario: 5,
    party: 'human',
    label: 'B fixes the 3 typos (select word → type the correct one)',
    p0: P_A_TYPOS,
    caretAfter: 'every week',
    typed: T_MID,
    ideal: S5,
    otherText: S5,
    otherOk: has(['pilot devices', 'feedback every', 'follows once'], ['pilto', 'feedbak', 'folows']),
    other: async ({ b }) => {
      await humanReplace(b!, 'Phase one', 'pilto', 'pilot')
      await humanReplace(b!, 'Phase one', 'feedbak', 'feedback')
      await humanReplace(b!, 'Phase one', 'folows', 'follows')
      return { ok: true, info: 'typed' }
    },
  },
]
// 6: spike 07's one-pass merge (--naive-merge);  7: PROTOTYPE word-level text diff;  8: PROTOTYPE position migrations;
// 9: both prototypes together
for (const [sc, flags, tag, bases] of [
  [6, ['--naive-merge'], 'naive', ['1a-agent', '5-agent', '2a-agent']],
  [7, ['--fine-diff'], 'fine', ['1a-agent', '5-agent', '5-agent-whole', '3a-agent']],
  [8, ['--migrate-positions'], 'migrate', ['1a-agent', '5-agent', '2a-agent', '2b-agent', '2c-agent', '2d-agent', '3a-agent']],
  [9, ['--fine-diff', '--migrate-positions'], 'both', ['1a-agent', '1b-agent', '5-agent', '2a-agent', '2c-agent', '4b-agent']],
] as const)
  for (const base of bases) {
    const v = VARIANTS.find((x) => x.id === base)!
    VARIANTS.push({ ...v, id: `${base}-${tag}`, scenario: sc, serverArgs: [...flags], label: `${v.label} [${flags.join(' ')}${sc >= 7 ? ', PROTOTYPE' : ''}]` })
  }
// 10: the span rule as a guard: `collab patch --avoid-jump` (avoidCaret: 'span') refuses only when A's caret would jump
for (const base of ['1a-agent', '1b-agent', '1c-agent', '5-agent', '2a-agent', '4b-agent', '3a-agent']) {
  const v = VARIANTS.find((x) => x.id === base)!
  VARIANTS.push({ ...v, id: `${base}-guard`, scenario: 10, patchOpts: { avoidCaret: 'span' }, label: `${v.label} [patch --avoid-jump]` })
}

// ---------------------------------------------------------------- analysis
const counts = (s: string) => {
  const m = new Map<string, number>()
  for (const ch of s) m.set(ch, (m.get(ch) ?? 0) + 1)
  return m
}
/** greedy split of T into the longest pieces that occur in `text` (pieces < 3 chars are not located) */
function pieces(T: string, text: string): { s: string; at: number }[] {
  const out: { s: string; at: number }[] = []
  let i = 0
  while (i < T.length) {
    let j = T.length
    while (j > i + 1 && !text.includes(T.slice(i, j))) j--
    const s = T.slice(i, j)
    out.push({ s, at: s.length >= 3 ? text.indexOf(s) : -1 })
    i = j
  }
  return out
}

export interface RunResult {
  variant: string
  run: number
  offsetMs: number
  cls: Cls
  lostChars: number
  extraChars: number
  pieces: number
  otherAccepted: boolean
  otherOk: boolean
  otherInfo: string
  /** agent only: what the server's caret probe said the update did to A's caret */
  impact: string
  converged: boolean
  fileOk: boolean
  typedAtEdit: number
  aBlock: string
  aPath: string
  ideal: string | null
  caret: { path: string; left: string; right: string }
  where: string[]
  ms: number
}

const OFFSETS = [300, 800, 1300, 1800, 2300]

export async function runOnce(browser: Browser, v: Variant, run: number, log: (s: string) => void = () => {}): Promise<RunResult> {
  const t0 = Date.now()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike11-'))
  const docPath = path.join(tmp, 'spec.html')
  fs.writeFileSync(docPath, edgesDocHtml(v.p0 ?? P_A))
  const srv = await startServer(docPath, 0, v.serverArgs ?? [])
  const ctxs: { close: () => Promise<void> }[] = []
  try {
    const A = await openEditor(browser, srv.url, 'Noah')
    ctxs.push(A.ctx)
    const B = v.party === 'human' ? await openEditor(browser, srv.url, 'Pat') : null
    if (B) ctxs.push(B.ctx)
    await sleep(500)
    const before = await snapshot(A.page)
    await select(A.page, 'Phase one', v.caretAfter, 'after')
    // deterministic per run: offset into A's typing + per-key delays
    let seed = run * 7919 + v.id.length * 31
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    // pauseFirst: A's caret rests (right after the word the other party changes); the edit starts at once and A goes on
    // typing 500–900 ms later (after B finished typing the replacement)
    const offsetMs = v.pauseFirst ? 0 : OFFSETS[run % OFFSETS.length] + (run >= OFFSETS.length ? Math.round(rnd() * 300 - 150) : 0)
    const pauseMs = v.pauseFirst ? 500 + (run % 5) * 100 : 0
    let typed = 0
    const typing = (async () => {
      await sleep(pauseMs)
      for (const ch of v.typed) {
        await A.page.keyboard.type(ch)
        typed++
        await sleep(80 + Math.round(rnd() * 60))
      }
    })()
    await sleep(offsetMs)
    const typedAtEdit = typed
    patchOpts.set(srv.url, v.patchOpts ?? {})
    let res: { ok: boolean; info: string; impact?: string }
    try {
      res = await v.other({ url: srv.url, a: A.page, b: B?.page ?? null, typed: () => typed, log })
    } catch (e) {
      res = { ok: false, info: `threw: ${(e as Error).message.split('\n')[0]}` }
    }
    await typing
    await sleep(1200)
    const a = await snapshot(A.page)
    const otherText = B ? (await snapshot(B.page)).text : ((await (await fetch(`${srv.url}/doc/state`)).json()) as any).text
    await post(`${srv.url}/doc/flush`, {})
    const fileText = norm(new JSDOM(fs.readFileSync(docPath, 'utf8')).window.document.body.textContent ?? '')

    // lost / extra characters: final = before + other's change + T
    const expected = res.ok ? v.otherText(before.text) : before.text
    const cF = counts(a.text)
    const cE = counts(expected)
    let lost = 0
    let extra = 0
    const cT = counts(v.typed)
    for (const ch of new Set([...cF.keys(), ...cE.keys(), ...cT.keys()])) {
      const d = (cF.get(ch) ?? 0) - (cE.get(ch) ?? 0) - (cT.get(ch) ?? 0)
      if (d < 0) lost -= d
      else extra += d
    }
    const ps = pieces(v.typed, a.text)
    const longest = ps.reduce((x, y) => (y.s.length > x.s.length ? y : x))
    const blk = (longest.s.length >= 3 ? a.blocks.find((b) => b.text.includes(longest.s)) : null) ?? aBlock(a.blocks)
    const p0 = v.p0 ?? P_A
    const c = p0.indexOf(v.caretAfter) + v.caretAfter.length
    const withT = p0.slice(0, c) + v.typed + p0.slice(c)
    const ideal = !res.ok ? withT : v.ideal ? v.ideal(withT) : null
    const pathOk = !res.ok || !v.path ? blk?.path === 'paragraph' || blk?.path === (v.path ?? 'paragraph') : blk?.path === v.path
    let cls: Cls
    if (lost > 0) cls = 'lost'
    else if (ps.length > 1) cls = 'garbled'
    else if (ideal !== null && blk?.text === ideal && pathOk) cls = 'clean'
    else cls = 'misplaced'
    const region = a.blocks.filter((b) => /Phase|Pilot devices|Battery drain/.test(b.text))
    return {
      variant: v.id,
      run,
      offsetMs,
      cls,
      lostChars: lost,
      extraChars: extra,
      pieces: ps.length,
      otherAccepted: res.ok,
      otherOk: res.ok && v.otherOk(a.blocks, a.text),
      otherInfo: res.info,
      impact: res.impact ?? '',
      converged: a.text === otherText,
      fileOk: region.every((b) => fileText.includes(norm(b.text))),
      typedAtEdit,
      aBlock: blk?.text ?? '',
      aPath: blk?.path ?? '',
      ideal,
      caret: a.caret,
      where: ps.filter((p) => p.at >= 0).map((p) => `${JSON.stringify(p.s)} after …${JSON.stringify(a.text.slice(Math.max(0, p.at - 18), p.at))}`),
      ms: Date.now() - t0,
    }
  } finally {
    for (const c of ctxs) await c.close().catch(() => {})
    await srv.stop()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export async function runAll(variants: Variant[], runs: number, parallel: number, onResult: (r: RunResult) => void = () => {}): Promise<RunResult[]> {
  const browser = await chromium.launch()
  const jobs = variants.flatMap((v) => Array.from({ length: runs }, (_, run) => ({ v, run })))
  const results: RunResult[] = []
  try {
    let next = 0
    const worker = async () => {
      while (next < jobs.length) {
        const { v, run } = jobs[next++]
        let r: RunResult | null = null
        for (let attempt = 0; attempt < 2 && !r; attempt++) {
          try {
            r = await runOnce(browser, v, run)
          } catch (e) {
            if (attempt) throw e
            console.error(`retry ${v.id}#${run}: ${(e as Error).message.split('\n')[0]}`)
          }
        }
        results.push(r!)
        onResult(r!)
      }
    }
    await Promise.all(Array.from({ length: parallel }, worker))
  } finally {
    await browser.close()
  }
  const order = new Map(variants.map((v, i) => [v.id, i]))
  return results.sort((a, b) => order.get(a.variant)! - order.get(b.variant)! || a.run - b.run)
}

export function summarize(results: RunResult[]) {
  const by = new Map<string, RunResult[]>()
  for (const r of results) by.set(r.variant, [...(by.get(r.variant) ?? []), r])
  return [...by.entries()].map(([id, rs]) => {
    const n = (c: Cls) => rs.filter((r) => r.cls === c).length
    return {
      id,
      runs: rs.length,
      lost: n('lost'),
      garbled: n('garbled'),
      misplaced: n('misplaced'),
      clean: n('clean'),
      otherOk: rs.filter((r) => r.otherOk).length,
      accepted: rs.filter((r) => r.otherAccepted).length,
      converged: rs.filter((r) => r.converged).length,
      fileOk: rs.filter((r) => r.fileOk).length,
      jumps: rs.filter((r) => r.pieces > 1).length,
    }
  })
}

export const fmtRun = (r: RunResult) =>
  `${r.cls.padEnd(9)} ${r.variant.padEnd(20)} #${r.run} @${String(r.offsetMs).padStart(4)}ms typed=${String(r.typedAtEdit).padStart(2)} lost=${r.lostChars} extra=${r.extraChars} pieces=${r.pieces} other=${r.otherOk ? 'ok' : 'NO'}(${r.otherInfo})${r.impact ? ` impact=${r.impact}` : ''} conv=${r.converged ? 'y' : 'N'} file=${r.fileOk ? 'y' : 'N'}\n           A[${r.aPath}]: ${JSON.stringify(r.aBlock)}\n           caret [${r.caret.path}] …${JSON.stringify(r.caret.left)}|${JSON.stringify(r.caret.right)}…${r.cls !== 'clean' && r.ideal ? `\n           ideal: ${JSON.stringify(r.ideal)}` : ''}${r.pieces > 1 ? `\n           pieces: ${r.where.join(' | ')}` : ''}`

// ---------------------------------------------------------------- CLI
if (process.argv[1]?.endsWith('edges.ts')) {
  const args = process.argv.slice(2)
  const opt = (n: string) => {
    const i = args.indexOf(n)
    return i >= 0 ? args[i + 1] : undefined
  }
  const sc = opt('--scenario')
  const party = opt('--party')
  const vid = opt('--variant')
  const runs = Number(opt('--runs') ?? 5)
  const parallel = Number(opt('--parallel') ?? 3)
  const out = opt('--out') ?? path.join(root, '.work', 'edges-last.json')
  const vs = VARIANTS.filter((v) => (!sc || String(v.scenario) === sc) && (!party || v.party === party) && (!vid || v.id === vid || v.id.startsWith(vid)))
  if (!vs.length) {
    console.error(`no variant matches. Variants:\n${VARIANTS.map((v) => `  ${v.id.padEnd(22)} s${v.scenario} ${v.label}`).join('\n')}`)
    process.exit(2)
  }
  console.log(`${vs.length} variant(s) × ${runs} runs, ${parallel} in parallel`)
  const results = await runAll(vs, runs, parallel, (r) => console.log(fmtRun(r)))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(results, null, 1))
  console.log('\nvariant                 runs lost garb misp clean | other ok  jumps conv file')
  for (const s of summarize(results)) console.log(`${s.id.padEnd(22)} ${String(s.runs).padStart(4)} ${String(s.lost).padStart(4)} ${String(s.garbled).padStart(4)} ${String(s.misplaced).padStart(4)} ${String(s.clean).padStart(5)} | ${String(s.otherOk).padStart(8)} ${String(s.jumps).padStart(6)} ${String(s.converged).padStart(4)} ${String(s.fileOk).padStart(4)}`)
  console.log(`results: ${path.relative(process.cwd(), out)}`)
}
