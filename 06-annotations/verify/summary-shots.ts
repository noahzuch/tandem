// npx tsx verify/summary-shots.ts — screenshots of every annotation feature for ../SUMMARY.html.
// Starts its own server on a temp copy of the sample, drives the UI with the real mouse/keyboard (like verify.ts) and plays
// the agent through bin/collab.ts. Writes ../summary-img/06-*.png.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { root, startServer, freePort, type ServerHandle } from '../lib/serverProc.ts'

const outDir = path.resolve(root, '../summary-img')
fs.mkdirSync(outDir, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike06-shots-'))
const doc = path.join(tmp, 'spec.html')
fs.copyFileSync(path.resolve(root, '../samples/spec.html'), doc)

const W = 1360
const H = 900
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

// ---------------------------------------------------------------- agent CLI
interface Run {
  code: number | null
  stdout: string
  json: any
}
const procs = new Set<ReturnType<typeof spawn>>()
function run(script: string, args: string[]): Promise<Run> {
  const proc = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  procs.add(proc)
  let stdout = ''
  proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
  proc.stderr.on('data', () => {})
  return new Promise((resolve) =>
    proc.on('exit', (code) => {
      procs.delete(proc)
      const line = stdout.split('\n').find((l) => l.startsWith('{'))
      let json: any = null
      try {
        json = line ? JSON.parse(line) : null
      } catch {
        /* not json */
      }
      resolve({ code, stdout, json })
    }),
  )
}
let url = ''
const collab = (...args: string[]) => run('bin/collab.ts', ['--server', url, ...args])
const waitBg = (timeout = 40) => collab('wait', '--timeout', String(timeout))

// ---------------------------------------------------------------- shots
type Box = { x: number; y: number; width: number; height: number }
async function shot(page: Page, name: string, boxes: (Box | null)[], pad = { l: 40, r: 40, t: 40, b: 40 }, fullWidth = false) {
  const bs = boxes.filter(Boolean) as Box[]
  let x1 = Math.min(...bs.map((b) => b.x)) - pad.l
  let x2 = Math.max(...bs.map((b) => b.x + b.width)) + pad.r
  const y1 = Math.max(0, Math.min(...bs.map((b) => b.y)) - pad.t)
  const y2 = Math.min(H, Math.max(...bs.map((b) => b.y + b.height)) + pad.b)
  if (fullWidth) {
    x1 = 0
    x2 = W
  }
  x1 = Math.max(0, x1)
  x2 = Math.min(W, x2)
  await page.screenshot({ path: path.join(outDir, `06-${name}.png`), clip: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } })
  console.log('wrote', `06-${name}.png`)
}
const bb = (l: Locator) => l.first().boundingBox()

// ---------------------------------------------------------------- UI helpers (real mouse / keyboard)
async function scrollToText(page: Page, text: string) {
  await page.evaluate((t) => {
    const el = Array.from(document.querySelectorAll('.tiptap p, .tiptap li, .tiptap h1, .tiptap h2, .tiptap h3')).find((e) => e.textContent!.includes(t))
    el?.scrollIntoView({ block: 'center' })
  }, text)
  await sleep(250)
}
async function textBox(page: Page, text: string) {
  const box = await page.evaluate((t) => {
    const walker = document.createTreeWalker(document.querySelector('.tiptap')!, NodeFilter.SHOW_TEXT)
    let n: Node | null
    while ((n = walker.nextNode())) {
      const i = n.textContent!.indexOf(t)
      if (i >= 0) {
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + t.length)
        const b = r.getBoundingClientRect()
        return { x: b.left, y: b.top, width: b.width, height: b.height }
      }
    }
    return null
  }, text)
  if (!box) throw new Error(`text not found: ${text}`)
  return box
}
async function selectText(page: Page, text: string) {
  await scrollToText(page, text)
  const b = await textBox(page, text)
  await page.mouse.move(b.x + 1, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 6 })
  await page.mouse.up()
  await page.getByTestId('bubble-comment').waitFor({ state: 'visible', timeout: 3000 })
  await sleep(150)
}
async function compose(page: Page, text: string, kind?: string) {
  await page.getByTestId('composer').waitFor({ timeout: 3000 })
  if (kind) await page.getByTestId(`kind-${kind}`).click()
  await page.getByTestId('composer-text').click()
  await page.keyboard.type(text)
}
async function submit(page: Page) {
  await page.keyboard.press('ControlOrMeta+Enter')
  await page.getByTestId('composer').waitFor({ state: 'detached', timeout: 3000 })
  await sleep(300)
  return page.evaluate(() => (window as any).__comments.store.active as string)
}
async function clickAway(page: Page) {
  // click at the end of the title (collapses the selection; the scroll position is restored afterwards)
  const y = await page.evaluate(() => window.scrollY)
  await page.evaluate(() => window.scrollTo(0, 0))
  await sleep(150)
  const h1 = (await bb(page.locator('.tiptap h1')))!
  await page.mouse.click(h1.x + h1.width - 5, h1.y + h1.height / 2)
  await sleep(150)
  await page.evaluate((v) => window.scrollTo(0, v), y)
  await sleep(250)
}
const badge = (page: Page) => page.getByTestId('agent-listening').innerText()
const panelHead = async (page: Page) => {
  const p = (await bb(page.getByTestId('comments-panel')))!
  return { x: p.x, y: p.y, width: p.width, height: 70 }
}

let server: ServerHandle | undefined
let browser: Browser | undefined
try {
  server = await startServer(doc, await freePort())
  url = server.url
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  await page.goto(`${url}/?user=Noah&color=%232a7de1`)
  await page.locator('.tiptap h1').waitFor({ timeout: 15000 })
  await page.getByTestId('comments-panel').waitFor()
  await sleep(600)
  const card = (id: string) => page.getByTestId(`thread-${id}`)

  // ---- agent badge: not listening vs listening
  await shot(page, 'agent-not-listening', [await panelHead(page)], { l: 10, r: 10, t: 10, b: 10 })
  await page.getByTestId('mode-now').click()
  let w = waitBg()
  await waitFor(() => badge(page), (t) => !t.includes('not'), 8000)
  await sleep(200)
  await shot(page, 'agent-listening', [await panelHead(page)], { l: 10, r: 10, t: 10, b: 10 })

  // ---- bubble (Comment / Ask agent) on a selection
  await selectText(page, 'client-side queue')
  const intro = page.locator('.tiptap p', { hasText: 'Field technicians' })
  await shot(page, 'bubble', [await bb(intro), await bb(page.getByTestId('bubble-comment'))], { l: 30, r: 30, t: 50, b: 30 })

  // ---- composer with kind chips
  await page.getByTestId('bubble-comment').click()
  await compose(page, 'Is this the same thing as the outbox? Please make the naming consistent.', 'change')
  await sleep(250)
  await shot(page, 'composer', [await bb(intro), await bb(page.getByTestId('composer'))], { l: 30, r: 20, t: 50, b: 30 })
  const t1 = await submit(page)
  await w

  // ---- highlight + its card aligned in the margin (inactive: fresh load, no active thread), then active (clicked)
  await page.reload()
  await page.locator('.tiptap h1').waitFor({ timeout: 15000 })
  await card(t1).waitFor({ timeout: 5000 })
  await sleep(600)
  await scrollToText(page, 'Field technicians')
  await shot(page, 'highlight-card', [await bb(intro), await bb(card(t1))], { l: 30, r: 20, t: 40, b: 40 })
  const hl = await textBox(page, 'client-side queue')
  await page.mouse.click(hl.x + hl.width / 2, hl.y + hl.height / 2)
  await sleep(400)
  await shot(page, 'active-highlight', [await bb(intro), await bb(card(t1))], { l: 30, r: 20, t: 40, b: 40 })

  // ---- agent reply via `collab reply`
  await collab('reply', t1, 'Yes — the client-side queue is the outbox. Renaming it now.')
  await card(t1).getByTestId('agent-msg').waitFor({ timeout: 5000 })
  await sleep(300)
  await shot(page, 'agent-reply', [await bb(intro), await bb(card(t1))], { l: 30, r: 20, t: 40, b: 40 })

  // ---- agent fixes it, resolves → hidden; "show N resolved" → resolved card
  await collab('replace-text', 'client-side queue', 'outbox')
  await collab('reply', t1, 'Renamed to "outbox".', '--resolve')
  await waitFor(() => card(t1).count(), (n) => n === 0, 5000)
  await clickAway(page)
  await sleep(3000) // let the agent-edit flash fade
  await page.evaluate(() => window.scrollTo(0, 0))
  await sleep(300)
  await shot(page, 'resolved-hidden', [await panelHead(page), await bb(intro)], { l: 10, r: 10, t: 10, b: 30 })
  await page.getByTestId('toggle-resolved').click()
  await card(t1).waitFor({ timeout: 3000 })
  await sleep(400)
  await shot(page, 'resolved', [await panelHead(page), await bb(card(t1)), await bb(intro)], { l: 10, r: 10, t: 10, b: 30 })
  await page.getByTestId('toggle-resolved').click()
  await sleep(200)

  // ---- review round: two drafts + "Send 2 to agent"
  await page.getByTestId('mode-review').click()
  await scrollToText(page, 'silently')
  {
    const b = await textBox(page, 'silently')
    await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2)
  }
  await page.getByTestId('bubble-comment').waitFor({ state: 'visible', timeout: 3000 })
  await page.getByTestId('bubble-comment').click()
  await compose(page, 'Silently = no banner at all, or just no toast?', 'question')
  const tD1 = await submit(page)
  await selectText(page, 'Never lose a note written offline')
  await page.keyboard.press('Meta+Alt+KeyM')
  await compose(page, 'Too absolute — what about a wiped device?')
  const tD2 = await submit(page)
  await page.reload()
  await page.locator('.tiptap h1').waitFor({ timeout: 15000 })
  await card(tD1).waitFor({ timeout: 5000 })
  await sleep(600)
  {
    const p = (await panelHead(page))!
    const goals = (await bb(page.locator('.tiptap ul').first()))!
    await shot(page, 'review-drafts', [p, goals, await bb(card(tD1)), await bb(card(tD2)), await bb(page.locator('.tiptap h1'))], { l: 20, r: 20, t: 10, b: 30 })
  }
  w = waitBg()
  await waitFor(() => badge(page), (t) => !t.includes('not'), 8000)
  await page.getByTestId('send-review').click()
  await w

  // ---- Ask agent: sent immediately even in review mode, agent answers
  w = waitBg()
  await waitFor(() => badge(page), (t) => !t.includes('not'), 8000)
  await selectText(page, 'of reconnecting')
  await page.getByTestId('bubble-ask').hover()
  await sleep(200)
  const askLi = page.locator('.tiptap li', { hasText: 'of reconnecting' })
  await page.getByTestId('bubble-ask').click()
  await compose(page, 'Is 10 s realistic on 3G?')
  const tAsk = await submit(page)
  const ev = await w
  await collab('reply', tAsk, 'Measured p95 is 6 s on 3G for 200 notes; I will add that as a footnote.')
  await card(tAsk).getByTestId('agent-msg').waitFor({ timeout: 5000 })
  await sleep(300)
  await shot(page, 'ask-agent', [await bb(askLi), await bb(card(tAsk)), await bb(page.locator('.tiptap h2', { hasText: 'Goals' }))], { l: 50, r: 20, t: 20, b: 40 })
  console.log('ask event:', ev.json?.events?.[0]?.type, 'ask=', ev.json?.events?.[0]?.ask)

  // ---- block comment via block menu
  await page.getByTestId('mode-now').click()
  await clickAway(page)
  const para = page.locator('.tiptap p', { hasText: 'We merge at' })
  await para.scrollIntoViewIfNeeded()
  await page.evaluate(() => {
    const p = Array.from(document.querySelectorAll('.tiptap p')).find((e) => e.textContent!.includes('We merge at'))!
    p.scrollIntoView({ block: 'center' })
  })
  await sleep(250)
  {
    const pb = (await bb(para))!
    await page.mouse.move(pb.x + 40, pb.y + pb.height / 2)
    await sleep(250)
  }
  await sleep(2500) // let the "Sent to the agent" toast go
  {
    const pb = (await bb(para))!
    await page.mouse.move(pb.x + 60, pb.y + pb.height / 2)
    await sleep(250)
  }
  await page.getByTestId('bh-grip').click()
  await page.getByTestId('bm-comment').waitFor()
  await page.getByTestId('bm-comment').hover()
  await sleep(250)
  {
    const menu = await page.getByTestId('bm-comment').evaluate((e) => {
      const m = (e.closest('[role="menu"]') ?? e.parentElement) as HTMLElement
      const r = m.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    await shot(page, 'block-menu', [await bb(para), menu, await bb(page.getByTestId('bh-grip'))], { l: 30, r: 30, t: 30, b: 30 })
  }
  await page.getByTestId('bm-comment').click()
  w = waitBg()
  await compose(page, 'Mention the retry backoff here.', 'change')
  const tBlock = await submit(page)
  await w
  await page.evaluate(() => {
    const p = Array.from(document.querySelectorAll('.tiptap p')).find((e) => e.textContent!.includes('We merge at'))!
    p.scrollIntoView({ block: 'center' })
  })
  await sleep(300)
  {
    // click into a nearby heading: clears the block's node selection so only the comment outline remains
    const t = await textBox(page, 'Open tasks')
    await page.mouse.click(t.x + t.width - 2, t.y + t.height / 2)
  }
  await sleep(400)
  await shot(page, 'block-comment', [await bb(para), await bb(card(tBlock))], { l: 30, r: 20, t: 50, b: 50 })

  // ---- SVG label comment: click label → island "comment" → agent renames label + replies
  const fig = page.locator('.island[data-island-kind="figure"]')
  await page.evaluate(() => document.querySelector('.island[data-island-kind="figure"]')!.scrollIntoView({ block: 'center' }))
  await sleep(300)
  const lb = await page.evaluate(() => {
    const host = document.querySelector('.island[data-island-kind="figure"] .island-host') as HTMLElement
    const el = Array.from(host.shadowRoot!.querySelectorAll('svg text')).find((e) => e.textContent === 'Outbox queue')!
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await page.mouse.click(lb.x, lb.y)
  await fig.locator('.island-host').locator('[data-testid="svg-overlay"]').waitFor({ timeout: 3000 })
  w = waitBg()
  await fig.getByTestId('island-comment').click()
  await compose(page, 'Call it "Outbox (SQLite)" to match section 3.', 'change')
  const tLabel = await submit(page)
  await w
  await clickAway(page)
  await page.evaluate(() => document.querySelector('.island[data-island-kind="figure"]')!.scrollIntoView({ block: 'center' }))
  await sleep(400)
  await shot(page, 'island-label', [await bb(fig), await bb(card(tLabel))], { l: 30, r: 20, t: 40, b: 40 })
  await collab('set-island-text', '>Outbox queue<', '>Outbox (SQLite)<')
  await collab('reply', tLabel, 'Renamed the label to "Outbox (SQLite)".')
  await card(tLabel).getByTestId('agent-msg').waitFor({ timeout: 5000 })
  await sleep(3000) // let the agent-edit flash fade
  await page.evaluate(() => document.querySelector('.island[data-island-kind="figure"]')!.scrollIntoView({ block: 'center' }))
  await sleep(500)
  await shot(page, 'island-label-renamed', [await bb(fig), await bb(card(tLabel))], { l: 30, r: 20, t: 40, b: 40 })

  // ---- orphan: delete the commented text → "Detached"
  await selectText(page, 'Never lose a note written offline')
  await page.keyboard.press('Backspace')
  await page.getByTestId(`orphan-${tD2}`).waitFor({ timeout: 4000 })
  await page.getByTestId('orphans').scrollIntoViewIfNeeded()
  await sleep(400)
  {
    const o = (await bb(page.getByTestId('orphans')))!
    const p = (await bb(page.getByTestId('comments-panel')))!
    await page.screenshot({ path: path.join(outDir, '06-detached.png'), clip: { x: p.x - 20, y: Math.max(0, o.y - 260), width: W - p.x + 20, height: Math.min(H, o.y + o.height + 30) - Math.max(0, o.y - 260) } })
    console.log('wrote 06-detached.png')
  }
} finally {
  for (const p of procs) p.kill()
  await browser?.close()
  if (server) await server.stop()
  fs.rmSync(tmp, { recursive: true, force: true })
}
