// npm run verify — spike 08: the scripted (no LLM) version of the edit-path comparison. Exits 0 when every check passes.
//
//   A  patch matching rules (unit): exact / whitespace-insensitive / NOT_FOUND + closest block / AMBIGUOUS / all / atomic
//   B  merge unit (headless Yjs): a trailing space the user just typed survives an agent edit elsewhere (smart merge),
//      and is lost with spike 07's full re-parse (naive) — the "leadreads" bug from the P1 run
//   C  the 8 spec-editing tasks via P1 (file write), P2 (ops), P3 (patch), P4 (export/apply) while a real browser user
//      keeps typing in the blocks the tasks touch → every typed sentence intact, every task applied, browser == server.
//      The naive variants (--naive-merge --no-store-guard = spike 07) run too and are reported as OBSERVED.
//   D  P1 store race: a store that runs inside the watcher's settle window overwrites the agent's file edit (spike 07);
//      the store guard keeps it
//   E  caret: block inserted before + text changed in the caret's block in ONE update → caret jumps into the new block
//      (naive) / stays (two-pass merge), for P1/P2/P3
//   F  patch errors as the agent sees them (CLI): stale old string while the user types, ambiguous, --avoid-caret,
//      --dry-run, suggestion mode (--propose → user clicks "Accept change")
//   G  moving a section while the user types in it (P3 keeps the caret's block; P2 move-section re-creates it)
//   H  reading: `collab read` is fresh while the file lags; --outline marks the user's block; --section slices
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { chromium, type Browser, type Page } from 'playwright'
import { root, startServer, type ServerHandle } from '../lib/serverProc.ts'
import { applyEdits, findAll, PatchError, mergeInto, render, targetFromHtml, htmlToDoc } from '../lib/livePatch.ts'
import { loadHtml, seedFragment, withBlockIds, yToDoc, docText } from '../lib/pipeline.ts'
import { applyOp } from '../lib/agentOps.ts'
import { parsePatch } from '../bin/collab.ts'
import { caretStructural } from '../experiments/caret-structural.ts'

const sample = path.resolve(root, '../samples/spec.html')
let failures = 0
let passes = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (ok) passes++
  else failures++
}
const observed = (what: string) => console.log(`OBSERVED  ${what}`)
const section = (s: string) => console.log(`\n== ${s}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const tmpDoc = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike08-'))
  const doc = path.join(dir, 'spec.html')
  fs.copyFileSync(sample, doc)
  return doc
}

// ---------------------------------------------------------------- CLI as the agent runs it
interface Run {
  code: number | null
  stdout: string
  json: any
}
function cli(url: string, args: string[], stdin?: string): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'bin/collab.ts', '--server', url, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    p.stderr.on('data', (d: Buffer) => (stdout += d.toString()))
    p.on('exit', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith('{'))
      let json: any = null
      try {
        json = line ? JSON.parse(line) : null
      } catch {
        /* */
      }
      resolve({ code, stdout, json })
    })
    if (stdin !== undefined) p.stdin.write(stdin)
    p.stdin.end()
  })
}
const block = (old: string, neu: string, all = false) => `<<<<<<< SEARCH\n${old}\n=======\n${neu}\n>>>>>>> REPLACE${all ? ' ALL' : ''}\n`
const getJson = async (url: string) => (await fetch(url)).json() as Promise<any>
const postJson = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, json: (await r.json()) as any }
}

// ---------------------------------------------------------------- browser user
async function openUser(browser: Browser, url: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  await page.goto(`${url}/?user=Noah`)
  await page.waitForFunction(() => (window as any).__editor && (window as any).__provider?.synced, null, { timeout: 20000 })
  await sleep(400)
  return page
}
async function caretAtEnd(page: Page, anchor: string): Promise<boolean> {
  return page.evaluate((a) => {
    const ed = (window as any).__editor
    let end = -1
    ed.state.doc.descendants((n: any, p: number) => {
      if (end < 0 && n.isTextblock && n.textContent.includes(a)) end = p + n.nodeSize - 1
      return end < 0
    })
    if (end < 0) return false
    ed.commands.setTextSelection(end)
    ed.view.focus()
    return true
  }, anchor)
}
const pageText = (page: Page) => page.evaluate(() => (window as any).__editor.state.doc.textBetween(0, (window as any).__editor.state.doc.content.size, '\n', '￼') as string)
const liveText = async (url: string) => ((await getJson(`${url}/doc/state`)) as { text: string }).text

/** keep typing sentences (one per anchor, round robin) until stop() — returns what was typed */
function typingUser(page: Page, anchors: string[], delay = 60) {
  let stop = false
  const typed: { marker: string; text: string; anchor: string }[] = []
  const done = (async () => {
    let n = 0
    while (!stop) {
      n++
      const anchor = anchors[(n - 1) % anchors.length]
      const marker = `v${String(n).padStart(2, '0')}`
      const text = ` Noted by ops ${marker}.`
      if (!(await caretAtEnd(page, anchor))) continue
      await page.keyboard.type(text, { delay })
      typed.push({ marker, text, anchor })
      await sleep(250)
    }
  })()
  return {
    typed,
    stop: async () => {
      stop = true
      await done
    },
  }
}

async function converged(page: Page, url: string) {
  let b = ''
  let s = ''
  for (let i = 0; i < 60; i++) {
    b = await pageText(page)
    s = await liveText(url)
    if (b === s) return true
    await sleep(100)
  }
  return false
}

async function userComment(page: Page, quote: string, text: string): Promise<string> {
  await page.getByTestId('mode-now').click()
  await page.evaluate((s) => {
    const ed = (window as any).__editor
    let from = -1
    ed.state.doc.descendants((n: any, p: number) => {
      if (from >= 0 || !n.isText) return
      const i = n.text.indexOf(s)
      if (i >= 0) from = p + i
    })
    ed.commands.setTextSelection({ from, to: from + s.length })
    ed.view.focus()
  }, quote)
  await page.getByTestId('bubble-comment').click()
  await page.getByTestId('composer').waitFor({ timeout: 3000 })
  await page.getByTestId('kind-change').click()
  await page.getByTestId('composer-text').fill(text)
  await page.getByTestId('composer-submit').click()
  await page.getByTestId('composer').waitFor({ state: 'detached', timeout: 3000 })
  return page.evaluate(() => (window as any).__comments.store.active as string)
}

// ---------------------------------------------------------------- the 8 tasks, as text edits (P1/P3/P4) and as ops (P2)
type TextEdit = (html: string) => { old: string; new: string }[]
const SVG = `<h2 id="rollout">6. Rollout</h2>
<p>We roll out in three waves.</p>
<figure class="diagram">
  <svg width="620" height="90" viewBox="0 0 620 90" xmlns="http://www.w3.org/2000/svg">
    <rect x="10" y="20" width="170" height="50" rx="8" fill="#e7f0ff" stroke="#4a78c2"/>
    <text x="95" y="50" text-anchor="middle" font-size="14">Pilot: 20 devices</text>
    <rect x="225" y="20" width="170" height="50" rx="8" fill="#fff7e6" stroke="#d98e04"/>
    <text x="310" y="50" text-anchor="middle" font-size="14">One region</text>
  </svg>
  <figcaption>Figure 3: Rollout waves.</figcaption>
</figure>`
const liOf = (html: string, text: string) => {
  const m = new RegExp(`<li>(?:(?!</li>)[\\s\\S])*?${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:(?!</li>)[\\s\\S])*?</li>`).exec(html)
  if (!m) throw new Error(`li not found: ${text}`)
  // the innermost <li> that contains the text
  const s = m[0]
  return s.slice(s.lastIndexOf('<li>', s.indexOf(text)))
}
const rowOf = (html: string, text: string) => {
  const i = html.indexOf(text)
  const a = html.lastIndexOf('<tr>', i)
  const b = html.indexOf('</tr>', i) + 5
  return html.slice(a, b)
}
const sectionOf = (html: string, id: string) => {
  const a = html.search(new RegExp(`<h2[^>]*id="${id}"`))
  const b = html.slice(a + 5).search(/<h2[^>]*>/) + a + 5
  return html.slice(a, b)
}
const TASKS: { name: string; edits: TextEdit; ops: object[] }[] = [
  { name: 'T1 reword a requirement', edits: () => [{ old: 'for a typical day of notes.', new: 'for up to 500 queued notes.' }], ops: [{ op: 'replace-text', find: 'for a typical day of notes.', replace: 'for up to 500 queued notes.' }] },
  {
    name: 'T2 add a list item',
    edits: (h) => {
      const li = liOf(h, 'Never lose a note written offline.')
      return [{ old: li, new: `${li}\n  <li><p>Sync uses at most 2 % battery per day.</p></li>` }]
    },
    ops: [{ op: 'insert-after', find: 'Never lose a note written offline.', html: '<li><p>Sync uses at most 2 % battery per day.</p></li>' }],
  },
  {
    name: 'T3 add a table row',
    edits: (h) => {
      const row = rowOf(h, 'Stale base version')
      return [{ old: row, new: `${row}\n<tr><td><p><code>429</code></p></td><td><p>Rate limited</p></td><td><p>Retry later</p></td></tr>` }]
    },
    ops: [{ op: 'insert-after', find: 'Stale base version', html: '<tr><td><p><code>429</code></p></td><td><p>Rate limited</p></td><td><p>Retry later</p></td></tr>' }],
  },
  { name: 'T4 new section with SVG', edits: () => [{ old: 'please confirm.</x-agent-note>', new: `please confirm.</x-agent-note>\n${SVG}` }], ops: [{ op: 'append-section', html: SVG }] },
  {
    name: 'T5 rename a term (prose + island, not code)',
    edits: () => [
      { old: '>Outbox queue<', new: '>Send queue<' },
      { old: 'a durable outbox,', new: 'a durable send queue,' },
      { old: 'The outbox stays', new: 'The send queue stays' },
      { old: 'appended to the outbox', new: 'appended to the send queue' },
      { old: 'Drop ops from outbox', new: 'Drop ops from send queue' },
      { old: 'Agree on outbox storage', new: 'Agree on send queue storage' },
    ],
    ops: [
      { op: 'set-island-text', find: '>Outbox queue<', replace: '>Send queue<' },
      { op: 'set-island-text', find: 'a durable outbox,', replace: 'a durable send queue,' },
      { op: 'replace-text', find: 'The outbox stays', replace: 'The send queue stays' },
      { op: 'replace-text', find: 'appended to the outbox', replace: 'appended to the send queue' },
      { op: 'replace-text', find: 'Drop ops from outbox', replace: 'Drop ops from send queue' },
      { op: 'replace-text', find: 'Agree on outbox storage', replace: 'Agree on send queue storage' },
    ],
  },
  { name: 'T6 island label', edits: () => [{ old: '>Sync server<', new: '>Sync API<' }], ops: [{ op: 'set-island-text', find: '>Sync server<', replace: '>Sync API<' }] },
  {
    name: 'T7 reorder two sections',
    edits: (h) => {
      const sec = sectionOf(h, 'conflicts')
      const api = /<h2[^>]*id="api"[^>]*>3\. API<\/h2>/.exec(h)![0]
      return [
        { old: sec, new: '' },
        { old: api, new: `${sec}${api}` },
      ]
    },
    ops: [{ op: 'move-section', heading: '4. Conflict handling', before: '3. API' }],
  },
  { name: 'T8 answer a comment by changing text', edits: () => [{ old: 'connectivity on site.', new: 'connectivity on site (basements, rural areas).' }], ops: [{ op: 'replace-text', find: 'connectivity on site.', replace: 'connectivity on site (basements, rural areas).' }] },
]
const USER_ANCHORS = ['Sync completes within', 'Field technicians lose', 'Stale base version', 'Saves are appended to the', 'Never lose a note', 'Full-document sync']

type PathName = 'P1 Edit tool on the file' | 'P2 CLI ops' | 'P3 patch op' | 'P4 export → edit → apply'
interface PathResult {
  path: string
  typed: number
  lost: string[]
  tasksOk: string[]
  tasksFailed: string[]
  retries: number
  sentChars: number
  converged: boolean
  threadOk: boolean
  health: any
}

/** apply a list of text edits like Claude's Edit tool: each edit re-reads the CURRENT file and fails if old isn't there */
async function editFile(file: string, edits: { old: string; new: string }[], r: { retries: number }) {
  for (const e of edits) {
    for (let attempt = 0; ; attempt++) {
      const cur = fs.readFileSync(file, 'utf8')
      const hits = findAll(cur, e.old).filter((h) => !h.fuzzy)
      if (hits.length === 1) {
        fs.writeFileSync(file, cur.slice(0, hits[0].index) + e.new + cur.slice(hits[0].index + hits[0].length))
        break
      }
      if (attempt >= 10) throw new Error(`old string not found/unique in file after ${attempt} retries: ${e.old.slice(0, 60)}`)
      r.retries++
      await sleep(300)
    }
  }
}

async function runPath(browser: Browser, p: PathName, serverArgs: string[] = []): Promise<PathResult> {
  const doc = tmpDoc()
  const srv = await startServer(doc, 0, serverArgs)
  const res: PathResult = { path: `${p}${serverArgs.length ? ` [${serverArgs.join(' ')}]` : ''}`, typed: 0, lost: [], tasksOk: [], tasksFailed: [], retries: 0, sentChars: 0, converged: false, threadOk: false, health: null }
  try {
    const page = await openUser(browser, srv.url)
    const thread = await userComment(page, 'on site', 'Which sites?')
    const user = typingUser(page, USER_ANCHORS)
    await sleep(1500)
    const scratch = path.join(path.dirname(doc), 'scratch', 'spec.html')
    if (p === 'P4 export → edit → apply') await cli(srv.url, ['export', scratch])
    for (const t of TASKS) {
      try {
        if (p === 'P2 CLI ops') {
          for (const op of t.ops) {
            const r = await postJson(`${srv.url}/agent/op`, { op })
            if (!r.json.ok) throw new Error(r.json.error)
            res.sentChars += Object.values(op).filter((v) => typeof v === 'string').join('').length
          }
        } else if (p === 'P3 patch op') {
          for (let attempt = 0; ; attempt++) {
            const html = (await getJson(`${srv.url}/agent/read`)).html as string
            const edits = t.edits(html)
            const r = await cli(srv.url, ['patch'], edits.map((e) => block(e.old, e.new)).join(''))
            if (r.code === 0) {
              res.sentChars += edits.reduce((n, e) => n + e.old.length + e.new.length, 0)
              break
            }
            if (attempt >= 5) throw new Error(r.stdout.slice(0, 200))
            res.retries++
          }
        } else if (p === 'P1 Edit tool on the file') {
          const edits = t.edits(fs.readFileSync(doc, 'utf8'))
          res.sentChars += edits.reduce((n, e) => n + e.old.length + e.new.length, 0)
          await editFile(doc, edits, res)
        } else {
          const edits = t.edits(fs.readFileSync(scratch, 'utf8'))
          res.sentChars += edits.reduce((n, e) => n + e.old.length + e.new.length, 0)
          await editFile(scratch, edits, res)
        }
      } catch (e) {
        res.tasksFailed.push(`${t.name}: ${(e as Error).message.slice(0, 120)}`)
      }
      await sleep(700)
    }
    if (p === 'P4 export → edit → apply') {
      const r = await cli(srv.url, ['apply', scratch])
      if (r.code !== 0) res.tasksFailed.push(`apply: ${r.stdout.slice(0, 200)}`)
    }
    await cli(srv.url, ['reply', thread, 'Named them.', '--resolve'])
    await sleep(1500)
    await user.stop()
    await sleep(p === 'P1 Edit tool on the file' ? 1500 : 800)
    res.converged = await converged(page, srv.url)
    const text = await liveText(srv.url)
    const html = (await getJson(`${srv.url}/agent/read`)).html as string
    res.typed = user.typed.length
    res.lost = user.typed.filter((u) => !norm(text).includes(norm(u.text))).map((u) => `${u.marker}@"${u.anchor}": ${text.includes(u.marker) ? 'MANGLED' : 'MISSING'}`)
    const checks: [string, boolean][] = [
      ['T1', text.includes('for up to 500 queued notes.')],
      ['T2', text.includes('Sync uses at most 2 % battery per day.')],
      ['T3', text.includes('Rate limited')],
      ['T4', text.includes('6. Rollout') && html.includes('Pilot: 20 devices')],
      ['T5', ['The send queue stays', 'appended to the send queue', 'Drop ops from send queue', 'Agree on send queue storage'].every((s) => text.includes(s)) && html.includes('>Send queue<') && html.includes('a durable send queue,') && html.includes('flush(outbox: Outbox)')],
      ['T6', html.includes('>Sync API<')],
      ['T7', html.search(/id="conflicts"/) < html.search(/id="api"/) && (html.match(/id="conflicts"/g) ?? []).length === 1],
      ['T8', text.includes('on site (basements, rural areas).')],
    ]
    for (const [n, ok] of checks) (ok ? res.tasksOk : res.tasksFailed).push(n)
    const threads = (await getJson(`${srv.url}/api/threads?all=1`)).threads as any[]
    const t8 = threads.find((t) => t.thread === thread)
    res.threadOk = !!t8 && t8.status === 'resolved' && !t8.orphaned
    res.health = await getJson(`${srv.url}/health`)
    await page.close()
  } finally {
    await srv.stop()
  }
  return res
}

// =====================================================================================================================
async function main() {
  // ---------------------------------------------------------------- A
  section('A  patch matching rules')
  const html = '<p>\n  The client sends batches of operations. Each operation carries a\n  <mark>client-generated id</mark> so retries are idempotent.\n</p>\n<p>outbox one</p>\n<p>outbox two</p>'
  {
    const r = applyEdits(html, [{ old: 'batches of operations', new: 'batches of at most 50 operations' }])
    check('exact match replaces', r.html.includes('batches of at most 50 operations') && r.fuzzy.length === 0)
  }
  {
    const r = applyEdits(html, [{ old: 'Each operation carries a <mark>client-generated id</mark> so', new: 'Each op carries a <mark>client-generated id</mark> so' }])
    check('whitespace-insensitive match (old written on one line, the file wrapped by prettier)', r.fuzzy[0] === 1 && r.html.includes('Each op carries a <mark>client-generated id</mark> so retries'))
  }
  {
    const r = applyEdits(html, [{ old: 'carries a <mark>client-generated id</mark>', new: 'carries an <mark>id</mark>' }])
    check('whitespace that follows the match is kept (no "</mark>so")', r.html.includes('<mark>id</mark> so retries'), JSON.stringify(r.html.slice(60, 140)))
  }
  try {
    applyEdits(html, [{ old: 'batches of 20 operations', new: 'x' }])
    check('NOT_FOUND', false)
  } catch (e) {
    const pe = e as PatchError
    check('NOT_FOUND names the closest block and gives its CURRENT html', pe.code === 'NOT_FOUND' && (pe.details.closest as any)?.html.includes('batches of operations') && /closest block is at line 1/.test(pe.message), pe.message.slice(0, 90))
  }
  try {
    applyEdits(html, [{ old: 'outbox', new: 'send queue' }])
    check('AMBIGUOUS', false)
  } catch (e) {
    const pe = e as PatchError
    check('AMBIGUOUS lists every match with its line', pe.code === 'AMBIGUOUS' && /matches 2 times \(lines 5, 6\)/.test(pe.message) && (pe.details.matches as any[]).length === 2, pe.message.slice(0, 80))
  }
  check('all=true replaces every occurrence', (applyEdits(html, [{ old: 'outbox', new: 'send queue', all: true }]).html.match(/send queue/g) ?? []).length === 2)
  try {
    applyEdits(html, [
      { old: 'outbox one', new: 'X' },
      { old: 'does not exist', new: 'Y' },
    ])
    check('atomic', false)
  } catch (e) {
    check('a patch is all-or-nothing: edit 2 fails → error names edit 2, nothing applied', (e as PatchError).message.startsWith('edit 2/2'))
  }
  {
    const edits = parsePatch(block('a\nb', 'c') + block('x', 'y', true))
    check('SEARCH/REPLACE blocks parse (multi-line, REPLACE ALL)', edits.length === 2 && edits[0].old === 'a\nb' && edits[0].new === 'c' && edits[1].all === true)
    let msg = ''
    try {
      parsePatch('<<<<<<< SEARCH\nfoo\n')
    } catch (e) {
      msg = (e as Error).message
    }
    check('malformed block → clear parse error', /missing "======="/.test(msg), msg)
  }

  // ---------------------------------------------------------------- B
  section('B  merge unit: the user’s trailing space vs an agent edit elsewhere')
  for (const smart of [true, false]) {
    const live = new Y.Doc()
    seedFragment(live, withBlockIds(loadHtml(fs.readFileSync(sample, 'utf8')).doc))
    // the user has typed "… the ops lead " (trailing space, mid-word-break) at the end of the appendix paragraph
    applyOp(live, { op: 'insert-after-text', find: 'on each reconnect.', text: ' the ops lead ' })
    const r = await render(live)
    const patched = applyEdits(r.html, [{ old: 'for a typical day of notes.', new: 'for up to 500 queued notes.' }]).html
    mergeInto(live, r.base, (bd, prefer) => (smart ? targetFromHtml(bd, r.html, patched, prefer) : htmlToDoc(patched)), 'agent', smart)
    const t = docText(yToDoc(live))
    const keeps = t.includes('the ops lead \n') // trailing space still there
    if (smart) check('smart merge (splice + node reuse): the trailing space survives, the agent edit lands', keeps && t.includes('500 queued'))
    else observed(`naive merge (spike 07 full re-parse): trailing space ${keeps ? 'kept' : 'DELETED → the user’s next word glues on ("leadreads")'}`)
  }

  const browser = await chromium.launch()
  try {
    // ---------------------------------------------------------------- C
    section('C  the 8 tasks per path while the user keeps typing')
    const rows: PathResult[] = []
    for (const p of ['P1 Edit tool on the file', 'P2 CLI ops', 'P3 patch op', 'P4 export → edit → apply'] as PathName[]) {
      const r = await runPath(browser, p)
      rows.push(r)
      check(`${p}: all 8 tasks applied`, r.tasksFailed.length === 0, r.tasksFailed.join('; '))
      check(`${p}: none of the user's ${r.typed} typed sentences lost or mangled`, r.lost.length === 0 && r.typed >= 6, r.lost.join(', '))
      check(`${p}: comment stays anchored, resolved; browser == server`, r.threadOk && r.converged)
    }
    for (const [p, args] of [
      ['P1 Edit tool on the file', ['--naive-merge', '--no-store-guard']],
      ['P3 patch op', ['--naive-merge']],
    ] as [PathName, string[]][]) {
      const r = await runPath(browser, p, args)
      rows.push(r)
      observed(`${r.path}: tasks ${r.tasksOk.length}/8, typed ${r.typed}, lost/mangled ${r.lost.length}${r.lost.length ? ` (${r.lost.join(', ')})` : ''}`)
    }
    console.log('\n  path                                             tasks  typed  lost  retries  chars sent  ext.merges  stores deferred')
    for (const r of rows)
      console.log(`  ${r.path.padEnd(48)} ${String(r.tasksOk.length).padStart(3)}/8 ${String(r.typed).padStart(6)} ${String(r.lost.length).padStart(5)} ${String(r.retries).padStart(8)} ${String(r.sentChars).padStart(11)} ${String(r.health.externalMerges).padStart(11)} ${String(r.health.storesDeferredForExternalEdit).padStart(16)}`)
    fs.writeFileSync(path.join(root, 'verify', 'last-comparison.json'), JSON.stringify(rows.map((r) => ({ ...r, health: { externalMerges: r.health.externalMerges, stores: r.health.stores, storesDeferredForExternalEdit: r.health.storesDeferredForExternalEdit } })), null, 2))

    // ---------------------------------------------------------------- D
    section('D  P1 store race: store inside the watcher’s settle window')
    for (const guard of [false, true]) {
      const doc = tmpDoc()
      const srv = await startServer(doc, 0, guard ? [] : ['--no-store-guard'])
      try {
        const page = await openUser(browser, srv.url)
        let lost = 0
        for (let i = 0; i < 3; i++) {
          await caretAtEnd(page, 'Full-document sync')
          await page.keyboard.type(` r${i}`, { delay: 20 }) // the user types → Hocuspocus schedules a store
          const f = fs.readFileSync(doc, 'utf8')
          fs.writeFileSync(doc, f.replace('Web client support', `Web client support (race ${i})`)) // the agent's Edit
          await fetch(`${srv.url}/doc/flush`, { method: 'POST' }) // a store lands before the 150 ms settle is over
          await sleep(1200)
          if (!(await liveText(srv.url)).includes(`(race ${i})`)) lost++
        }
        const h = await getJson(`${srv.url}/health`)
        if (guard) check('store guard: no agent file edit lost (store deferred, watcher merges, store re-runs)', lost === 0, `deferred ${h.storesDeferredForExternalEdit}`)
        else observed(`without the store guard (spike 07): ${lost}/3 agent file edits silently overwritten by the server's own store`)
        if (!guard) check('race reproduced without the guard (the agent edit is overwritten)', lost > 0, `${lost}/3`)
        await page.close()
      } finally {
        await srv.stop()
      }
    }

    // ---------------------------------------------------------------- E
    section('E  caret: insert a block before the caret’s block AND change text in it, in one update')
    const smart = await caretStructural(['P2 op insert-after', 'P3 patch', 'P1 file edit'], [true])
    for (const r of smart) check(`${r.path} / ${r.scenario}: the user's typing stays in their item`, r.ok, `…${r.item.slice(-24)} | new: ${r.newItem}`)
    const naive = await caretStructural(['P3 patch'], [true], ['both'], ['--naive-merge'])
    check('naive (one-pass) merge reproduces the jump: typing lands in the agent’s new item', !naive[0].ok, `new: ${naive[0].newItem}`)

    // ---------------------------------------------------------------- F
    section('F  patch errors as the agent sees them (CLI)')
    {
      const doc = tmpDoc()
      const srv = await startServer(doc)
      try {
        const page = await openUser(browser, srv.url)
        // stale: the agent read the doc, then the user typed inside the sentence the agent wants to change
        const before = (await getJson(`${srv.url}/agent/read`)).html as string
        check('read: canonical html of the live doc', before.includes('Sync completes within <strong>10&nbsp;s</strong> of reconnecting'))
        await page.evaluate(() => {
          const ed = (window as any).__editor
          let pos = -1
          ed.state.doc.descendants((n: any, p: number) => {
            if (pos < 0 && n.isText && n.text.includes('of reconnecting')) pos = p + n.text.indexOf('of reconnecting') + 'of reconnecting'.length
          })
          ed.commands.setTextSelection(pos)
          ed.view.focus()
        })
        await page.keyboard.type(' (median)', { delay: 30 })
        await sleep(300)
        let r = await cli(srv.url, ['patch'], block('of reconnecting for a typical day', 'of reconnecting for a full day'))
        check('stale old string → exit 1, NOT_FOUND, closest block shows the user’s new text', r.code === 1 && r.json?.code === 'NOT_FOUND' && norm(r.stdout).includes('of reconnecting (median) for a typical day'), r.stdout.split('\n')[0].slice(0, 120))
        r = await cli(srv.url, ['patch'], block('of reconnecting (median) for a typical day', 'of reconnecting (median) for a full day'))
        check('retry with old copied from "closest" → applied; the caret warning names the user', r.code === 0 && r.json?.warnings?.[0]?.includes('Noah'), JSON.stringify(r.json?.warnings))
        r = await cli(srv.url, ['patch'], block('outbox', 'send queue'))
        check('ambiguous old string → AMBIGUOUS with line numbers', r.code === 1 && r.json?.code === 'AMBIGUOUS' && /matches \d+ times \(lines /.test(r.json?.error ?? ''), r.json?.error?.slice(0, 90))
        r = await cli(srv.url, ['patch', '--avoid-caret'], block('(median) for a full day', '(p50) for a full day'))
        check('--avoid-caret on the block the user is typing in → exit 5 USER_IN_BLOCK', r.code === 5 && r.json?.code === 'USER_IN_BLOCK' && r.json?.error.includes('Noah'), r.json?.error?.slice(0, 80))
        const t0 = await liveText(srv.url)
        r = await cli(srv.url, ['patch', '--dry-run'], block('Real-time collaboration', 'Live collaboration'))
        check('--dry-run reports the touched blocks and changes nothing', r.code === 0 && r.json?.dryRun && (await liveText(srv.url)) === t0)
        // suggestion mode
        r = await cli(srv.url, ['patch', '--propose', '--message', 'Shorter?'], block('Real-time collaboration between technicians.', 'Live co-editing between technicians.'))
        const proposed = r.json?.proposed as string
        check('--propose creates a change thread instead of editing', r.code === 0 && !!proposed && !(await liveText(srv.url)).includes('Live co-editing'))
        const card = page.getByTestId(`thread-${proposed}`)
        await card.waitFor({ timeout: 4000 })
        await card.scrollIntoViewIfNeeded()
        await sleep(300)
        await page.screenshot({ path: path.join(root, 'screenshot-proposal.png'), clip: { x: 300, y: Math.max(0, ((await card.boundingBox())?.y ?? 0) - 200), width: 1100, height: 420 } })
        await card.getByTestId('proposal-accept').click()
        await sleep(600)
        const threads = (await getJson(`${srv.url}/api/threads?all=1`)).threads as any[]
        check('user clicks "Accept change" → the patch is applied live, the thread is resolved', (await liveText(srv.url)).includes('Live co-editing between technicians.') && threads.find((t) => t.thread === proposed)?.status === 'resolved')
        await page.close()
      } finally {
        await srv.stop()
      }
    }

    // ---------------------------------------------------------------- G
    section('G  moving a section while the user types inside it')
    for (const p of ['P3 patch op', 'P2 CLI ops'] as const) {
      const doc = tmpDoc()
      const srv = await startServer(doc)
      try {
        const page = await openUser(browser, srv.url)
        await caretAtEnd(page, 'We merge at')
        const typing = page.keyboard.type(' Typed during the move.', { delay: 80 })
        await sleep(700)
        if (p === 'P3 patch op') {
          const h = (await getJson(`${srv.url}/agent/read`)).html as string
          const edits = TASKS[6].edits(h)
          await cli(srv.url, ['patch'], edits.map((e) => block(e.old, e.new)).join(''))
        } else await postJson(`${srv.url}/agent/op`, { op: TASKS[6].ops[0] })
        await typing
        await sleep(600)
        const t = await liveText(srv.url)
        const ok = t.includes('overlapping edits. Typed during the move.')
        if (p === 'P3 patch op') check('P3: the section with the caret keeps its identity (the other one is re-created) → typing intact', ok, t.split('\n').find((l) => l.includes('We merge'))?.slice(-50))
        else observed(`P2 move-section re-creates the moved section: typing inside it ${ok ? 'kept' : `LOST/mangled → "${t.split('\n').find((l) => l.includes('We merge'))?.slice(-45)}"`}`)
        await page.close()
      } finally {
        await srv.stop()
      }
    }

    // ---------------------------------------------------------------- H
    section('H  reading the live document')
    {
      const doc = tmpDoc()
      const srv = await startServer(doc, 0, ['--debounce', '2000'])
      try {
        const page = await openUser(browser, srv.url)
        await caretAtEnd(page, 'Full-document sync')
        await page.keyboard.type(' FRESHNESS', { delay: 20 })
        const t0 = Date.now()
        const fresh = (await cli(srv.url, ['read'])).stdout.includes('FRESHNESS')
        let lag = -1
        while (Date.now() - t0 < 10000) {
          if (fs.readFileSync(doc, 'utf8').includes('FRESHNESS')) {
            lag = Date.now() - t0
            break
          }
          await sleep(50)
        }
        check('`collab read` already contains what the user typed a moment ago', fresh)
        observed(`the file on disk caught up ${lag} ms later (store debounce 2000 ms in this test; 800 ms / max 3.2 s by default)`)
        const ol = (await cli(srv.url, ['read', '--outline'])).stdout
        check('read --outline marks the block the user is typing in (✎ Noah) and lists block ids + lines', /details\s+\w{6}.*✎ Noah/.test(ol) && /^\s+\d+\s+h2\s+\w{6}\s+#api/m.test(ol), ol.split('\n').find((l) => l.includes('✎')))
        const sec = (await cli(srv.url, ['read', '--section', '3. API', '-n'])).stdout
        check('read --section "3. API" -n: only that section, with file line numbers', sec.includes('3. API') && sec.includes('Retry with exponential backoff') && !sec.includes('Conflict handling</h2>') && /^\s+\d+\t<h2/m.test(sec))
        await page.close()
      } finally {
        await srv.stop()
      }
    }
  } finally {
    await browser.close()
  }

  console.log(`\n${passes} passed, ${failures} failed`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
