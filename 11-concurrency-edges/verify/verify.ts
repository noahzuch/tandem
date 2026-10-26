// npm run verify — spike 11: concurrency edge cases, agent vs. a second human. Exits 0 when every check passes.
//
//   A  headless (Yjs only, deterministic): y-tiptap's simpleDiff span, the caret probe (none / inside-span /
//      recreated), the word-level diff prototype, the position-migration prototype
//   B  every scenario of experiments/edges.ts in real browsers (user A types, the agent patches or B uses the UI):
//      3 runs per scenario at different offsets (2 for the prototypes, the guard and naive variants). The checks assert
//      what was OBSERVED, bad outcomes included ("the agent's type change makes A's caret jump in every run").
//
//   npm run verify [-- --runs 3 --parallel 4]
import * as Y from 'yjs'
import { simpleDiff } from 'lib0/diff'
import { relativePositionToAbsolutePosition, absolutePositionToRelativePosition } from '@tiptap/y-tiptap'
import { fineDiff, mergeInto, render, applyEdits, targetFromHtml, caretProbe } from '../lib/livePatch.ts'
import { setMigratePositions } from '../lib/migrate.ts'
import { bodyToDoc, fragmentOf, seedFragment, withBlockIds, yToDocWithMapping } from '../lib/pipeline.ts'
import { splitDocument } from '../lib/htmlDoc.ts'
import { edgesDocHtml, P_A } from '../lib/edgesDoc.ts'
import { VARIANTS, runAll, summarize, fmtRun, type RunResult } from '../experiments/edges.ts'

const args = process.argv.slice(2)
const opt = (n: string, d: number) => {
  const i = args.indexOf(n)
  return i >= 0 ? Number(args[i + 1]) : d
}
let failures = 0
let passes = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (ok) passes++
  else failures++
}
const observed = (what: string) => console.log(`OBSERVED  ${what}`)
const section = (s: string) => console.log(`\n== ${s}`)

// ---------------------------------------------------------------- A: headless
section('A  headless: span, caret probe, prototypes')
{
  const s = simpleDiff('in the northern region. The team qa1 collects. Once the crash rate', 'in the southern region. The team qa1 collects. Once the error rate')
  check('A1 y-tiptap/lib0 simpleDiff turns two word changes far apart into ONE span that covers the text between them', s.remove > 30 && s.insert.includes('qa1'), `delete ${s.remove} chars at ${s.index}, insert ${JSON.stringify(s.insert)}`)
  const h = fineDiff('in the northern region. The team qa1 collects. Once the crash rate', 'in the southern region. The team qa1 collects. Once the error rate')
  check('A2 the word-level diff prototype makes two small hunks instead', h.length === 2 && h.every((x) => x.remove <= 5), JSON.stringify(h))
}

/** a live doc with the edges sample, a fake awareness holding A's caret after `after` in P_A */
function liveWithCaret(after: string) {
  const live = new Y.Doc()
  seedFragment(live, withBlockIds(bodyToDoc(splitDocument(edgesDocHtml()).body)))
  const { doc, meta } = yToDocWithMapping(live)
  let pos = -1
  doc.descendants((n, p) => {
    if (pos < 0 && n.isTextblock && n.textContent === P_A) pos = p + 1 + P_A.indexOf(after) + after.length
    return pos < 0
  })
  const head = Y.relativePositionToJSON(absolutePositionToRelativePosition(pos, fragmentOf(live), meta.mapping as never))
  const awareness = { clientID: 1, getStates: () => new Map<number, Record<string, unknown>>([[2, { user: { name: 'Noah' }, cursor: { anchor: head, head } }]]) }
  return { live, awareness, pos }
}
type Edits = { old: string; new: string }[]
async function headlessPatch(after: string, edits: Edits | ((html: string) => Edits), apply = true) {
  const { live, awareness, pos } = liveWithCaret(after)
  const r = await render(live)
  const patched = applyEdits(r.html, typeof edits === 'function' ? edits(r.html) : edits)
  const m = mergeInto(live, r.base, (bd, prefer) => targetFromHtml(bd, r.html, patched.html, prefer), 'agent', true, awareness as never, apply)
  return { live, m, awareness, pos }
}
const pChunkOf = (html: string) => {
  const i = html.indexOf('Phase one')
  return html.slice(html.lastIndexOf('<p', i), html.indexOf('</p>', i) + 4)
}
{
  const a = await headlessPatch('every week', [
    { old: 'northern region', new: 'southern region' },
    { old: 'the crash rate', new: 'the error rate' },
  ])
  check('A3 caret probe: two words around the caret → inside-span', a.m.caretImpact[0]?.impact === 'inside-span', JSON.stringify(a.m.caretImpact))
  const b = await headlessPatch('every week', [{ old: 'every week and', new: 'every week, and' }])
  check('A4 caret probe: a change right AFTER the caret (the char left of it survives) → none', b.m.caretImpact[0]?.impact === 'none', JSON.stringify(b.m.caretImpact))
  const c = await headlessPatch('every week', [{ old: 'every week', new: 'every month' }])
  check('A5 caret probe: the word right BEFORE the caret replaced (its last letter is the caret anchor) → inside-span', c.m.caretImpact[0]?.impact === 'inside-span', JSON.stringify(c.m.caretImpact))
  const toH2 = (html: string) => {
    const old = pChunkOf(html)
    return [{ old, new: old.replace(/^<p/, '<h2').replace(/<\/p>$/, '</h2>') }]
  }
  const d = await headlessPatch('every week', toH2)
  check('A6 caret probe: <p> → <h2> by patch → recreated', d.m.caretImpact[0]?.impact === 'recreated', JSON.stringify(d.m.caretImpact))
  const dry = await headlessPatch('every week', toH2, false)
  let headingNow = false
  yToDocWithMapping(dry.live).doc.descendants((n) => {
    if (n.type.name === 'heading' && n.textContent.startsWith('Phase one')) headingNow = true
  })
  check('A7 dry run (apply=false, what --avoid-jump uses) reports the impact without changing the live doc', dry.m.caretImpact[0]?.impact === 'recreated' && !headingNow)

  // position migration: the caret resolves into the new heading at the same offset
  for (const on of [false, true]) {
    setMigratePositions(on)
    const { live, awareness } = liveWithCaret('every week')
    const r = await render(live)
    const o = pChunkOf(r.html)
    const patched = applyEdits(r.html, [{ old: o, new: o.replace(/^<p/, '<h2').replace(/<\/p>$/, '</h2>') }])
    mergeInto(live, r.base, (bd, prefer) => targetFromHtml(bd, r.html, patched.html, prefer), 'agent', true, awareness as never)
    const rel = Y.createRelativePositionFromJSON((awareness.getStates().get(2) as { cursor: { head: unknown } }).cursor.head)
    const { doc, meta } = yToDocWithMapping(live)
    const p = relativePositionToAbsolutePosition(live, fragmentOf(live), rel, meta.mapping as never)
    const $p = p === null ? null : doc.resolve(p)
    const where = $p ? `${$p.parent.type.name} …${JSON.stringify($p.parent.textContent.slice(Math.max(0, $p.parentOffset - 12), $p.parentOffset))}` : 'null'
    if (!on) check('A8 without migrations the caret of a re-created block does not resolve (y-tiptap must guess)', p === null, where)
    else check('A9 PROTOTYPE --migrate-positions: the caret resolves into the new heading right after "every week"', $p?.parent.type.name === 'heading' && $p.parent.textContent.slice(0, $p.parentOffset).endsWith('every week'), where)
  }
  setMigratePositions(false)
  void caretProbe
}

// ---------------------------------------------------------------- B: browsers
if (args.includes('--headless-only')) {
  console.log(`\n${passes} passed, ${failures} failed`)
  process.exit(failures ? 1 : 0)
}
section('B  scenarios in real browsers (user A types; the agent patches / B uses the editor UI)')
const runs = opt('--runs', 3)
const parallel = opt('--parallel', 4)
const main = VARIANTS.filter((v) => v.scenario <= 5)
const extra = VARIANTS.filter((v) => v.scenario > 5)
const t0 = Date.now()
const results: RunResult[] = [...(await runAll(main, runs, parallel)), ...(await runAll(extra, Math.min(runs, 2), parallel))]
console.log(`${results.length} runs in ${Math.round((Date.now() - t0) / 1000)} s`)
const by = (id: string) => results.filter((r) => r.variant === id)
const all = (id: string, p: (r: RunResult) => boolean) => by(id).length > 0 && by(id).every(p)
const show = (id: string) => by(id).map((r) => `#${r.run}:${r.cls}${r.impact ? `/${r.impact}` : ''}`).join(' ')
const squash = (s: string) => s.replace(/\s+/g, '')
/** only a space vanished (the html round trip collapsed "qd4␣␣and"), A's text is contiguous */
const wsOnly = (r: RunResult) => r.cls === 'lost' && r.pieces === 1 && r.ideal !== null && squash(r.aBlock) === squash(r.ideal)
/** a keystroke typed while the change was in flight went into the deleted element (≤ 2 chars) */
const inflight = (r: RunResult) => r.cls === 'lost' && r.lostChars <= 2
const clean = (r: RunResult) => r.cls === 'clean'
/** a char-level human edit: clean, or one of the rare same-instant races (one keystroke lost, or B's own word scrambled
 *  by A typing right next to it); at least one clean run */
const humanOk = (id: string) => all(id, (r) => clean(r) || r.lostChars <= 1 || (r.cls === 'misplaced' && r.pieces === 1)) && by(id).some(clean)
const ex = (id: string, pick: (r: RunResult) => boolean = () => true) => {
  const r = by(id).find(pick)
  if (r) observed(`${id} #${r.run} (${r.cls}): A typed ${JSON.stringify(VARIANTS.find((v) => v.id === id)!.typed)} → ${JSON.stringify(r.aBlock)}; caret ended …${JSON.stringify(r.caret.left)}|${JSON.stringify(r.caret.right)}…`)
}

check('B0 every run converged (A == B / server) and the file on disk has A\'s final blocks', results.every((r) => r.converged && r.fileOk), results.filter((r) => !r.converged || !r.fileOk).map((r) => `${r.variant}#${r.run}`).join(' '))

// S1
check('S1a agent (2 words far apart, A types between): A\'s caret jumps to the start of the span in EVERY run', all('1a-agent', (r) => r.pieces > 1 && r.impact === 'inside-span'), show('1a-agent'))
ex('1a-agent')
check('S1a human (B retypes the same 2 words): clean (rare same-instant races aside), A\'s caret never jumps to a span', humanOk('1a-human'), show('1a-human'))
check('S1b (word right before A\'s text) agent: clean, except a run where the caret probe said inside-span or only a space vanished', all('1b-agent', (r) => clean(r) || r.impact === 'inside-span' || wsOnly(r)), show('1b-agent'))
check('S1b human: clean (rare same-instant races aside)', humanOk('1b-human'), show('1b-human'))
check('S1c (word right after the caret) agent: clean in every run (the caret probe says none)', all('1c-agent', (r) => clean(r) && r.impact === 'none'), show('1c-agent'))
check('S1c human: clean (measured 8/10: one keystroke lost, once B\'s own word scrambled by A typing right next to it)', humanOk('1c-human'), show('1c-human'))
check('S1d (caret rests right after the replaced word): agent AND human both put A\'s next keystrokes BEFORE the new word (misplaced), same text', all('1d-agent', (r) => r.cls === 'misplaced') && all('1d-human', (r) => r.cls === 'misplaced') && by('1d-agent')[0]?.aBlock === by('1d-human')[0]?.aBlock, `${show('1d-agent')} | ${show('1d-human')}`)
ex('1d-human')

// S2
for (const id of ['2a-agent', '2b-agent', '2c-agent', '2d-agent'])
  check(`S2 ${id}: block type change by the agent re-creates the element → A's caret jumps to the next block in EVERY run (+ in-flight chars lost)`, all(id, (r) => r.cls !== 'clean' && r.impact === 'recreated' && r.caret.right.startsWith('7. Risks')), show(id))
ex('2a-agent')
for (const id of ['2a-human', '2c-human', '2d-human'])
  // measured over 10 runs: 2a 10/10 clean, 2c 8/10, 2d 7/10; every non-clean run = exactly the keystroke in flight lost + caret to the next block
  check(`S2 ${id}: "Turn into" by B: clean, except the keystroke in flight (lost, ≤ 2 chars, caret to the next block); never a jump without a loss`, all(id, (r) => clean(r) || (inflight(r) && r.caret.right.startsWith("7. Risks"))) && by(id).some(clean), show(id))

// S3
check('S3a agent rewrites the sentence A types in (fresh read): A\'s characters typed so far are gone in every run (overwritten), the agent\'s sentence is intact', all('3a-agent', (r) => r.cls === 'lost' && r.otherOk), show('3a-agent'))
ex('3a-agent')
check('S3b agent with a STALE SEARCH: NOT_FOUND in every run, A\'s text intact (the SEARCH string protects A)', all('3b-agent', (r) => clean(r) && !r.otherAccepted), show('3b-agent'))
check('S3 human (B selects the sentence incl. A\'s text and types a new one): same outcome as the agent: A\'s earlier characters overwritten, B\'s sentence intact', all('3-human', (r) => r.cls === 'lost' && r.otherOk), show('3-human'))
ex('3-human')

// S4
check('S4a agent move-section (A types in the moved section): clean in every run', all('4a-agent', clean), show('4a-agent'))
check('S4b agent patch that moves A\'s paragraph AND edits it: clean when the caret probe says none (the merge keeps the caret block in place)', all('4b-agent', (r) => clean(r) || r.impact === 'inside-span' || wsOnly(r)), show('4b-agent'))
check("S4 human Alt+Shift+↑ and drag handle: clean, except the keystroke in flight (measured: drag 6/10 clean)", all("4a-human", (r) => clean(r) || inflight(r)) && all("4b-human", (r) => clean(r) || inflight(r)) && by("4b-human").length > 0, `${show('4a-human')} | ${show('4b-human')}`)

// S5
check('S5 agent proofreads 3 typos (3 small SEARCH blocks): A\'s caret jumps in EVERY run (span = first to last typo)', all('5-agent', (r) => r.pieces > 1 && r.impact === 'inside-span'), show('5-agent'))
ex('5-agent')
check('S5 agent sends the whole fixed paragraph (fresh read): same jump in every run', all('5-agent-whole', (r) => r.pieces > 1), show('5-agent-whole'))
check('S5 human fixes the same 3 typos: clean (rare same-instant races aside)', humanOk('5-human'), show('5-human'))

// span rule over every applied default-merge agent patch/op
const agentRuns = results.filter((r) => /^[1245][a-d]?-agent(-whole)?$/.test(r.variant) && r.otherAccepted)
const bad = (r: RunResult) => !clean(r) && !wsOnly(r)
const ruleHits = agentRuns.filter((r) => r.impact === 'inside-span' || r.impact === 'recreated')
const ruleMiss = agentRuns.filter((r) => !(r.impact === 'inside-span' || r.impact === 'recreated'))
check('RULE the caret probe separates them: every agent run with impact inside-span/recreated ended badly, every run with impact none ended clean (or lost one collapsed space)', ruleHits.every(bad) && ruleMiss.every((r) => !bad(r)), `${ruleHits.length} flagged: ${ruleHits.filter(bad).length} bad; ${ruleMiss.length} not flagged: ${ruleMiss.filter(bad).length} bad (${ruleMiss.filter(bad).map((r) => `${r.variant}#${r.run}`).join(' ')})`)
observed(`whitespace collapse (a space A just typed next to another space vanished): ${results.filter(wsOnly).map((r) => `${r.variant}#${r.run}`).join(' ') || 'not in this run'}`)

// S6: spike 07's merge
check('S6 --naive-merge (spike 07) jumps the same way in 1a and 5: spike 08\'s merge fixes do not touch the span', all('1a-agent-naive', (r) => r.pieces > 1) && all('5-agent-naive', (r) => r.pieces > 1), `${show('1a-agent-naive')} | ${show('5-agent-naive')}`)
check('S6 --naive-merge type change: caret jumps too', all('2a-agent-naive', (r) => !clean(r)), show('2a-agent-naive'))

// S7–S9: prototypes
for (const id of ['1a-agent-fine', '5-agent-fine', '5-agent-whole-fine']) check(`S7 PROTOTYPE --fine-diff ${id}: clean`, all(id, clean), show(id))
check('S7 PROTOTYPE --fine-diff does not help the sentence rewrite (3a): still overwritten', all('3a-agent-fine', (r) => r.cls === 'lost'), show('3a-agent-fine'))
for (const id of ['1a-agent-migrate', '5-agent-migrate', '2a-agent-migrate', '2b-agent-migrate', '2c-agent-migrate', '2d-agent-migrate'])
  check(`S8 PROTOTYPE --migrate-positions ${id}: A's caret no longer jumps (only with a keystroke in flight); whitespace collapse remains`, all(id, (r) => r.pieces === 1 || inflight(r)) && by(id).some((r) => r.pieces === 1), show(id))
for (const id of ['1a-agent-both', '1b-agent-both', '5-agent-both', '2a-agent-both', '2c-agent-both', '4b-agent-both'])
  check(`S9 PROTOTYPE both ${id}: clean (or a keystroke in flight / a space collapsed in a re-created block)`, all(id, (r) => clean(r) || inflight(r) || wsOnly(r)) && by(id).some(clean), show(id))

// S10: the guard
for (const id of ['1a-agent-guard', '5-agent-guard', '2a-agent-guard', '3a-agent-guard'])
  check(`S10 patch --avoid-jump ${id}: refused (USER_IN_SPAN), A clean`, all(id, (r) => clean(r) && !r.otherAccepted && r.otherInfo.includes('USER_IN_SPAN')), show(id))
for (const id of ['1b-agent-guard', '1c-agent-guard', '4b-agent-guard'])
  check(`S10 patch --avoid-jump ${id}: applied when the caret would not jump (refused only when it would)`, all(id, (r) => (r.otherAccepted && (clean(r) || wsOnly(r))) || (!r.otherAccepted && r.otherInfo.includes('USER_IN_SPAN'))) && by(id).some((r) => r.otherAccepted), show(id))

console.log('\nvariant                 runs lost garb misp clean | other ok  jumps conv file')
for (const s of summarize(results)) console.log(`${s.id.padEnd(22)} ${String(s.runs).padStart(4)} ${String(s.lost).padStart(4)} ${String(s.garbled).padStart(4)} ${String(s.misplaced).padStart(4)} ${String(s.clean).padStart(5)} | ${String(s.otherOk).padStart(8)} ${String(s.jumps).padStart(6)} ${String(s.converged).padStart(4)} ${String(s.fileOk).padStart(4)}`)
if (failures) for (const r of results) if (r.cls !== 'clean') console.log(fmtRun(r))
console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
