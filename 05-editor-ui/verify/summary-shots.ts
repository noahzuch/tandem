// npx tsx verify/summary-shots.ts — screenshots of every editor UI feature for ../SUMMARY.html.
// Starts its own server on a temp copy of the sample, drives the UI like verify.ts, writes ../summary-img/05-*.png.
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { root, startServer } from '../lib/serverProc.ts'

const outDir = path.resolve(root, '../summary-img')
fs.mkdirSync(outDir, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike05-shots-'))
const doc = path.join(tmp, 'spec.html')
fs.copyFileSync(path.resolve(root, '../samples/spec.html'), doc)

const W = 1360
async function shotAround(page: Page, name: string, box: { y: number; height: number }, above = 120, below = 120) {
  const y = Math.max(0, box.y - above)
  await page.screenshot({ path: path.join(outDir, `05-${name}.png`), clip: { x: 0, y, width: W, height: box.height + above + below } })
  console.log('wrote', name)
}
async function newParagraph(page: Page) {
  await page.evaluate(() => {
    const ed = (window as any).__editor
    const last = ed.state.doc.lastChild
    const end = ed.state.doc.content.size
    if (last.type.name === 'paragraph' && last.content.size === 0) ed.chain().setTextSelection(end - 1).run()
    else ed.chain().insertContentAt(end, { type: 'paragraph' }).setTextSelection(end + 1).run()
    ed.view.focus()
    const c = ed.view.coordsAtPos(ed.state.selection.from)
    window.scrollBy(0, c.top - window.innerHeight / 3)
  })
  await page.waitForTimeout(80)
}
async function selectText(page: Page, locator: ReturnType<Page['locator']>, text: string) {
  const box = await locator.evaluate((el, t) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let n: Node | null
    while ((n = walker.nextNode())) {
      const i = n.textContent!.indexOf(t)
      if (i >= 0) {
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + t.length)
        const b = r.getBoundingClientRect()
        return { x1: b.left + 1, x2: b.right - 1, y: b.top + b.height / 2 }
      }
    }
    return null
  }, text)
  if (!box) throw new Error(`text not found: ${text}`)
  await page.mouse.move(box.x1, box.y)
  await page.mouse.down()
  await page.mouse.move(box.x2, box.y, { steps: 5 })
  await page.mouse.up()
}

let server: { proc: ChildProcess; url: string } | undefined
let browser: Browser | undefined
try {
  server = await startServer(doc)
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: W, height: 900 } })
  await page.goto(server.url)
  const ed = page.locator('.tiptap')
  await ed.locator('h1').first().waitFor({ timeout: 15000 })
  await page.waitForTimeout(500)
  const esc = async () => {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
  }

  // whole page: toolbar, outline, document, status bar
  await page.screenshot({ path: path.join(outDir, '05-overview.png') })

  // tooltip with shortcut
  await ed.locator('p', { hasText: 'Field technicians' }).first().click()
  await page.getByTestId('tb-bold').hover()
  await page.waitForTimeout(700)
  await page.screenshot({ path: path.join(outDir, '05-tooltip.png'), clip: { x: 0, y: 0, width: 760, height: 130 } })

  // block type dropdown
  await page.getByTestId('tb-blocktype').click()
  await page.waitForTimeout(250)
  await shotAround(page, 'blocktype', { y: 0, height: 0 }, 0, 520)
  await page.getByTestId('tb-blocktype').click()

  // table size picker
  await page.getByTestId('tb-table').click()
  await page.waitForTimeout(200)
  await page.getByTestId('tp-3x4').hover().catch(() => {})
  await page.waitForTimeout(200)
  await shotAround(page, 'table-picker', { y: 0, height: 0 }, 0, 400)
  await page.getByTestId('tb-table').click()

  // insert menu
  await page.getByTestId('tb-insert').click()
  await page.waitForTimeout(250)
  await shotAround(page, 'insert-menu', { y: 0, height: 0 }, 0, 520)
  await page.getByTestId('tb-insert').click()
  await page.waitForTimeout(150)

  // keyboard: Alt+F10 focuses the toolbar
  await ed.locator('p', { hasText: 'Field technicians' }).first().click()
  await page.waitForTimeout(120)
  await page.keyboard.press('Alt+F10')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(outDir, '05-toolbar-keyboard.png'), clip: { x: 0, y: 0, width: 760, height: 130 } })
  await esc()

  // link popover (view mode): caret in an existing link
  const adr = ed.locator('a', { hasText: 'ADR' }).first()
  await adr.scrollIntoViewIfNeeded()
  await adr.click()
  await page.waitForTimeout(300)
  await shotAround(page, 'link-view', (await adr.boundingBox())!, 60, 110)

  // link editor (⌘K on a selection)
  const intro = ed.locator('p', { hasText: 'Field technicians lose connectivity' })
  await selectText(page, intro, 'Field technicians')
  await page.keyboard.press('ControlOrMeta+k')
  await page.waitForTimeout(250)
  await shotAround(page, 'link-edit', (await intro.boundingBox())!, 60, 120)
  await esc()

  // code block: highlighting + language picker
  const pre = ed.locator('pre').first()
  await pre.scrollIntoViewIfNeeded()
  await page.waitForTimeout(150)
  await shotAround(page, 'code-block', (await pre.boundingBox())!, 30, 30)

  // drag handle on hover
  const nonGoals = ed.locator('h3#non-goals')
  await nonGoals.scrollIntoViewIfNeeded()
  const ng = (await nonGoals.boundingBox())!
  await page.mouse.move(ng.x + 40, ng.y + ng.height / 2)
  await page.waitForTimeout(300)
  await shotAround(page, 'drag-handle', ng, 60, 60)

  // input rules: type markdown, show the resulting blocks
  await newParagraph(page)
  const startY = await page.evaluate(() => {
    const v = (window as any).__editor.view
    return v.coordsAtPos(v.state.selection.from).top
  })
  await page.keyboard.type('## Heading typed as "## "')
  await newParagraph(page)
  await page.keyboard.type('- [ ] Task typed as "- [ ] "')
  await newParagraph(page)
  await page.keyboard.type('> Quote typed as "> "')
  await newParagraph(page)
  await page.keyboard.type('Typed **bold**, `code`, ==highlight== and --port stays as typed')
  await page.waitForTimeout(150)
  const blocks = await page.evaluate(() => {
    const v = (window as any).__editor.view
    return v.coordsAtPos(v.state.selection.from).top
  })
  const y0 = await page.evaluate(() => window.scrollY)
  void y0
  await page.screenshot({ path: path.join(outDir, '05-input-rules.png'), clip: { x: 0, y: Math.max(0, Math.min(startY, blocks) - 330), width: W, height: 420 } })

  // placeholder on an empty line
  await newParagraph(page)
  await page.waitForTimeout(150)
  const caretY = await page.evaluate(() => {
    const v = (window as any).__editor.view
    return v.coordsAtPos(v.state.selection.from).top
  })
  await page.screenshot({ path: path.join(outDir, '05-placeholder.png'), clip: { x: 0, y: Math.max(0, caretY - 60), width: W, height: 120 } })

  // slash menu inside a table → table operations listed
  await page.keyboard.type('/table')
  await page.getByTestId('slash-menu').waitFor()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  await page.keyboard.type('/')
  await page.getByTestId('slash-menu').waitFor()
  await page.keyboard.type('row')
  await page.waitForTimeout(250)
  const sm = (await page.getByTestId('slash-menu').boundingBox())!
  await shotAround(page, 'slash-in-table', sm, 220, 30)
  await esc()
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')

  // outline sidebar with the current section highlighted
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.getByTestId('outline-tasks').click()
  await page.waitForTimeout(800)
  const ol = (await page.getByTestId('outline').boundingBox())!
  await page.screenshot({ path: path.join(outDir, '05-outline.png'), clip: { x: 0, y: Math.max(0, ol.y - 10), width: Math.min(W, ol.x + ol.width + 420), height: Math.min(ol.height + 20, 560) } })

  // status bar: word/character count, selection count
  await selectText(page, ed.locator('h2#tasks'), 'Open tasks')
  await page.waitForTimeout(200)
  const sbar = (await page.getByTestId('statusbar').boundingBox())!
  await page.screenshot({ path: path.join(outDir, '05-statusbar.png'), clip: { x: 0, y: sbar.y - 4, width: W, height: sbar.height + 8 } })
} finally {
  await browser?.close()
  server?.proc.kill()
}
