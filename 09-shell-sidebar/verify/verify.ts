// npm run verify — spike 09: the configurable shell around the editor. Exits 0 when every check passes.
//
//   A  parser (unit): the demo journal, the brainstorm template's sectioned layout, wrapped lines, rejected approaches
//   B  load a config with journal + outline (left) and comments + activity + html mockup (right): header, tabs,
//      journal entries + filters, references in the spec decorated, click a reference → the entry, sandboxed html panel
//   C  live journal: append an entry on disk → it appears (latency measured), flashes, is scrolled into view, shows in
//      the activity log; a status change; an append while the tab is hidden → "+1" badge
//   D  the agent changes the shell: `collab panel add` (live), markdown file panel live reload, `panel open --entry`,
//      `panel set --side`, `panel remove`, a hand edit of the config file, an invalid config (error, last good kept)
//   E  layout: collapse/expand, drag-resize, persisted across reload, `collab layout` (agent wins)
//   F  editor + collaboration smoke: typing reaches the server and a second browser, `collab patch` reaches the browser,
//      an agent comment shows in the comments tab aligned with its anchor
//   G  journal comment → `journal_comment` event for the agent (`collab peek`)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { root, startServer, type ServerHandle } from '../lib/serverProc.ts'
import { parseJournal } from '../src/shell/journal.ts'
import { SCRIPT } from '../demo/journal-demo.ts'

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

/** poll until fn() is truthy; returns ms waited or -1 */
async function until(fn: () => Promise<unknown> | unknown, timeout = 5000, every = 25): Promise<number> {
  const t0 = performance.now()
  while (performance.now() - t0 < timeout) {
    if (await fn()) return Math.round(performance.now() - t0)
    await sleep(every)
  }
  return -1
}

const tabs = (page: Page, side: string) => page.$$eval(`[data-testid="sidebar-${side}"] .sb-tab`, (els) => els.map((e) => e.getAttribute('data-testid')!.slice(4)))
const activeTab = (page: Page, side: string) => page.$eval(`[data-testid="sidebar-${side}"]`, (el) => el.querySelector('.sb-tab.on')?.getAttribute('data-testid')?.slice(4) ?? null).catch(() => null)
/** element fully inside its scrolling panel box (and the box visible) */
const visibleInBox = (page: Page, sel: string) =>
  page.evaluate((s) => {
    const el = document.querySelector<HTMLElement>(s)
    const box = el?.closest<HTMLElement>('.sb-box')
    if (!el || !box || box.offsetParent === null) return false
    const a = el.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    return a.top >= b.top - 1 && a.top < b.bottom - 20
  }, sel)

// ---------------------------------------------------------------- A: parser
function unitParser() {
  section('A  journal parser (unit)')
  const demo = parseJournal(fs.readFileSync(path.join(root, 'demo/decisions.md'), 'utf8'))
  const by = (t: string) => demo.entries.filter((e) => e.type === t).length
  check('demo journal: 7 facts, 5 decisions, 3 questions, 3 rejected approaches', by('fact') === 7 && by('decision') === 5 && by('question') === 3 && by('rejected') === 3, JSON.stringify({ f: by('fact'), d: by('decision'), q: by('question'), r: by('rejected') }))
  const e = (id: string) => demo.entries.find((x) => x.id === id)!
  check('statuses: F-5 refuted, D-4 superseded (superseded-by D-5), Q-2 resolved, D-1 accepted', e('F-5').status === 'refuted' && e('D-4').status === 'superseded' && e('D-4').statusText === 'superseded-by D-5' && e('Q-2').status === 'resolved' && e('D-1').status === 'accepted')
  check('decision summary = bold part; continuation lines (Evaluated/Rejected/Chosen) belong to the entry', e('D-1').summary.startsWith('Every save goes into a durable') && e('D-1').body.includes('Chosen because'))
  check('refs extracted (D-5 → D-4, F-4 …), self excluded', e('D-5').refs.includes('D-4') && !e('D-5').refs.includes('D-5'))
  check('the template’s HTML comments are not entries (no F-3 at line < 20)', demo.entries.every((x) => x.line > 20))
  check('rejected approaches get ids R-1..R-3 with the bold name as summary', e('R-1').summary === 'Full-document sync on reconnect')
  const tmpl = parseJournal(`# Decision Journal — X

## Established Facts
F-1: [verified] One. (Source: a)
F-2: [assumed] Two wraps
  onto a second line. (Source: b)

## Decisions & Rationale
D-1: [accepted] **Pick A.**
- Evaluated: A, B
- Chosen because: F-1

## Rejected Approaches
- **B**: slow (F-2)
  needs a rewrite to reconsider

## Open Questions / Assumptions
Q-1: [assumption] Is A fast?
- Current assumption: yes
- Impact if wrong: rewrite
`)
  const t = (id: string) => tmpl.entries.find((x) => x.id === id)
  check('template layout (one section per type, unindented bullets): F-1, F-2, D-1, R-1, Q-1', ['F-1', 'F-2', 'D-1', 'R-1', 'Q-1'].every((id) => t(id)) && tmpl.entries.length === 5, tmpl.entries.map((x) => x.id).join(','))
  check('template: D-1 keeps its bullets, a wrapped fact keeps its second line, R-1 its continuation', t('D-1')!.body.includes('Chosen because') && t('F-2')!.summary.includes('second line') && t('R-1')!.body.includes('reconsider'))
}

// ---------------------------------------------------------------- setup
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike09-'))
  fs.copyFileSync(path.join(root, 'demo/spec.html'), path.join(dir, 'spec.html'))
  fs.copyFileSync(path.join(root, 'demo/decisions.md'), path.join(dir, 'decisions.md'))
  fs.copyFileSync(path.join(root, 'demo/banner-mockup.html'), path.join(dir, 'banner-mockup.html'))
  fs.mkdirSync(path.join(dir, '.collab'))
  const config = {
    version: 1,
    title: 'verify session',
    layout: { left: { width: 360, active: 'journal' }, right: { width: 340, active: 'comments' } },
    panels: [
      { id: 'journal', type: 'file', title: 'Journal', path: 'decisions.md', render: 'journal', side: 'left' },
      { id: 'outline', type: 'outline', side: 'left' },
      { id: 'comments', type: 'comments', side: 'right' },
      { id: 'activity', type: 'activity', side: 'right' },
      { id: 'mockup', type: 'file', title: 'Mockup', path: 'banner-mockup.html', side: 'right' },
    ],
  }
  const configPath = path.join(dir, '.collab', 'spec.html.shell.json')
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  return { dir, doc: path.join(dir, 'spec.html'), journal: path.join(dir, 'decisions.md'), configPath, config }
}

function appendEntry(file: string, text: string) {
  const s = fs.readFileSync(file, 'utf8')
  const at = s.search(/^## Rejected Approaches/m)
  fs.writeFileSync(file, `${s.slice(0, at).trimEnd()}\n\n${text}\n\n${s.slice(at)}`)
}

async function openPage(browser: Browser, url: string, user = 'Noah', ctx?: { storage?: boolean }) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await context.newPage()
  // (Vite's client still tries its HMR socket under --no-hmr: "WebSocket closed without opened." — not ours)
  page.on('pageerror', (e) => !e.message.includes('WebSocket closed without opened') && console.log(`  [pageerror ${user}] ${e.message}`))
  await page.goto(`${url}/?user=${user}`)
  await page.waitForFunction(() => (window as any).__editor && (window as any).__provider?.synced && (window as any).__shell?.config, null, { timeout: 30000 })
  await page.waitForSelector('[data-entry="D-1"]', { timeout: 10000 })
  await sleep(300)
  void ctx
  return page
}

// ---------------------------------------------------------------- B–G: browser
async function browserChecks(browser: Browser) {
  const proj = makeProject()
  let srv: ServerHandle | null = null
  try {
    srv = await startServer(proj.doc)
    const url = srv.url
    const page = await openPage(browser, url)

    section('B  load the shell from the config')
    check('header: doc title + config title', (await page.textContent('[data-testid="doc-title"]'))?.trim() === 'Spec: Offline sync for field notes' && (await page.textContent('[data-testid="shell-title"]'))?.trim() === 'verify session')
    const lt = await tabs(page, 'left')
    const rt = await tabs(page, 'right')
    check('left tabs = journal, outline; right tabs = comments, activity, mockup (config order)', lt.join() === 'journal,outline' && rt.join() === 'comments,activity,mockup', `${lt} | ${rt}`)
    check('default open tabs from layout.active: journal / comments', (await activeTab(page, 'left')) === 'journal' && (await activeTab(page, 'right')) === 'comments')
    const n = await page.$$eval('[data-entry]', (els) => els.length)
    check('journal renders every entry (18)', n === 18, `${n}`)
    await page.click('[data-testid="jf-decision"]')
    const onlyD = await page.$$eval('[data-entry]', (els) => els.map((e) => e.getAttribute('data-entry')!))
    check('filter "Decisions" shows only D-n entries (5)', onlyD.length === 5 && onlyD.every((id) => id.startsWith('D-')), onlyD.join(','))
    await page.fill('[data-testid="jv-search"]', 'CRDT')
    const searched = await page.$$eval('[data-entry]', (els) => els.map((e) => e.getAttribute('data-entry')!))
    check('search within the filter: "CRDT" among decisions → D-5', searched.join() === 'D-5', searched.join())
    await page.fill('[data-testid="jv-search"]', '')
    await page.click('[data-testid="jf-all"]')
    const refs = await page.$$eval('.tiptap .jref', (els) => els.map((e) => e.getAttribute('data-jref')))
    check('references in the spec are decorated (text "D-3", "F-3", link journal#D-5)', ['Q-1', 'F-3', 'Q-3', 'D-2', 'D-3', 'D-5', 'F-6', 'R-1'].every((id) => refs.includes(id)), refs.join(','))
    const savedHtml = fs.readFileSync(proj.doc, 'utf8')
    check('decorations are not in the document (no "jref" in the HTML file)', !savedHtml.includes('jref'))
    // click a reference in the spec → the journal scrolls to the entry and flashes it
    await page.click('[data-testid="tab-outline"]')
    await page.locator('.tiptap .jref[data-jref="D-3"]').first().click()
    const jumped = await until(async () => (await activeTab(page, 'left')) === 'journal' && (await visibleInBox(page, '[data-entry="D-3"]')), 3000)
    const flashed = await page.$eval('[data-entry="D-3"]', (el) => el.classList.contains('flash'))
    check('click on "D-3" in the spec → journal tab opens, D-3 scrolled into view and highlighted', jumped >= 0 && flashed, `${jumped} ms`)
    const title = await page.getAttribute('.tiptap .jref[data-jref="D-3"]', 'title')
    check('hover on a reference shows the entry summary', !!title?.includes('client-generated id'), title ?? '')
    await page.click('[data-testid="tab-mockup"]')
    const frame = page.frameLocator('[data-testid="panel-mockup"] iframe')
    await frame.locator('h1').waitFor({ timeout: 5000 })
    const sandbox = await page.getAttribute('[data-testid="panel-mockup"] iframe', 'sandbox')
    const scriptRan = await frame.locator('#script-ran').count()
    check('html file panel renders in a sandboxed iframe (sandbox="", its <script> did not run)', sandbox === '' && scriptRan === 0 && (await frame.locator('h1').textContent())!.includes('Conflict banner'))
    await page.click('[data-testid="tab-comments"]')

    section('C  live journal (file changed on disk)')
    await page.click('[data-testid="tab-journal"]')
    await page.$eval('[data-testid="panel-journal"]', (el) => el.scrollTo(0, 0))
    const t0 = performance.now()
    appendEntry(proj.journal, SCRIPT[0].text) // F-8
    const ms = await until(() => page.$('[data-entry="F-8"]'), 5000, 10)
    const appearMs = ms >= 0 ? Math.round(performance.now() - t0) : -1
    check('appended entry F-8 appears in the browser within 1 s', appearMs >= 0 && appearMs < 1000, `${appearMs} ms`)
    observed(`append → visible: ${appearMs} ms (fs.watch on the directory + 40 ms coalescing + SSE + fetch + parse)`)
    await sleep(700) // smooth scroll
    check('…flashes and is scrolled into view inside the journal panel', (await page.$eval('[data-entry="F-8"]', (el) => el.classList.contains('flash'))) && (await visibleInBox(page, '[data-entry="F-8"]')))
    await page.click('[data-testid="tab-activity"]')
    const act = await until(async () => (await page.textContent('[data-testid="activity"]'))?.includes('+F-8'), 2000)
    check('activity panel logs "decisions.md: +F-8 …"', act >= 0)
    // a status change in place (Q-3 gets resolved)
    fs.writeFileSync(proj.journal, fs.readFileSync(proj.journal, 'utf8').replace('    - Impact if wrong: the 10 s goal in §1 must be stated per number of notes.', '    - Impact if wrong: the 10 s goal in §1 must be stated per number of notes.\n    - Resolved: yes, confirmed by the ops lead (F-3).'))
    const st = await until(async () => (await page.textContent('[data-entry="Q-3"] .je-status').catch(() => ''))?.trim() === 'assumption' && (await page.$eval('[data-entry="Q-3"]', (el) => el.classList.contains('s-resolved'))), 2000)
    check('an edited entry (Q-3 "- Resolved: …") updates live → resolved', st >= 0, `${st} ms`)
    // append while the journal tab is hidden
    await page.click('[data-testid="tab-outline"]')
    appendEntry(proj.journal, SCRIPT[1].text) // D-6
    const badge = await until(async () => (await page.textContent('[data-testid="badge-journal"]').catch(() => ''))?.trim() === '+1', 2000)
    check('append while the journal tab is hidden → "+1" badge on the tab, no tab switch', badge >= 0 && (await activeTab(page, 'left')) === 'outline')
    await page.click('[data-testid="tab-journal"]')
    await sleep(400)
    check('opening the tab reveals the new entry D-6 (scrolled into view, badge gone)', (await visibleInBox(page, '[data-entry="D-6"]')) && !(await page.$('[data-testid="badge-journal"]')))

    section('D  the agent changes the shell')
    fs.writeFileSync(path.join(proj.dir, 'notes.md'), '# Session notes\n\n- Talked to the ops lead about LWW.\n')
    const tAdd = performance.now()
    const add = await cli(url, ['panel', 'add', 'file', '--path', 'notes.md', '--title', 'Notes', '--side', 'right', '--open'])
    const addMs = await until(async () => (await activeTab(page, 'right')) === 'notes', 3000, 10)
    check('`collab panel add file --path notes.md --side right --open` → tab appears and opens live', add.code === 0 && addMs >= 0 && (await tabs(page, 'right')).join() === 'comments,activity,mockup,notes', `${Math.round(performance.now() - tAdd)} ms incl. CLI start; ${add.stdout.trim().slice(0, 120)}`)
    check('…markdown rendered', (await page.textContent('[data-testid="panel-notes"] .md h1').catch(() => ''))?.trim() === 'Session notes')
    check('…config file written (agent change is persistent)', JSON.parse(fs.readFileSync(proj.configPath, 'utf8')).panels.some((p: any) => p.id === 'notes'))
    fs.appendFileSync(path.join(proj.dir, 'notes.md'), '\nDecided: paragraph merge (D-5).\n')
    const mdLive = await until(async () => (await page.$$('[data-testid="panel-notes"] .md > p.flash')).length > 0, 2000)
    check('markdown panel: appended paragraph appears and flashes; "D-5" in it is a journal link', mdLive >= 0 && (await page.$$('[data-testid="panel-notes"] a.jref[data-ref="D-5"]')).length === 1, `${mdLive} ms`)
    const bad = await cli(url, ['panel', 'add', 'file'])
    check('`panel add file` without --path → error with the reason, exit ≠ 0', bad.code !== 0 && bad.stdout.includes('path'), bad.stdout.trim().slice(0, 140))
    await page.click('[data-testid="tab-outline"]')
    const open = await cli(url, ['panel', 'open', 'journal', '--entry', 'D-1'])
    const openMs = await until(async () => (await activeTab(page, 'left')) === 'journal' && (await visibleInBox(page, '[data-entry="D-1"]')), 3000)
    check('`collab panel open journal --entry D-1` → journal tab, D-1 in view', open.code === 0 && openMs >= 0, `${openMs} ms`)
    const mv = await cli(url, ['panel', 'set', 'outline', '--side', 'right', '--index', '1'])
    const mvMs = await until(async () => (await tabs(page, 'right')).join() === 'comments,outline,activity,mockup,notes' && (await tabs(page, 'left')).join() === 'journal', 3000)
    check('`collab panel set outline --side right --index 1` → tab moves live', mv.code === 0 && mvMs >= 0, (await tabs(page, 'right')).join())
    const rm = await cli(url, ['panel', 'remove', 'notes'])
    const rmMs = await until(async () => !(await tabs(page, 'right')).includes('notes'), 3000)
    check('`collab panel remove notes` → tab gone', rm.code === 0 && rmMs >= 0)
    const sh = await cli(url, ['shell'])
    check('`collab shell` lists the panels per side', sh.code === 0 && /left[^\n]*:[\s\S]*journal[\s\S]*right[^\n]*:[\s\S]*outline/.test(sh.stdout))
    const ifr = await cli(url, ['panel', 'add', 'iframe', '--url', `${url}/health`, '--title', 'Health', '--side', 'left', '--open'])
    const ifMs = await until(async () => (await page.getAttribute('[data-testid="panel-iframe"] iframe', 'src').catch(() => null)) === `${url}/health`, 3000)
    const ifSandbox = await page.getAttribute('[data-testid="panel-iframe"] iframe', 'sandbox').catch(() => null)
    check('`collab panel add iframe --url …` → iframe panel (sandboxed, no same-origin)', ifr.code === 0 && ifMs >= 0 && !!ifSandbox && !ifSandbox.includes('allow-same-origin'), ifSandbox ?? '')
    await cli(url, ['panel', 'remove', 'iframe'])
    await until(async () => (await tabs(page, 'left')).join() === 'journal', 3000)
    // hand edit of the config file (e.g. the agent's Edit tool)
    const cfg = JSON.parse(fs.readFileSync(proj.configPath, 'utf8'))
    cfg.title = 'edited by hand'
    fs.writeFileSync(proj.configPath, JSON.stringify(cfg, null, 2))
    const hand = await until(async () => (await page.textContent('[data-testid="shell-title"]'))?.trim() === 'edited by hand', 3000)
    check('editing the config file on disk → header updates live', hand >= 0, `${hand} ms`)
    fs.writeFileSync(proj.configPath, JSON.stringify({ ...cfg, panels: [...cfg.panels, { type: 'file', id: 'x' }] }))
    const err = await until(() => page.$('[data-testid="config-error"]'), 3000)
    check('invalid config on disk → error badge, last good config stays', err >= 0 && (await tabs(page, 'left')).join() === 'journal', (await page.getAttribute('[data-testid="config-error"]', 'title').catch(() => '')) ?? '')
    fs.writeFileSync(proj.configPath, JSON.stringify(cfg, null, 2) + ' ')
    const fixed = await until(async () => !(await page.$('[data-testid="config-error"]')), 3000)
    check('…fixed config → error gone', fixed >= 0)

    section('E  layout: collapse, resize, persistence')
    const pageX = () => page.$eval('.page .tiptap', (el) => Math.round(el.getBoundingClientRect().width))
    const w0 = await pageX()
    await page.click('[data-testid="sb-collapse-left"]')
    await sleep(150)
    const leftW = await page.$eval('[data-testid="sidebar-left"]', (el) => Math.round(el.getBoundingClientRect().width))
    const w1 = await pageX()
    check('collapse left → 44 px rail, editor gets the space', leftW === 44 && w1 >= w0, `rail ${leftW}px, editor ${w0}→${w1}px`)
    await page.click('[data-testid="rail-journal"]')
    await sleep(150)
    const leftW2 = await page.$eval('[data-testid="sidebar-left"]', (el) => Math.round(el.getBoundingClientRect().width))
    check('click a tab icon in the rail → expands with that tab', leftW2 === 360 && (await activeTab(page, 'left')) === 'journal', `${leftW2}px`)
    const h = await page.$('[data-testid="sb-resize-right"]')
    const hb = (await h!.boundingBox())!
    await page.mouse.move(hb.x + 3, 400)
    await page.mouse.down()
    await page.mouse.move(hb.x - 60, 400, { steps: 5 })
    await page.mouse.move(hb.x - 117, 400, { steps: 5 })
    await page.mouse.up()
    const rw = await page.$eval('[data-testid="sidebar-right"]', (el) => Math.round(el.getBoundingClientRect().width))
    check('drag the right sidebar edge 120 px left → 460 px', Math.abs(rw - 460) <= 4, `${rw}px`)
    await page.click('[data-testid="hdr-left"]') // header toggle collapses left
    await page.reload()
    await page.waitForFunction(() => (window as any).__shell?.config && (window as any).__editor)
    await sleep(500)
    const after = await page.evaluate(() => ({
      left: document.querySelector('[data-testid="sidebar-left"]')?.getAttribute('data-collapsed'),
      right: Math.round(document.querySelector('[data-testid="sidebar-right"]')!.getBoundingClientRect().width),
    }))
    check('reload keeps the viewer’s layout (left collapsed, right 460 px — localStorage, not the shared config)', after.left === 'true' && Math.abs(after.right - 460) <= 4, JSON.stringify(after))
    const lay = await cli(url, ['layout', 'left', '--collapsed', 'false', '--active', 'journal'])
    const layMs = await until(async () => (await page.getAttribute('[data-testid="sidebar-left"]', 'data-collapsed')) === 'false', 3000)
    check('`collab layout left --collapsed false` → expands in the browser (an explicit agent change beats the viewer pref)', lay.code === 0 && layMs >= 0, `${layMs} ms`)

    section('F  editor + collaboration smoke')
    const page2 = await openPage(browser, url, 'Jonas')
    await page.locator('.tiptap p', { hasText: 'Field technicians lose connectivity' }).first().click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Typed in the shell.', { delay: 15 })
    const typed2 = await until(async () => (await page2.textContent('.tiptap'))?.includes('Typed in the shell.'), 4000)
    const st2 = await until(async () => ((await (await fetch(`${url}/doc/state`)).json()) as { text: string }).text.includes('Typed in the shell.'), 4000)
    check('typing in the editor reaches the server and a second browser', typed2 >= 0 && st2 >= 0, `browser B ${typed2} ms`)
    const patch = await cli(url, ['patch'], '<<<<<<< SEARCH\nRetry with exponential backoff\n=======\nRetry with exponential backoff (max 5 min)\n>>>>>>> REPLACE\n')
    const pMs = await until(async () => (await page.textContent('.tiptap'))?.includes('(max 5 min)'), 4000)
    check('`collab patch` lands live in the browser', patch.code === 0 && pMs >= 0, `${pMs} ms`)
    const cm = await cli(url, ['comment', 'mark overlapping edits', 'Do we show both versions side by side?'])
    await page.click('[data-testid="tab-activity"]')
    const hl = page.locator('.tiptap .cmt').first()
    await hl.waitFor({ timeout: 4000 })
    await hl.scrollIntoViewIfNeeded()
    await hl.click()
    const cmtTab = await until(async () => (await activeTab(page, 'right')) === 'comments', 2000)
    const thread = cm.json?.thread as string
    await page.waitForSelector(`[data-card="${thread}"]`, { timeout: 4000 })
    await sleep(400)
    const align = await page.evaluate((id) => {
      const card = document.querySelector(`[data-card="${id}"]`)!.getBoundingClientRect().top
      const mark = document.querySelector('.tiptap .cmt')!.getBoundingClientRect().top
      return Math.round(card - mark)
    }, thread)
    check('agent comment: clicking its highlight switches the right sidebar to Comments; card aligned with the anchor', cm.code === 0 && cmtTab >= 0 && Math.abs(align) <= 40, `card − anchor = ${align}px`)
    await page2.context().close()

    section('G  journal comment → agent event')
    await cli(url, ['peek', '--ack'])
    await page.hover('[data-entry="D-5"]')
    await page.click('[data-testid="entry-comment-D-5"]')
    await page.fill('[data-testid="entry-comment-text"]', 'Does this also cover checklists?')
    await page.click('[data-testid="entry-comment-send"]')
    await page.waitForSelector('[data-entry="D-5"] .je-sent', { timeout: 3000 })
    const peek = await cli(url, ['peek'])
    const ev = (peek.json?.events ?? []).find((e: any) => e.type === 'journal_comment')
    check('comment on journal entry D-5 → `journal_comment` event (entry, text, file, by) for `collab wait/peek`', !!ev && ev.entry === 'D-5' && ev.text === 'Does this also cover checklists?' && ev.file === 'decisions.md' && ev.by === 'Noah', JSON.stringify(ev ?? peek.json).slice(0, 160))
    await page.context().close()
  } finally {
    await srv?.stop()
    fs.rmSync(proj.dir, { recursive: true, force: true })
  }
}

const t0 = Date.now()
unitParser()
const browser = await chromium.launch()
try {
  await browserChecks(browser)
} catch (e) {
  check('browser checks ran to the end', false, String((e as Error).stack ?? e).slice(0, 600))
} finally {
  await browser.close()
}
console.log(`\n${passes} passed, ${failures} failed (${Math.round((Date.now() - t0) / 1000)} s)`)
process.exit(failures ? 1 : 0)
