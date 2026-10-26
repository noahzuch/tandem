// npm run verify: proves the spike's claims headlessly (Node only), exits 0/1.
import { readFileSync, existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import * as Y from 'yjs'
import { runCompare } from '../scripts/compare.ts'
import { canonicalHtml, loadHtml, saveHtml, toJsonFile, loadJsonFile, toYState, loadYState } from '../lib/pipeline.ts'
import { checkHtml } from '../lib/check.ts'

let failed = 0
let passed = 0
function ok(cond: unknown, msg: string) {
  if (cond) passed++
  else failed++
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
}

// ------------------------------------------------------------------ 1. all formats are lossless for the editor
const src = readFileSync('samples/spec.html', 'utf8')
const canon = await canonicalHtml(src)
ok(canon === (await canonicalHtml(canon)), 'canonical HTML is a fixed point (load/save twice)')
const l = loadHtml(canon)
ok((await saveHtml(loadJsonFile(toJsonFile(l, false)))) === canon, 'HTML → PM JSON (getJSON) → HTML is byte-identical')
ok((await saveHtml(loadJsonFile(toJsonFile(l, true)))) === canon, 'HTML → PM JSON (defaults stripped) → HTML is byte-identical')
ok((await saveHtml(loadYState(toYState(l)))) === canon, 'HTML → Yjs state → HTML is byte-identical')

// ------------------------------------------------------------------ 2. the comparison
const s = await runCompare()
for (const e of s.edits) {
  ok(existsSync(`out/edits/${e.id}/after.html`) && existsSync(`out/edits/${e.id}/after.min.json`) && existsSync(`out/edits/${e.id}/after.ystate`), `${e.id}: before/after files written for every format`)
  for (const [f, v] of Object.entries(e.perFormat)) {
    // replaying the measured agent edit(s) on "before" must give exactly "after"
    const olds = v.edit.old.split('\n--- next edit ---\n')
    const news = v.edit.new.split('\n--- next edit ---\n')
    let t = v.before
    olds.forEach((o, i) => {
      ok(t.split(o).length === 2, `${e.id}/${f}: old_string #${i + 1} is unique`)
      t = t.replace(o, () => news[i])
    })
    ok(t === v.after, `${e.id}/${f}: replaying the agent edit reproduces the after file`)
  }
  ok(e.htmlStableAfterSave, `${e.id}: the agent's HTML survives the next editor save unchanged (as a document)`)
  ok(e.yjs.equalsTarget, `${e.id}: Y.Doc after updateYFragment equals the edited document`)
  ok(e.yjs.incrementalUpdateBytes * 4 < e.yjs.fullReplaceUpdateBytes, `${e.id}: incremental Y update (${e.yjs.incrementalUpdateBytes} B) ≪ full replace (${e.yjs.fullReplaceUpdateBytes} B)`)
  const h = e.perFormat.html.edit.emitTokens
  const j = e.perFormat['json-min'].edit.emitTokens
  if (e.id !== 'e1-rewrite-paragraph') ok(h < j, `${e.id}: agent emits fewer tokens in HTML (${h}) than in compact JSON (${j})`)
  else ok(Math.abs(h - j) / h < 0.3, `${e.id}: text-only rewrite costs about the same in HTML (${h}) and JSON (${j})`)
  ok(e.perFormat.html.diff.added < e.perFormat['json-min'].diff.added || e.id === 'e1-rewrite-paragraph', `${e.id}: HTML diff (+${e.perFormat.html.diff.added}) ≤ JSON diff (+${e.perFormat['json-min'].diff.added})`)
}
ok(s.sizes.html.bytes * 3 < s.sizes['json-min'].bytes, `file size: HTML ${s.sizes.html.bytes} B ≪ JSON ${s.sizes['json-min'].bytes} B`)
ok(s.signalRatio.html > 3 * s.signalRatio['json-min'], 'prose share: HTML > 3× JSON')
ok(s.yjsGrowth.gcOn - s.yjsGrowth.initial < 200, `Yjs with gc: typing+deleting 1000 chars grows state by ${s.yjsGrowth.gcOn - s.yjsGrowth.initial} B`)
ok(existsSync('out/report.html') && readFileSync('out/report.html', 'utf8').includes('<title>Storage format comparison</title>'), 'out/report.html generated')

// ------------------------------------------------------------------ 3. JSON validation vs collab check
const m = Object.fromEntries(s.mistakes.map((x) => [x.id, x]))
ok(m['syntax-missing-brace'].json.parse.startsWith('✗'), 'JSON: missing brace → parse error (position only)')
ok(m['marks-as-strings'].json.jsonSchema.startsWith('✗') && m['marks-as-strings'].json.prosemirror.includes('no mark type undefined'), 'JSON: marks as strings → schema error with path, ProseMirror says "no mark type undefined"')
ok(m['text-directly-in-listItem'].json.jsonSchema.startsWith('✓') && m['text-directly-in-listItem'].json.prosemirror.startsWith('✗'), 'JSON: text directly in listItem → JSON Schema passes, only ProseMirror check catches it (no path)')
ok(m['attr-typo'].json.jsonSchema.startsWith('✗') && m['attr-typo'].json.prosemirror.startsWith('✓'), 'JSON: attr typo → only JSON Schema catches it (ProseMirror ignores unknown attrs)')
ok(m['ragged-table-row'].json.prosemirror.startsWith('✓') && m['ragged-table-row'].html.worst.startsWith('✓'), 'ragged table row: neither format complains (tables are repaired on load)')
ok(m['island-with-prose'].json.prosemirror.startsWith('✓') && m['island-with-prose'].json.jsonSchema.startsWith('✓') && m['island-with-prose'].html.finding?.rule === 'prose-in-island', 'prose in an island: valid JSON, only collab check warns')
ok(m['island-broken-html'].json.prosemirror.startsWith('✓') && m['island-broken-html'].html.finding?.rule === 'unclosed-tag', 'broken HTML inside an island: valid JSON, only collab check warns')
ok(m['heading-in-listItem'].html.finding?.rule === 'structure-changed', 'heading in list item: collab check reports the structure change (ground-truth layer)')
ok(m['text-directly-in-listItem'].html.worst.startsWith('✓') && m['paragraph-in-paragraph'].html.worst.startsWith('✓'), 'HTML: missing <p> wrappers / nested <p> are not mistakes (parser + schema normalise them)')

// ------------------------------------------------------------------ 4. validator CLI
const good = spawnSync('npx', ['tsx', 'scripts/check.ts', 'samples/spec.html'], { encoding: 'utf8' })
ok(good.status === 0 && /0 error\(s\), 0 warning\(s\)/.test(good.stdout), 'npm run check -- samples/spec.html → exit 0, no errors/warnings')
ok(/<figure> becomes a raw HTML island/.test(good.stdout) && /<x-agent-note> becomes a raw HTML island/.test(good.stdout), 'spec.html: islands listed (figure, x-agent-note)')
const bad = spawnSync('npx', ['tsx', 'scripts/check.ts', 'samples/bad-agent.html', '--json'], { encoding: 'utf8' })
ok(bad.status === 1, 'npm run check -- samples/bad-agent.html → exit 1')
const findings: { rule: string; severity: string; line: number }[] = JSON.parse(bad.stdout)[0].findings
const has = (rule: string, severity: string, line?: number) => findings.some((f) => f.rule === rule && f.severity === severity && (line === undefined || f.line === line))
for (const [rule, sev, line] of [
  ['js-link-removed', 'warn', 9], ['renamed', 'info', 9], ['event-handler-removed', 'warn', 10], ['prose-in-island', 'warn', 12],
  ['markup-in-code', 'error', 17], ['stray-text', 'warn', 19], ['comment-dropped', 'warn', 22], ['block-in-inline', 'warn', 26],
  ['table-caption', 'warn', 28], ['island', 'info', 34], ['structure-changed', 'error', 41], ['structure-changed', 'error', 43], ['unstable', 'warn', undefined],
] as const)
  ok(has(rule, sev, line), `bad-agent.html: ${sev} ${rule}${line ? ` at L${line}` : ''}`)
ok(!findings.some((f) => f.line >= 47), 'bad-agent.html: the fine <section> at the end has no findings')
for (const e of s.edits) {
  const r = checkHtml(readFileSync(`out/edits/${e.id}/after.html`, 'utf8'), e.id)
  ok(!r.findings.some((f) => f.severity !== 'info'), `${e.id}: agent-written after.html passes collab check`)
}

// ------------------------------------------------------------------ 5. Yjs: agent edits the file while the user types
const y = (id: string, strategy: string, first: boolean) => s.yjsScenarios.find((r) => r.id === id && r.strategy === strategy && r.userEditReachedServerFirst === first)!
ok(s.yjsScenarios.every((r) => r.converged), 'Yjs: server and browser always converge')
ok(!y('different-blocks', 'naive', true).userEditSurvived && !y('different-blocks', 'naive', false).userEditSurvived, 'Yjs naive (rebuild fragment from file): the user\'s concurrent edit is LOST')
ok(!y('different-blocks', '2-way', true).userEditSurvived, 'Yjs 2-way diff (file vs live doc): user edit that reached the server first is REVERTED')
ok(y('different-blocks', '3-way', true).userEditSurvived && y('different-blocks', '3-way', true).agentEditSurvived && y('different-blocks', '3-way', false).userEditSurvived, 'Yjs 3-way (fork at base snapshot, diff, merge): both edits survive in every order')
const sp = s.yjsScenarios.find((r) => r.id === 'same-paragraph')!
ok(sp.agentEditSurvived && sp.userEditSurvived, 'Yjs 3-way, same paragraph: agent rewrite and user typing both survive (text-level merge)')
const si = s.yjsScenarios.find((r) => r.id === 'same-island')!
ok(si.agentEditSurvived !== si.userEditSurvived, 'Yjs, same island: exactly one side wins (island = one attribute, LWW)')
ok(Y.encodeStateAsUpdate(new Y.Doc()).length > 0, 'yjs loaded')

// ------------------------------------------------------------------ 6. npm start serves the report on :5103
await new Promise<void>((resolve) => {
  const child = spawn('npx', ['tsx', 'scripts/start.ts'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '5103' } })
  let outText = ''
  const done = async (good: boolean, msg: string) => {
    ok(good, msg)
    child.kill('SIGTERM')
    resolve()
  }
  const timer = setTimeout(() => done(false, 'npm start: no URL printed within 60 s'), 60_000)
  child.stdout.on('data', async (d) => {
    outText += d
    if (outText.includes('http://127.0.0.1:5103/')) {
      clearTimeout(timer)
      try {
        const r = await fetch('http://127.0.0.1:5103/')
        const t = await r.text()
        const f = await fetch('http://127.0.0.1:5103/edits/e2-add-list-item/after.min.json')
        await done(r.ok && t.includes('Storage format comparison') && f.ok, 'npm start: report served on http://127.0.0.1:5103/ (+ edit files)')
      } catch (e) {
        await done(false, `npm start: fetch failed ${e}`)
      }
    }
  })
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
