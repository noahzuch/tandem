// npx tsx verify/summary-shots.ts — screenshots of the shell features for ../SUMMARY.html.
// Own server on a free port, temp copy of demo/, drives the real UI; writes ../summary-img/09-*.png.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'
import { root, startServer, type ServerHandle } from '../lib/serverProc.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const outDir = path.resolve(root, '../summary-img')
fs.mkdirSync(outDir, { recursive: true })
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike09-summary-'))
for (const f of ['spec.html', 'decisions.md', 'banner-mockup.html']) fs.copyFileSync(path.join(root, 'demo', f), path.join(dir, f))
fs.mkdirSync(path.join(dir, '.collab'))
fs.copyFileSync(path.join(root, 'demo/spec.html.shell.json'), path.join(dir, '.collab/spec.html.shell.json'))

const W = 1360
const H = 900
type Box = { x: number; y: number; width: number; height: number }
async function shot(page: Page, name: string, clip?: Box) {
  const c = clip ? { x: Math.max(0, clip.x), y: Math.max(0, clip.y), width: Math.min(W - Math.max(0, clip.x), clip.width), height: Math.min(H - Math.max(0, clip.y), clip.height) } : undefined
  await page.screenshot({ path: path.join(outDir, `09-${name}.png`), clip: c })
  console.log('wrote', `09-${name}.png`)
}
const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!

let srv: ServerHandle | undefined
let browser: Browser | undefined
try {
  srv = await startServer(path.join(dir, 'spec.html'))
  const url = srv.url
  const collab = (...a: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'bin/collab.ts', '--server', url, ...a], { cwd: root, encoding: 'utf8' })
  const journalDemo = () => spawnSync(process.execPath, ['--import', 'tsx', 'demo/journal-demo.ts', path.join(dir, 'decisions.md')], { cwd: root, encoding: 'utf8' })

  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  await page.goto(`${url}/?user=Noah&color=%232a7de1`)
  await page.waitForSelector('[data-entry="D-1"]')
  await sleep(900)

  // 1. overview: header, journal left, spec center, comments right (with one agent comment)
  collab('comment', 'mark overlapping edits', 'Should the banner show both versions side by side? See D-5.')
  await page.locator('.tiptap h2', { hasText: '4. Conflict handling' }).scrollIntoViewIfNeeded()
  await page.evaluate(() => window.scrollBy(0, 200))
  await sleep(700)
  await shot(page, 'overview')

  // 2. journal: type filter chips + search
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.click('[data-testid="jf-decision"]')
  await page.fill('[data-testid="jv-search"]', 'merge')
  await sleep(400)
  const left = await box(page, '[data-testid="sidebar-left"]')
  const lastEntry = await page.$$eval('[data-testid="panel-journal"] [data-entry]', (els) => Math.max(...els.map((e) => e.getBoundingClientRect().bottom)))
  await shot(page, 'journal-filter', { x: 0, y: 0, width: left.width + 20, height: Math.min(H, lastEntry + 24) })
  await page.fill('[data-testid="jv-search"]', '')
  await page.click('[data-testid="jf-all"]')
  await sleep(200)

  // 3. reference in the spec: hover (decorated D-N, native title tooltip), click → journal jumps to the entry and highlights it
  const ref = page.locator('.tiptap .jref[data-jref="D-3"]').first()
  await ref.scrollIntoViewIfNeeded()
  await page.evaluate(() => window.scrollBy(0, 150))
  await ref.click()
  await sleep(1000)
  await ref.hover()
  await sleep(200)
  // headless screenshots do not paint native `title` tooltips: draw the element's real title text where the OS would
  const rb = (await ref.boundingBox())!
  await page.evaluate(({ x, y, t }) => {
    const d = document.createElement('div')
    d.id = 'fake-title-tip'
    d.textContent = t
    Object.assign(d.style, { position: 'fixed', left: `${x}px`, top: `${y}px`, maxWidth: '420px', padding: '4px 8px', background: '#f6f6f6', border: '1px solid #b8b8b8', borderRadius: '4px', boxShadow: '0 2px 6px rgba(0,0,0,.2)', font: '12px -apple-system, system-ui, sans-serif', color: '#222', zIndex: '9999' })
    document.body.appendChild(d)
  }, { x: rb.x + 6, y: rb.y + rb.height + 6, t: (await ref.getAttribute('title'))! })
  await shot(page, 'journal-ref', { x: 0, y: 0, width: Math.min(W, rb.x + 520), height: H })
  await page.evaluate(() => document.getElementById('fake-title-tip')?.remove())
  await page.mouse.move(W / 2, 5)

  // 4. live append while the journal is visible → new entry flashes (screenshot during the flash)
  await page.click('[data-testid="tab-activity"]')
  await page.$eval('[data-testid="panel-journal"]', (el) => el.scrollTo(0, 0))
  journalDemo() // F-8
  await page.waitForSelector('[data-entry="F-8"].flash')
  await sleep(700)
  await shot(page, 'live-append', { x: 0, y: 0, width: W, height: H })

  // 5. append while the journal tab is hidden → "+1" badge
  await page.click('[data-testid="tab-outline"]')
  await sleep(300)
  journalDemo() // D-6
  await page.waitForSelector('[data-testid="badge-journal"]')
  await sleep(300)
  const tabs = await box(page, '[data-testid="sidebar-left"] .sb-tabs')
  await shot(page, 'badge', { x: 0, y: 0, width: left.width + 40, height: tabs.y + tabs.height + 200 })
  await page.click('[data-testid="tab-journal"]')
  await sleep(600)

  const right = await box(page, '[data-testid="sidebar-right"]')
  // 7. `collab panel add` → new tab appears, opened, live markdown
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Session notes\n\n- Open: retry cap for uploads\n')
  const add = collab('panel', 'add', 'file', '--path', 'notes.md', '--title', 'Notes', '--side', 'right', '--open')
  console.log('panel add:', add.stdout.trim(), add.stderr.trim())
  await page.waitForSelector('[data-testid="panel-notes"] .md h1')
  fs.appendFileSync(path.join(dir, 'notes.md'), '- Decided: paragraph merge (D-5)\n')
  await page.waitForSelector('[data-testid="panel-notes"] .md .flash')
  await sleep(300)
  await shot(page, 'panel-add', { x: right.x - 20, y: 0, width: W - right.x + 20, height: 420 })

  // 8. journal entry comment → "sent to agent"
  await page.click('[data-testid="tab-journal"]')
  const d5 = page.locator('[data-entry="D-5"]')
  await d5.scrollIntoViewIfNeeded()
  await d5.hover()
  await page.click('[data-testid="entry-comment-D-5"]')
  await page.fill('[data-testid="entry-comment-text"]', 'Does this also cover checklists?')
  await sleep(200)
  await page.click('[data-testid="entry-comment-send"]')
  await page.waitForSelector('[data-entry="D-5"] .je-sent')
  await sleep(300)
  const db = (await d5.boundingBox())!
  await shot(page, 'journal-comment', { x: 0, y: db.y - 60, width: left.width + 20, height: db.height + 120 })

  // 9. agent / activity tab (agent calls, file changes, panel changes, the journal comment sent to the agent)
  spawnSync(process.execPath, ['--import', 'tsx', 'bin/collab.ts', '--server', url, 'patch'], {
    cwd: root,
    input: '<<<<<<< SEARCH\nRetry with exponential backoff\n=======\nRetry with exponential backoff (max 5 min)\n>>>>>>> REPLACE\n',
  })
  await page.click('[data-testid="tab-activity"]')
  await sleep(500)
  await shot(page, 'activity', { x: right.x - 20, y: 0, width: W - right.x + 20, height: 480 })

  // 10. collapsed left sidebar (rail) + agent opens the sandboxed HTML mockup panel
  await page.waitForSelector('text=sent to the agent', { state: 'detached', timeout: 8000 }).catch(() => {})
  await page.click('[data-testid="sb-collapse-left"]')
  collab('panel', 'open', 'mockup')
  await page.waitForSelector('[data-testid="panel-mockup"] iframe')
  await sleep(900)
  await shot(page, 'collapsed-mockup')
} finally {
  await browser?.close()
  await srv?.stop()
  fs.rmSync(dir, { recursive: true, force: true })
}
