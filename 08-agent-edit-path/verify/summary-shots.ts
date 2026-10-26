// npx tsx verify/summary-shots.ts — screenshots / CLI transcripts of the agent edit path for ../SUMMARY.html.
// Starts its own server on a temp copy of the sample, a browser user (Noah) types, the agent uses the real `collab` CLI.
// Writes ../summary-img/08-*.png and 08-*.txt.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { root, startServer, type ServerHandle } from '../lib/serverProc.ts'

const outDir = path.resolve(root, '../summary-img')
fs.mkdirSync(outDir, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike08-shots-'))
const doc = path.join(tmp, 'spec.html')
fs.copyFileSync(path.resolve(root, '../samples/spec.html'), doc)

const W = 1360
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const block = (old: string, neu: string) => `<<<<<<< SEARCH\n${old}\n=======\n${neu}\n>>>>>>> REPLACE\n`

interface Run {
  code: number | null
  stdout: string
}
function cli(url: string, args: string[], stdin?: string): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'bin/collab.ts', '--server', url, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    p.stderr.on('data', (d: Buffer) => (stdout += d.toString()))
    p.on('exit', (code) => resolve({ code, stdout }))
    if (stdin !== undefined) p.stdin.write(stdin)
    p.stdin.end()
  })
}
/** the transcript as the agent sees it in its terminal: command, heredoc, output (JSON pretty-printed), exit code */
function transcript(args: string[], stdin: string | undefined, r: Run) {
  const cmd = `$ collab ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}${stdin ? " <<'EOF'" : ''}`
  const body = r.stdout
    .trimEnd()
    .split('\n')
    .map((l) => {
      if (!l.startsWith('{')) return l
      try {
        return JSON.stringify(JSON.parse(l), null, 2)
      } catch {
        return l
      }
    })
    .join('\n')
  return `${cmd}\n${stdin ? `${stdin}EOF\n` : ''}${body}\n# exit code ${r.code}\n`
}
async function saveCli(name: string, url: string, args: string[], stdin?: string, note = '') {
  const r = await cli(url, args, stdin)
  const t = (note ? `# ${note}\n` : '') + transcript(args, stdin, r)
  fs.writeFileSync(path.join(outDir, `08-${name}.txt`), t)
  console.log('wrote', `${name}.txt`, `(exit ${r.code})`)
  return { ...r, text: t }
}
/** render a terminal transcript as a dark terminal-ish image */
async function terminalShot(browser: Browser, name: string, text: string) {
  const page = await browser.newPage({ viewport: { width: W, height: 400 } })
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#1e1f24;color:#d8dae0;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
    pre{margin:0;padding:16px 20px;white-space:pre}
    .cmd{color:#8fd18f}.cm{color:#8a8f98}.mark{color:#ffcc66;font-weight:bold}
  </style><pre>${esc
    .split('\n')
    .map((l) => (l.startsWith('$ ') ? `<span class="cmd">${l}</span>` : l.startsWith('#') ? `<span class="cm">${l}</span>` : l.includes('✎') ? `<span class="mark">${l}</span>` : l))
    .join('\n')}</pre>`)
  const box = (await page.locator('pre').boundingBox())!
  await page.setViewportSize({ width: W, height: Math.ceil(box.height) })
  await page.screenshot({ path: path.join(outDir, `08-${name}.png`), fullPage: true })
  await page.close()
  console.log('wrote', `${name}.png`)
}
async function caretAfter(page: Page, text: string) {
  await page.evaluate((t) => {
    const ed = (window as any).__editor
    let pos = -1
    ed.state.doc.descendants((n: any, p: number) => {
      if (pos < 0 && n.isText && n.text.includes(t)) pos = p + n.text.indexOf(t) + t.length
    })
    ed.commands.setTextSelection(pos)
    ed.view.focus()
    const c = ed.view.coordsAtPos(pos)
    window.scrollBy(0, c.top - window.innerHeight / 3)
  }, text)
  await sleep(100)
}
/** viewport box of the block containing `text` (polls with plain evaluate: page.waitForFunction stalls ~1.2 s here) */
async function blockBox(page: Page, text: string) {
  for (let i = 0; i < 100; i++) {
    const b = await page.evaluate((t) => {
      const el = [...document.querySelectorAll('.tiptap li, .tiptap p, .tiptap td, .tiptap h2, .tiptap h3')].find((e) => e.textContent!.includes(t))
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { y: r.top, height: r.height }
    }, text)
    if (b) return b
    await sleep(50)
  }
  throw new Error(`block not found: ${text}`)
}
async function shotAround(page: Page, name: string, box: { y: number; height: number }, above = 120, below = 120) {
  const y = Math.max(0, box.y - above)
  await page.screenshot({ path: path.join(outDir, `08-${name}.png`), clip: { x: 0, y, width: W, height: box.height + above + below } })
  console.log('wrote', `${name}.png`)
}

let srv: ServerHandle | undefined
let browser: Browser | undefined
try {
  srv = await startServer(doc)
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: W, height: 900 } })
  await page.goto(`${srv.url}/?user=Noah`)
  await page.waitForFunction(() => (window as any).__editor && (window as any).__provider?.synced, null, { timeout: 20000 })
  await sleep(600)

  // 1. the user types in the "Sync completes" requirement; the agent reads the outline (✎ Noah marks that block)
  await caretAfter(page, 'of reconnecting')
  await page.keyboard.type(' (median)', { delay: 40 })
  await sleep(400)
  const ol = await saveCli('read-outline', srv.url, ['read', '--outline'], undefined, "Noah's caret is in the “Sync completes …” list; ✎ Noah marks that block")
  await terminalShot(browser, 'read-outline', ol.text)

  // 2. a patch elsewhere: the browser shows the agent's caret + the fading highlight on the changed block
  await caretAfter(page, '(median)')
  const t0 = Date.now()
  const p1 = cli(srv.url, ['patch'], block('Web client support (mobile only for v1).', 'Web client support (mobile and tablet only for v1).'))
  let shot = false
  while (Date.now() - t0 < 8000) {
    // one evaluate for state + box + scroll: a second page.evaluate here stalls ~1.2 s (the caret is gone by then)
    const st = await page.evaluate(() => {
      const r = document.querySelector('.tiptap .agent-changed')?.getBoundingClientRect()
      return {
        sy: window.scrollY,
        hl: document.querySelectorAll('.agent-changed').length,
        caret: [...document.querySelectorAll('.collaboration-carets__caret')].map((e) => e.textContent).join(','),
        tb: document.querySelector('[data-testid="toolbar"]')!.getBoundingClientRect().toJSON(),
        y: (r?.top ?? 0) + window.scrollY,
        h: r?.height ?? 0,
      }
    })
    if (!shot && st.hl && st.caret.includes('Claude')) {
      // CDP capture: page.screenshot() takes ~1.3 s here (font/stability waits), longer than the caret lingers
      const cdp = await page.context().newCDPSession(page)
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: st.y - 170, width: W, height: st.h + 260, scale: 1 } })
      fs.writeFileSync(path.join(outDir, '08-patch-browser.png'), Buffer.from(data, 'base64'))
      // same moment, the toolbar: presence chips with "Claude" + "Claude is editing…"
      const tb = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: st.tb.y + st.sy, width: W, height: st.tb.height, scale: 1 } })
      fs.writeFileSync(path.join(outDir, '08-patch-toolbar.png'), Buffer.from(tb.data, 'base64'))
      await cdp.detach()
      shot = true
      console.log('patch-browser shot at', Date.now() - t0, 'ms')
      break
    }
    await sleep(100)
  }
  if (!shot) console.log('no agent caret + highlight seen')
  if ((await p1).code !== 0) throw new Error(`patch failed: ${(await p1).stdout}`)

  // 3. NOT_FOUND with `closest`: the agent's SEARCH text predates the user's "(median)"
  await caretAfter(page, '(median)')
  await saveCli('not-found.txt'.replace('.txt', ''), srv.url, ['patch'], block('of reconnecting for a typical day', 'of reconnecting for a full day'), 'the user typed “(median)” inside the SEARCH text after the agent read it → NOT_FOUND, `closest` has the current HTML')

  // 4. --avoid-caret refuses (exit 5) …
  await saveCli('avoid-caret', srv.url, ['patch', '--avoid-caret'], block('of reconnecting (median) for a typical day', 'of reconnecting (median) for a full day'), "Noah's caret is in the block → --avoid-caret refuses, exit 5 USER_IN_BLOCK")
  // … without it, the patch applies and warns
  await saveCli('patch-warning', srv.url, ['patch'], block('of reconnecting (median) for a typical day', 'of reconnecting (median) for a full day'), "same patch without --avoid-caret: applied; the warning names Noah, whose caret is in that block")
  await sleep(2800) // let the highlight fade

  // 5. suggestion mode: --propose → change thread with Accept change / Reject
  const pr = await cli(srv.url, ['patch', '--propose', '--message', 'Shorter?'], block('Real-time collaboration between technicians.', 'Live co-editing between technicians.'))
  const proposed = JSON.parse(pr.stdout.split('\n').find((l) => l.startsWith('{'))!).proposed as string
  const card = page.getByTestId(`thread-${proposed}`)
  await card.waitFor({ timeout: 5000 })
  await card.scrollIntoViewIfNeeded()
  await page.evaluate(() => window.scrollBy(0, -200))
  await sleep(500)
  const cb = (await card.boundingBox())!
  const nb = await blockBox(page, 'Real-time collaboration')
  const top = Math.min(cb.y, nb.y)
  const bottom = Math.max(cb.y + cb.height, nb.y + nb.height)
  await shotAround(page, 'propose-before', { y: top, height: bottom - top }, 90, 90)
  await card.getByTestId('proposal-accept').click()
  await sleep(500)
  // the accepted proposal is resolved (hidden by default) → show resolved threads so its card stays in the shot
  await page.getByTestId('toggle-resolved').click()
  await sleep(400)
  const nb2 = await blockBox(page, 'Live co-editing')
  const cb2 = (await card.boundingBox({ timeout: 2000 }).catch(() => null)) ?? nb2
  const top2 = Math.min(cb2.y, nb2.y)
  const bottom2 = Math.max(cb2.y + cb2.height, nb2.y + nb2.height)
  await shotAround(page, 'propose-after', { y: top2, height: bottom2 - top2 }, 90, 90)
} finally {
  await browser?.close()
  await srv?.stop()
  fs.rmSync(tmp, { recursive: true, force: true })
}
