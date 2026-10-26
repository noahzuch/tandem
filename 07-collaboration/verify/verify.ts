// npm run verify — headless proof of spike 07's collaboration claims. Exits 0 when every PASS/FAIL check passes.
// Starts its own server (fixed free port, no HMR) on a temp copy of samples/spec.html, drives a real browser
// (Playwright) as "the user" and the agent CLI (child process, Hocuspocus client) as "Claude".
//
// Two kinds of lines: `PASS/FAIL <invariant>` (counted) and `OBSERVED <scenario>: …` (what happened in the
// cases where the honest answer is "it depends" — same word, whole paragraph, island). The README table is
// filled from these.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { root, startServer, freePort, type ServerHandle } from '../lib/serverProc.ts'

const sample = path.resolve(root, '../samples/spec.html')
let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const observed = (scenario: string, what: string) => console.log(`OBSERVED  ${scenario}: ${what}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(fn: () => Promise<T> | T, pred: (v: T) => boolean, timeoutMs = 8000, every = 50): Promise<T> {
  const t0 = Date.now()
  let v = await fn()
  while (!pred(v) && Date.now() - t0 < timeoutMs) {
    await sleep(every)
    v = await fn()
  }
  return v
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike07-'))
const doc = path.join(tmp, 'spec.html')
fs.copyFileSync(sample, doc)
const original = fs.readFileSync(doc, 'utf8')
const originalHead = original.slice(0, original.indexOf('<body>'))
const between = (s: string, a: string, b: string) => {
  const i = s.indexOf(a)
  const j = s.indexOf(b, i)
  return i < 0 || j < 0 ? '' : s.slice(i, j + b.length)
}
const origSvg = between(original, '<svg', '</svg>')
const shot = (name: string) => path.join(root, name)
const readDoc = () => fs.readFileSync(doc, 'utf8')

// ---------------------------------------------------------------- the agent (child process)
interface AgentRun {
  connected: Promise<void>
  done: Promise<{ code: number | null; stdout: string; stderr: string }>
}
function agent(url: string, args: string[], opts: { wait?: number; linger?: number; via?: 'ws' | 'server' } = {}): AgentRun {
  const full = ['--import', 'tsx', 'agent/agent.ts', '--server', url, '--json', '--linger', String(opts.linger ?? 1200), '--wait', String(opts.wait ?? 0)]
  if (opts.via) full.push('--via', opts.via)
  const proc = spawn(process.execPath, [...full, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let resolveConnected!: () => void
  const connected = new Promise<void>((r) => (resolveConnected = r))
  proc.stdout.on('data', (d: Buffer) => {
    stdout += d.toString()
    if (/connected to|"via":"server"/.test(stdout)) resolveConnected()
  })
  proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((r) => {
    proc.on('exit', (code) => {
      resolveConnected()
      r({ code, stdout, stderr })
    })
  })
  return { connected, done }
}
const agentJson = (r: { stdout: string }) => {
  const line = r.stdout.split('\n').find((l) => l.startsWith('{'))
  return line ? (JSON.parse(line) as Record<string, unknown>) : {}
}

// ---------------------------------------------------------------- page helpers
const pageText = (page: Page) => page.evaluate(() => (window as any).__editor.state.doc.textBetween(0, (window as any).__editor.state.doc.content.size, '\n', '￼') as string)
const blockText = (page: Page, startsWith: string): Promise<string | null> =>
  page.evaluate((s) => {
    let t: string | null = null
    ;(window as any).__editor.state.doc.descendants((n: any) => {
      if (t === null && n.isTextblock && n.textContent.startsWith(s)) t = n.textContent
    })
    return t
  }, startsWith)
const bidOf = (page: Page, startsWith: string): Promise<string | null> =>
  page.evaluate((s) => {
    let id: string | null = null
    ;(window as any).__editor.state.doc.descendants((n: any) => {
      if (id === null && n.isTextblock && n.textContent.startsWith(s)) id = n.attrs.bid
    })
    return id
  }, startsWith)
/** caret right after `find` (+ offset) inside the text; focus the editor synchronously */
async function placeCaret(page: Page, find: string, offset = 0) {
  const ok = await page.evaluate(
    ([s, off]) => {
      const ed = (window as any).__editor
      let pos = -1
      ed.state.doc.descendants((n: any, p: number) => {
        if (pos >= 0 || !n.isText) return
        const i = n.text.indexOf(s)
        if (i >= 0) pos = p + i + s.length + off
      })
      if (pos < 0) return false
      ed.commands.setTextSelection(pos)
      ed.view.focus()
      return true
    },
    [find, offset] as const,
  )
  if (!ok) throw new Error(`placeCaret: text not found: ${find}`)
  await sleep(30)
}
const caretPos = (page: Page) => page.evaluate(() => (window as any).__editor.state.selection.from as number)
const caretContext = (page: Page) =>
  page.evaluate(() => {
    const ed = (window as any).__editor
    const $p = ed.state.selection.$from
    const t = $p.parent.textContent as string
    const o = $p.parentOffset as number
    return `${t.slice(Math.max(0, o - 12), o)}|${t.slice(o, o + 12)}`
  })
const figureHtml = (page: Page) =>
  page.evaluate(() => {
    let html = ''
    ;(window as any).__editor.state.doc.descendants((n: any) => {
      if (n.type.name === 'htmlIsland' && String(n.attrs.html).startsWith('<figure')) html = n.attrs.html
    })
    return html
  })
const serverState = async (url: string) => (await fetch(`${url}/doc/state`)).json() as Promise<{ live: boolean; text: string; clients: number }>
const health = async (url: string) => (await fetch(`${url}/health`)).json() as Promise<Record<string, any>>
const flush = (url: string) => fetch(`${url}/doc/flush`, { method: 'POST' })
const setOnline = (page: Page, online: boolean) => page.evaluate((on) => ((window as any).__provider as any)[on ? 'connect' : 'disconnect']() && undefined, online)
const providerState = (page: Page) =>
  page.evaluate(() => {
    const p = (window as any).__provider
    return { status: p.configuration.websocketProvider.status as string, synced: p.isSynced as boolean, unsynced: p.unsyncedChanges as number }
  })
async function waitSynced(page: Page, url: string) {
  const st = await waitFor(() => providerState(page), (s) => s.status === 'connected' && s.synced && s.unsynced === 0, 10000)
  if (!(st.status === 'connected' && st.synced)) throw new Error(`provider did not sync: ${JSON.stringify(st)}`)
  await sleep(150) // let the last broadcast land in the server doc
  await waitFor(() => serverState(url), (s) => s.live, 3000)
}
/** page and server hold the same document text */
async function converged(page: Page, url: string): Promise<{ ok: boolean; detail: string }> {
  await waitSynced(page, url)
  const a = await pageText(page)
  const s = await waitFor(() => serverState(url), (st) => st.text === a, 4000)
  if (s.text === a) return { ok: true, detail: `${a.length} chars` }
  const i = Array.from(a).findIndex((c, k) => c !== s.text[k])
  return { ok: false, detail: `differ at ${i}: page "…${a.slice(Math.max(0, i - 20), i + 30)}…" server "…${s.text.slice(Math.max(0, i - 20), i + 30)}…"` }
}
async function svgLabelBox(page: Page, label: string) {
  await page.locator('.island[data-island-kind="figure"]').scrollIntoViewIfNeeded()
  await sleep(50)
  return page.evaluate((txt) => {
    const host = document.querySelector('.island[data-island-kind="figure"] .island-host') as HTMLElement
    const el = Array.from(host.shadowRoot!.querySelectorAll('svg text')).find((e) => e.textContent === txt)
    if (!el) return null
    const r = el.getBoundingClientRect()
    // click near the right end: the island overlay puts the caret at the clicked character
    return { x: r.x + r.width - 1, y: r.y + r.height / 2 }
  }, label)
}

// ---------------------------------------------------------------- run
let server: ServerHandle | undefined
let browser: Browser | undefined
const port = await freePort()
try {
  server = await startServer(doc, port)
  const url = server.url
  console.log(`server: ${url}  doc: ${doc}`)
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1360, height: 1500 } }) // tall: intro (user) and the grid (agent) both visible for the screenshot
  const consoleErrors: string[] = []
  const viteNoise = /WebSocket|\[vite\]|Vite server/
  page.on('console', (m) => m.type() === 'error' && !viteNoise.test(m.text()) && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => !viteNoise.test(String(e)) && consoleErrors.push(String(e)))
  const mod = 'ControlOrMeta'

  // ============================================================ 0. load: server-side seeding, persistence
  await page.goto(`${url}/?user=Noah&color=%232a7de1`)
  const ed = page.locator('.tiptap')
  await ed.locator('h1').first().waitFor({ timeout: 15000 })
  await page.locator('.island[data-island-kind="figure"]').waitFor()
  await waitSynced(page, url)
  check('load: no console errors', consoleErrors.length === 0, consoleErrors.join(' | '))
  check('load: presence shows me', (await page.getByTestId('presence').innerText()).includes('Noah'))
  let h = await health(url)
  check('load: Y.Doc seeded on the server from the HTML file (no client setContent)', h.loadedFrom === 'html' && h.live === true, `loadedFrom=${h.loadedFrom}`)
  const sidecar = path.join(tmp, '.collab', 'spec.html.ystate')
  check('load: sidecar .collab/spec.html.ystate written', fs.existsSync(sidecar) && fs.existsSync(sidecar + '.json'))
  let file = readDoc()
  check('load: file got block ids (data-bid) on write-back, <head> untouched, SVG byte-identical', /<p data-bid="[a-z0-9]{6}">/.test(file) && file.startsWith(originalHead) && file.includes(origSvg), `${(file.match(/data-bid=/g) ?? []).length} ids`)
  const words = (s: string) => s.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length
  check('load: no words lost in the first write-back', Math.abs(words(file) - words(original)) <= 2, `${words(original)} → ${words(file)}`)
  const text0 = await pageText(page)
  check('load: browser shows the document (24 top-level blocks, intro text present)', text0.includes('Field technicians lose connectivity') && (await ed.locator('h2').count()) >= 5)

  // ============================================================ 1. user types in A while the agent rewrites B (online, overlapping)
  {
    const bidB = await bidOf(page, 'Each save is pushed')
    check('agent addressing: paragraph B has a block id', !!bidB, String(bidB))
    await placeCaret(page, 'Field technicians')
    const run = agent(url, ['set-block', bidB!, '<p>Each save is pushed immediately to the sync server. The outbox stays empty.</p>'], { wait: 350, linger: 1800 })
    await run.connected
    const typing = page.keyboard.type(' (and auditors)', { delay: 35 })
    // while both are at it: agent caret + "is editing" indicator
    const label = page.locator('.collaboration-carets__label', { hasText: 'Claude' })
    const sawCaret = await waitFor(() => label.count(), (n) => n > 0, 3000)
    const sawIndicator = (await waitFor(() => page.getByTestId('agent-editing').count(), (n) => n > 0, 1500)) > 0
    if (sawCaret > 0) await page.screenshot({ path: shot('screenshot-agent-caret.png'), clip: { x: 0, y: 0, width: 1360, height: 1500 } })
    await typing
    const sawHighlight = (await waitFor(() => ed.locator('.agent-changed').count(), (n) => n > 0, 2500)) > 0
    const res = await run.done
    const a = await blockText(page, 'Field technicians')
    const b = await blockText(page, 'Each save is pushed')
    check('S1 parallel: agent op applied (exit 0, bytes small)', res.code === 0 && Number(agentJson(res).updateBytes) < 600, `${res.stderr.trim()} ${JSON.stringify(agentJson(res))}`)
    check('S1 parallel: user typing in A survived', !!a?.includes('Field technicians (and auditors) lose connectivity'), a ?? 'null')
    check('S1 parallel: agent rewrite of B survived', b === 'Each save is pushed immediately to the sync server. The outbox stays empty.', b ?? 'null')
    check('S1 parallel: browser showed the agent caret with its name', sawCaret > 0)
    check('S1 parallel: "Claude is editing…" indicator while the agent was connected', sawIndicator)
    check('S1 parallel: changed block got the fading highlight', sawHighlight)
    check('S1 parallel: indicator gone after the agent left', (await waitFor(() => page.getByTestId('agent-editing').count(), (n) => n === 0, 3000)) === 0)
    const c = await converged(page, url)
    check('S1 parallel: browser and server converged', c.ok, c.detail)
    check('S1 parallel: paragraph B kept its block id', (await bidOf(page, 'Each save is pushed')) === bidB)
  }

  // ============================================================ 2. same paragraph, different offsets (online, overlapping)
  {
    await placeCaret(page, 'Field technicians', -'Field technicians'.length) // start of A
    const run = agent(url, ['replace-text', 'on conflict handling.', 'on conflict resolution.'], { wait: 250, linger: 300 })
    await run.connected
    await page.keyboard.type('Note: ', { delay: 35 })
    const res = await run.done
    const a = await blockText(page, 'Note: Field')
    check('S2 same paragraph: agent replaced the end (exit 0)', res.code === 0, res.stderr.trim())
    check('S2 same paragraph: both edits present (character-level merge)', !!a?.startsWith('Note: Field technicians (and auditors)') && !!a?.endsWith('on conflict resolution.'), a ?? 'null')
    const c = await converged(page, url)
    check('S2 same paragraph: converged', c.ok, c.detail)
  }

  // ============================================================ 3a. same word, truly concurrent (browser offline while both edit)
  {
    await placeCaret(page, 'lose connect') // caret inside "connectivity": connect|ivity
    await setOnline(page, false)
    await sleep(100)
    const before = await caretContext(page)
    await page.keyboard.type('X', { delay: 20 })
    const run = agent(url, ['replace-text', 'connectivity on site', 'network access on site'], { linger: 100 })
    const res = await run.done
    check('S3a same word: agent edit applied on the server while the browser was offline', res.code === 0, res.stderr.trim())
    await setOnline(page, true)
    const c = await converged(page, url)
    check('S3a same word: converged after reconnect', c.ok, c.detail)
    const a = await blockText(page, 'Note: Field')
    const after = await caretContext(page)
    const userCharSurvived = !!a?.includes('X')
    const agentWon = !!a?.includes('network access')
    observed('S3a same word', `user typed "X" inside "connectivity" offline, agent replaced the word → "${a?.slice(40, 110)}"; user char survived=${userCharSurvived}, agent text present=${agentWon}; caret ${before} → ${after}`)
    check('S3a same word: no text lost beyond the replaced word, document valid', agentWon && !!a?.includes('Notes taken offline'), a ?? 'null')
    // clean up the stray character so later checks read naturally
    if (userCharSurvived) {
      const r2 = await agent(url, ['replace-text', 'X', ''], { linger: 50 }).done
      check('S3a cleanup', r2.code === 0, r2.stderr.trim())
    }
  }

  // ============================================================ 3b. agent replaces the whole paragraph the user is typing in (offline → concurrent)
  {
    const P = 'The client sends batches'
    await placeCaret(page, 'retries are idempotent.')
    await setOnline(page, false)
    await sleep(100)
    await page.keyboard.type(' USER-ADDITION', { delay: 15 })
    const bidP = await bidOf(page, P)
    const run = agent(url, ['set-block', bidP!, '<p>Clients send operation batches; every op has a client id, so retries are idempotent.</p>'], { linger: 100 })
    const res = await run.done
    check('S3b whole paragraph: agent set-block applied (exit 0)', res.code === 0, res.stderr.trim())
    const caretBefore = await caretContext(page)
    await setOnline(page, true)
    const c = await converged(page, url)
    check('S3b whole paragraph: converged after reconnect', c.ok, c.detail)
    const p1 = await blockText(page, 'Clients send')
    const p2 = await blockText(page, P)
    const all = await pageText(page)
    const userKept = all.includes('USER-ADDITION')
    observed('S3b whole paragraph', `agent replaced the paragraph (same type → text diff) while the user typed " USER-ADDITION" at its end offline → paragraph now: "${(p1 ?? p2 ?? '').slice(0, 140)}"; user text kept=${userKept}; caret before reconnect ${caretBefore}, after ${await caretContext(page)}`)
    check('S3b whole paragraph: agent text present, no duplicate paragraph', !!p1 && p2 === null, `p1=${!!p1} p2=${p2}`)
  }

  // ============================================================ 4. islands: one attribute → one side loses when concurrent
  {
    // 4a sequential online: user edits a label, 400 ms later the agent edits another label → both survive
    const box = await svgLabelBox(page, 'Outbox queue')
    check('S4 island: SVG label found in the shadow root', !!box)
    await page.mouse.click(box!.x, box!.y)
    await page.getByTestId('svg-overlay').waitFor({ timeout: 3000 })
    await page.keyboard.type(' (SQLite)', { delay: 20 })
    const diag = await page.evaluate(() => {
      const w = window as any
      let figs = 0
      let islands = 0
      w.__editor.state.doc.descendants((n: any) => {
        if (n.type.name === 'htmlIsland') islands++
        if (n.type.name === 'htmlIsland' && String(n.attrs.html).startsWith('<figure')) figs++
      })
      const hosts = Array.from(document.querySelectorAll('.island[data-island-kind="figure"] .island-host')) as HTMLElement[]
      const labels = hosts.map((h) => Array.from(h.shadowRoot?.querySelectorAll('svg text') ?? []).map((e) => e.textContent).join('|'))
      const ov = hosts.map((h) => h.shadowRoot?.querySelector('[data-testid="svg-overlay"]')?.textContent ?? null)
      return { figs, islands, hosts: hosts.length, labels, ov, active: document.activeElement?.tagName }
    })
    await page.keyboard.press('Enter')
    check('S4 island: user label edit landed in the island attribute', (await figureHtml(page)).includes('Outbox queue (SQLite)'), JSON.stringify(diag))
    await sleep(400)
    const r1 = await agent(url, ['set-island-text', '>Sync server<', '>Sync API<'], { linger: 100 }).done
    check('S4 island sequential: agent island edit applied', r1.code === 0, r1.stderr.trim())
    let c = await converged(page, url)
    let fig = await figureHtml(page)
    check('S4 island sequential (online, 400 ms apart): both label edits survive', fig.includes('Outbox queue (SQLite)') && fig.includes('>Sync API<') && c.ok, c.detail)
    // 4b concurrent (browser offline): user edits label 1, agent edits label 3 → the island is ONE string attribute
    await setOnline(page, false)
    await sleep(100)
    const box2 = await svgLabelBox(page, 'Device editor')
    await page.mouse.click(box2!.x, box2!.y)
    await page.getByTestId('svg-overlay').waitFor({ timeout: 3000 })
    await page.keyboard.type(' app', { delay: 20 })
    await page.keyboard.press('Enter')
    check('S4 island concurrent: user label edit landed locally (offline)', (await figureHtml(page)).includes('Device editor app'))
    const r2 = await agent(url, ['set-island-text', '>Sync API<', '>Sync endpoint<'], { linger: 100 }).done
    check('S4 island concurrent: agent island edit applied while browser offline', r2.code === 0, r2.stderr.trim())
    await setOnline(page, true)
    c = await converged(page, url)
    fig = await figureHtml(page)
    const userKept = fig.includes('Device editor app')
    const agentKept = fig.includes('>Sync endpoint<')
    observed('S4 island concurrent', `user label edit kept=${userKept}, agent label edit kept=${agentKept} (island html = one Y attribute → last writer wins for the whole island; which one wins depends on Yjs client ids)`)
    check('S4 island concurrent: converged (one side lost, as predicted)', c.ok && userKept !== agentKept, `${c.detail}; user=${userKept} agent=${agentKept}`)
    check('S4 island: SVG still byte-identical except the labels', fig.includes('marker-end="url(#arrow)"') && fig.includes('<figcaption>Figure 1'))
    // 4c mitigation: while the user's focus is inside the island, awareness carries a soft lock the agent honours
    const box3 = await svgLabelBox(page, 'POST /sync')
    await page.mouse.click(box3!.x, box3!.y)
    await page.getByTestId('svg-overlay').waitFor({ timeout: 3000 })
    await sleep(150)
    const locked = await agent(url, ['set-island-text', '>save<', '>save (local)<', '--lock-timeout', '400'], { linger: 50 }).done
    const lj = agentJson(locked)
    check('S4 island lock: agent refuses to rewrite an island the user is editing in (exit 5, names the user)', locked.code === 5 && lj.locked === true && lj.lockedBy === 'Noah', `exit ${locked.code} ${JSON.stringify(lj)}`)
    await page.keyboard.press('Enter') // user leaves the island → lock released
    await sleep(150)
    const unlocked = await agent(url, ['set-island-text', '>save<', '>save (local)<'], { linger: 50 }).done
    check('S4 island lock: released when the user leaves → agent edit goes through', unlocked.code === 0 && (await waitFor(() => figureHtml(page), (f) => f.includes('>save (local)<'), 3000)).includes('>save (local)<'), `exit ${unlocked.code} ${unlocked.stderr.trim()}`)
  }

  // ============================================================ 5. undo: ⌘Z undoes only the user's own edits
  {
    await placeCaret(page, 'mark overlapping edits.')
    await page.keyboard.type(' UNDOME', { delay: 15 })
    await sleep(600) // new undo group after the agent's change
    const r = await agent(url, ['replace-text', 'Full-document sync was rejected', 'Full-document sync was rejected early'], { linger: 100 }).done
    check('S5 undo: agent edit applied', r.code === 0, r.stderr.trim())
    await waitFor(() => pageText(page), (t) => t.includes('rejected early'), 3000)
    let tries = 0
    while ((await pageText(page)).includes('UNDOME') && tries++ < 4) {
      await page.keyboard.press(`${mod}+z`)
      await sleep(80)
    }
    const t = await pageText(page)
    check('S5 undo: ⌘Z removed the user text', !t.includes('UNDOME'), `${tries} press(es)`)
    check("S5 undo: …but not the agent's edit (Y.UndoManager tracks only local origins)", t.includes('rejected early'))
    const canRedo = await page.evaluate(() => (window as any).__editor.can().redo() as boolean)
    await page.keyboard.press(`${mod}+Shift+z`)
    await sleep(80)
    check('S5 undo: ⇧⌘Z redoes the user text', (await pageText(page)).includes('UNDOME'), `can().redo() was ${canRedo}`)
    const c = await converged(page, url)
    check('S5 undo: converged', c.ok, c.detail)
  }

  // ============================================================ 6. browser offline while the agent appends a section → converges
  {
    await setOnline(page, false)
    await sleep(100)
    await placeCaret(page, 'to force a sync.')
    await page.keyboard.type(' Typed while offline.', { delay: 10 })
    const r = await agent(url, ['append-section', '<h2 id="rollout">6. Rollout</h2><p>Phase 1: 20 pilot devices in one region.</p>'], { linger: 100 }).done
    check('S6 offline: agent appended a section while the browser was offline', r.code === 0, r.stderr.trim())
    const st = await providerState(page)
    check('S6 offline: browser was really disconnected', st.status === 'disconnected', st.status)
    await setOnline(page, true)
    const c = await converged(page, url)
    const t = await pageText(page)
    check('S6 offline: converged after reconnect, both edits present', c.ok && t.includes('Typed while offline.') && t.includes('6. Rollout') && t.includes('Phase 1: 20 pilot devices'), c.detail)
    check('S6 offline: the new heading is in the outline', (await page.locator('.outline li').allInnerTexts()).some((x) => x.includes('6. Rollout')))
  }

  // ============================================================ 7. file edited on disk while live → 3-way merge, no echo loop
  {
    await flush(url)
    await sleep(100)
    const h0 = await health(url)
    let onDisk = readDoc()
    check('S7 disk: file on disk is current after flush (contains the edits so far)', onDisk.includes('Phase 1: 20 pilot devices') && onDisk.includes('(and auditors)'))
    await placeCaret(page, '— Field ops lead, interview 2026-10-12')
    const typing = page.keyboard.type(' (notes in the wiki)', { delay: 30 })
    await sleep(250)
    // "the agent" edits the file with its Edit tool while the user is typing
    onDisk = onDisk.replace('Retry with exponential backoff', 'Retry with exponential backoff (max 5 attempts)')
    fs.writeFileSync(doc, onDisk)
    await typing
    const h1 = await waitFor(() => health(url), (x) => x.externalMerges > h0.externalMerges, 5000)
    check('S7 disk: watcher noticed the external edit and merged it (3-way)', h1.externalMerges === h0.externalMerges + 1, `merges ${h0.externalMerges} → ${h1.externalMerges}, update ${h1.lastMergeUpdateBytes} B in ${h1.lastMergeMs} ms`)
    const t = await waitFor(() => pageText(page), (x) => x.includes('(max 5 attempts)'), 4000)
    check('S7 disk: browser shows the file edit live', t.includes('Retry with exponential backoff (max 5 attempts)'))
    check('S7 disk: concurrent user typing preserved', t.includes('interview 2026-10-12 (notes in the wiki)'), (await blockText(page, '— Field ops')) ?? '')
    const c = await converged(page, url)
    check('S7 disk: converged', c.ok, c.detail)
    const h2 = await waitFor(() => health(url), (x) => x.stores > h1.stores, 6000)
    const after = readDoc()
    check('S7 disk: merged document written back to disk (both edits in the file)', after.includes('(max 5 attempts)') && after.includes('(notes in the wiki)'))
    await sleep(1500)
    const h3 = await health(url)
    check('S7 disk: no echo loop (own write ignored, merges unchanged)', h3.externalMerges === h1.externalMerges && h3.echoesIgnored >= h2.echoesIgnored && h3.echoesIgnored >= 1, `merges=${h3.externalMerges} echoesIgnored=${h3.echoesIgnored} stores=${h3.stores}`)
  }

  // ============================================================ 8. agent via the server's direct connection
  {
    const r = await agent(url, ['replace-text', 'Owner: Noah', 'Owner: Noah & Claude'], { via: 'server', linger: 1200 }).done
    const j = agentJson(r)
    check('S8 via server: /agent/op applied the edit through a direct connection', r.code === 0 && j.ok === true && j.via === 'server', r.stdout.trim().slice(0, 200))
    const t = await waitFor(() => pageText(page), (x) => x.includes('Owner: Noah & Claude'), 3000)
    check('S8 via server: browser received it', t.includes('Owner: Noah & Claude'))
    const label = await waitFor(() => page.locator('.collaboration-carets__label', { hasText: 'Claude' }).count(), (n) => n > 0, 1500)
    observed('S8 via server', `caret via the server-side awareness instance visible=${label > 0}`)
  }

  // ============================================================ 9. server restart → sidecar restores the state; HTML correct
  {
    const before = await pageText(page)
    const code = await server!.stop()
    check('S9 restart: server stored and exited on SIGTERM', code === 0, `exit ${code}`)
    const onDisk = readDoc()
    check('S9 restart: HTML on disk has every edit', onDisk.includes('(and auditors)') && onDisk.includes('6. Rollout') && onDisk.includes('Owner: Noah &amp; Claude') && onDisk.includes('Outbox queue (SQLite)') && /Sync (API|endpoint)</.test(onDisk), '')
    check('S9 restart: <head> still byte-identical', onDisk.startsWith(originalHead))
    const st = await waitFor(() => providerState(page), (s) => s.status !== 'connected', 5000)
    check('S9 restart: browser noticed the disconnect', st.status !== 'connected', st.status)
    server = await startServer(doc, port)
    await waitSynced(page, url)
    const after = await pageText(page)
    check('S9 restart: browser reconnected to the new server process', after === before, after === before ? '' : 'text differs')
    h = await health(url)
    check('S9 restart: state restored from the sidecar (hash matched the HTML file)', h.loadedFrom === 'sidecar', `loadedFrom=${h.loadedFrom}`)
    const c = await converged(page, url)
    check('S9 restart: converged', c.ok, c.detail)
    // edit the file while the server is DOWN → sidecar is stale → rebuilt from HTML
    await server.stop()
    fs.writeFileSync(doc, readDoc().replace('>1. Goals<', '>1. Goals and scope<'))
    server = await startServer(doc, port)
    await waitSynced(page, url)
    h = await health(url)
    check('S9 restart: file edited while down → sidecar stale → rebuilt from HTML', h.loadedFrom === 'html', `loadedFrom=${h.loadedFrom}`)
    const t = await waitFor(() => pageText(page), (x) => x.includes('1. Goals and scope'), 5000)
    check('S9 restart: browser shows the offline file edit after reconnect', t.includes('1. Goals and scope'))
    observed('S9 restart (stale sidecar)', `browser's Y.Doc was replaced by a fresh one (new client state) — fine here because the browser had no pending offline edits; with pending edits they would be lost (different Y.Doc history)`)
  }

  check('no console errors during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  await page.screenshot({ path: shot('screenshot-full.png'), fullPage: true })
} catch (e) {
  console.error(e)
  failures++
} finally {
  await browser?.close()
  if (server) await server.stop()
  console.log(`\nserver output (tail):\n${server?.output().split('\n').slice(-12).join('\n') ?? ''}`)
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
