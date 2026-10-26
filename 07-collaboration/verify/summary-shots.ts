// npx tsx verify/summary-shots.ts — screenshots of spike 07's collaboration features for ../SUMMARY.html.
// Starts its own server (free port, no HMR) on a temp copy of the sample, opens two browser contexts (Noah, Pat),
// runs the agent CLI as a child process like verify.ts, writes ../summary-img/07-*.png (+ 07-island-lock.txt).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { root, startServer, freePort, type ServerHandle } from '../lib/serverProc.ts'

const outDir = path.resolve(root, '../summary-img')
fs.mkdirSync(outDir, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike07-shots-'))
const doc = path.join(tmp, 'spec.html')
fs.copyFileSync(path.resolve(root, '../samples/spec.html'), doc)

const W = 1360
const out = (name: string) => path.join(outDir, `07-${name}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(fn: () => Promise<T> | T, pred: (v: T) => boolean, timeoutMs = 8000, every = 40): Promise<T> {
  const t0 = Date.now()
  let v = await fn()
  while (!pred(v) && Date.now() - t0 < timeoutMs) {
    await sleep(every)
    v = await fn()
  }
  return v
}

// ---------------------------------------------------------------- the agent (child process, as in verify.ts)
function agent(url: string, args: string[], opts: { linger?: number; json?: boolean } = {}) {
  const full = ['--import', 'tsx', 'agent/agent.ts', '--server', url, '--linger', String(opts.linger ?? 1200)]
  if (opts.json !== false) full.push('--json')
  const proc = spawn(process.execPath, [...full, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
  proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((r) => proc.on('exit', (code) => r({ code, stdout, stderr })))
  return { proc, done }
}

// ---------------------------------------------------------------- page helpers
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
async function selectText(page: Page, find: string) {
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
  }, find)
  await sleep(30)
}
const pageText = (page: Page) => page.evaluate(() => (window as any).__editor.state.doc.textBetween(0, (window as any).__editor.state.doc.content.size, '\n', '￼') as string)
const providerState = (page: Page) =>
  page.evaluate(() => {
    const p = (window as any).__provider
    return { status: p.configuration.websocketProvider.status as string, synced: p.isSynced as boolean, unsynced: p.unsyncedChanges as number }
  })
async function waitSynced(page: Page) {
  await waitFor(() => providerState(page), (s) => s.status === 'connected' && s.synced && s.unsynced === 0, 10000)
  await sleep(150)
}
async function open(browser: Browser, url: string, user: string, color: string, height = 900) {
  const ctx = await browser.newContext({ viewport: { width: W, height } })
  const page = await ctx.newPage()
  await page.goto(`${url}/?user=${user}&color=${encodeURIComponent(color)}`)
  await page.locator('.tiptap h1').first().waitFor({ timeout: 15000 })
  await page.locator('.island[data-island-kind="figure"]').waitFor()
  await waitSynced(page)
  return page
}
/** viewport clip from the top of the page (toolbar) down to the bottom of the given locator + `below` */
async function shotTopTo(page: Page, name: string, loc: ReturnType<Page['locator']>, below = 40) {
  const b = (await loc.boundingBox())!
  await page.screenshot({ path: out(`${name}.png`), clip: { x: 0, y: 0, width: W, height: Math.round(b.y + b.height + below) } })
  console.log('wrote', name)
}
async function svgLabelBox(page: Page, label: string) {
  await page.locator('.island[data-island-kind="figure"]').scrollIntoViewIfNeeded()
  await sleep(50)
  return page.evaluate((txt) => {
    const host = document.querySelector('.island[data-island-kind="figure"] .island-host') as HTMLElement
    const el = Array.from(host.shadowRoot!.querySelectorAll('svg text')).find((e) => e.textContent === txt)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width - 1, y: r.y + r.height / 2 }
  }, label)
}

let server: ServerHandle | undefined
let browser: Browser | undefined
const running: ReturnType<typeof agent>[] = []
try {
  server = await startServer(doc, await freePort())
  const url = server.url
  browser = await chromium.launch()

  // ============================================================ two humans: carets + presence chips
  const noah = await open(browser, url, 'Noah', '#2a7de1')
  const pat = await open(browser, url, 'Pat', '#d9480f')
  const intro = (p: Page) => p.locator('.tiptap p', { hasText: 'Field technicians' }).first()
  await placeCaret(noah, 'lose connectivity')
  await noah.keyboard.type(' (often)', { delay: 30 })
  await selectText(pat, 'client-side queue')
  await sleep(3000) // let the remote-change flashes fade
  await shotTopTo(noah, 'two-users-noah', intro(noah), 30)
  await shotTopTo(pat, 'two-users-pat', intro(pat), 30)
  // side by side composite (same render, nothing faked: two screenshots placed next to each other)
  {
    const a = fs.readFileSync(out('two-users-noah.png')).toString('base64')
    const b = fs.readFileSync(out('two-users-pat.png')).toString('base64')
    const comp = await browser.newPage({ viewport: { width: W, height: 400 } })
    await comp.setContent(
      `<body style="margin:0;background:#e9ecef;font:600 13px system-ui;color:#495057"><div style="display:flex;flex-direction:column;gap:8px;padding:8px">` +
        `<div style="flex:1"><div style="padding:2px 4px 6px">?user=Noah</div><img style="width:100%;border:1px solid #ced4da" src="data:image/png;base64,${a}"></div>` +
        `<div style="flex:1"><div style="padding:2px 4px 6px">?user=Pat</div><img style="width:100%;border:1px solid #ced4da" src="data:image/png;base64,${b}"></div></div></body>`,
    )
    await comp.screenshot({ path: out('two-users.png'), fullPage: true })
    await comp.close()
    fs.rmSync(out('two-users-noah.png'))
    fs.rmSync(out('two-users-pat.png'))
    console.log('wrote two-users')
  }
  await pat.context().close()

  // ============================================================ the agent types live
  await placeCaret(noah, 'Owner: Noah') // user caret somewhere else
  await noah.evaluate(() => window.scrollTo(0, 0))
  const typed = ' and auditors in the field'
  const typing = agent(url, ['type', 'Field technicians', typed, '--type-delay', '90'], { linger: 4000 })
  running.push(typing)
  await waitFor(() => pageText(noah), (t) => t.includes('Field technicians and audi'), 15000)
  await noah.getByTestId('agent-editing').waitFor({ timeout: 3000 })
  await shotTopTo(noah, 'agent-typing', intro(noah), 40)
  await waitFor(() => pageText(noah), (t) => t.includes(`Field technicians${typed}`), 15000)
  await typing.done

  // ============================================================ status bar: last remote change
  {
    // a single agent edit → the changed block flashes and fades over 2.5 s; capture it ~1/3 into the fade
    const run = agent(url, ['replace-text', 'conflict handling', 'conflict resolution'], { linger: 3000 })
    running.push(run)
    await waitFor(() => pageText(noah), (t) => t.includes('on conflict resolution'), 15000)
    await sleep(800)
    await shotTopTo(noah, 'agent-highlight-fade', intro(noah), 40)
    const r = await run.done
    if (r.code !== 0) throw new Error(r.stderr)
    await noah.getByTestId('remote-changes').waitFor()
    const sb = (await noah.getByTestId('statusbar').boundingBox())!
    await noah.screenshot({ path: out('statusbar.png'), clip: { x: 0, y: sb.y - 4, width: W, height: sb.height + 8 } })
    console.log('wrote statusbar')
  }

  // ============================================================ offline
  await placeCaret(noah, 'lose connectivity')
  await noah.evaluate(() => (window as any).__provider.disconnect())
  await waitFor(() => noah.getByTestId('status').innerText(), (s) => s.startsWith('Offline'), 5000)
  await noah.keyboard.type(' — typed while offline', { delay: 20 })
  await sleep(300)
  await shotTopTo(noah, 'offline', intro(noah), 30)
  await noah.evaluate(() => (window as any).__provider.connect())
  await waitSynced(noah)

  // ============================================================ island soft lock
  {
    await noah.evaluate(() => document.querySelector('.island[data-island-kind="figure"]')!.scrollIntoView({ block: 'center' }))
    await sleep(200)
    const box = await svgLabelBox(noah, 'POST /sync')
    await noah.mouse.click(box!.x, box!.y)
    await noah.getByTestId('svg-overlay').waitFor({ timeout: 3000 })
    await noah.keyboard.type(' v2', { delay: 40 })
    await sleep(200)
    const cmd = ['set-island-text', '>save<', '>save (local)<', '--lock-timeout', '1500']
    const locked = agent(url, cmd, { linger: 50, json: false })
    running.push(locked)
    await sleep(700) // agent is waiting for the lock now
    const fig = (await noah.locator('.island[data-island-kind="figure"]').boundingBox())!
    await noah.screenshot({ path: out('island-lock.png'), clip: { x: 0, y: Math.max(0, fig.y - 60), width: W, height: fig.height + 100 } })
    console.log('wrote island-lock')
    const r = await locked.done
    const j = await agent(url, cmd, { linger: 50 }).done
    fs.writeFileSync(
      out('island-lock.txt'),
      `# user Noah has the caret inside the SVG label "POST /sync" (island soft lock via awareness)\n` +
        `$ npm run agent -- ${cmd.map((a) => (a.includes(' ') || a.includes('>') ? `'${a}'` : a)).join(' ')}\n` +
        `${(r.stdout + r.stderr).trim()}\n(exit ${r.code})\n\n` +
        `$ npm run agent -- ${cmd.map((a) => (a.includes(' ') || a.includes('>') ? `'${a}'` : a)).join(' ')} --json\n` +
        `${(j.stdout + j.stderr).trim()}\n(exit ${j.code})\n`,
    )
    console.log('wrote island-lock.txt', r.code, j.code)
  }
} finally {
  for (const r of running) if (r.proc.exitCode === null) r.proc.kill()
  await browser?.close()
  await server?.stop()
  fs.rmSync(tmp, { recursive: true, force: true })
}
