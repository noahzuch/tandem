// npm run verify (part 1) — headless proof of spike 05's editor UI claims. Exits 0 when every check passes.
// Starts its own server (ephemeral port, no HMR) on a temp copy of samples/spec.html and drives the UI
// with real mouse/keyboard input (no editor API calls for the features under test).
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { root, startServer } from '../lib/serverProc.ts'

const sample = path.resolve(root, '../samples/spec.html')
const sampleBefore = fs.readFileSync(sample, 'utf8')

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike05-'))
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
const ids = Array.from(original.slice(original.indexOf('<body>')).matchAll(/\sid="([^"]+)"/g)).map((m) => m[1])
const shot = (name: string) => path.join(root, name)

/** new empty paragraph at the end of the document, caret inside (setup only — the typing under test is real keyboard input) */
async function newParagraph(page: Page) {
  await page.evaluate(() => {
    const ed = (window as any).__editor
    const last = ed.state.doc.lastChild
    const end = ed.state.doc.content.size
    // reuse StarterKit's trailing empty paragraph instead of piling up empty ones
    if (last.type.name === 'paragraph' && last.content.size === 0) ed.chain().setTextSelection(end - 1).scrollIntoView().run()
    else ed.chain().insertContentAt(end, { type: 'paragraph' }).setTextSelection(end + 1).scrollIntoView().run()
    ed.view.focus() // synchronous (Tiptap's focus command defers to the next frame)
  })
  await page.waitForTimeout(50)
}
const docJson = (page: Page) => page.evaluate(() => (window as any).__editor.getJSON())
/** the top-level blocks ending with the one holding the caret (StarterKit's TrailingNode keeps an empty <p> after it) */
const lastBlocks = (page: Page, n: number) =>
  page.evaluate((k) => {
    const st = (window as any).__editor.state
    const idx = st.selection.$from.index(0)
    const out: { type: string; text: string; child?: string }[] = []
    st.doc.forEach((node: any) => out.push({ type: node.type.name, text: node.textContent, child: node.firstChild?.type.name }))
    return out.slice(0, idx + 1).slice(-k)
  }, n)
const caretBlock = (page: Page) =>
  page.evaluate(() => {
    const st = (window as any).__editor.state
    return st.doc.child(st.selection.$from.index(0)).toJSON()
  })
const topLevelTexts = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = []
    ;(window as any).__editor.state.doc.forEach((n: any) => out.push(n.textContent.slice(0, 40)))
    return out
  })
async function selectText(page: Page, locator: ReturnType<Page['locator']>, text: string) {
  // drag-select `text` inside the element with the mouse
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
  console.log(`server: ${server.url}  doc: ${doc}`)
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
  const consoleErrors: string[] = []
  // Vite's HMR client noise when another dev server on this machine holds the default ws port is not ours
  const viteNoise = /WebSocket|\[vite\]|Vite server/
  page.on('console', (m) => m.type() === 'error' && !viteNoise.test(m.text()) && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => !viteNoise.test(String(e)) && consoleErrors.push(String(e)))
  const mod = 'ControlOrMeta'

  await page.goto(server.url)
  const ed = page.locator('.tiptap')
  await ed.locator('h1').first().waitFor({ timeout: 15000 })
  await page.locator('.island[data-island-kind="figure"]').waitFor()

  // ---------------------------------------------------------------- 1. load: toolbar, outline, counts, islands, highlighting
  check('no console errors on load', consoleErrors.length === 0, consoleErrors.join(' | '))
  check('toolbar rendered', await page.getByTestId('toolbar').isVisible())
  const svgBox = await page.evaluate(() => {
    const host = document.querySelector('.island[data-island-kind="figure"] .island-host') as HTMLElement
    const r = host?.shadowRoot?.querySelector('svg')?.getBoundingClientRect()
    return r ? { w: r.width, h: r.height, labels: host.shadowRoot!.querySelectorAll('svg text').length } : null
  })
  check('island: SVG diagram still renders as SVG (shadow root)', !!svgBox && svgBox.w > 600 && svgBox.h > 100 && svgBox.labels === 5, JSON.stringify(svgBox))
  const outlineItems = await page.locator('.outline li').allInnerTexts()
  check('outline lists the headings', outlineItems.length >= 9 && outlineItems.some((t) => t.includes('4. Conflict handling')), outlineItems.join(' | '))
  const wc = await page.getByTestId('word-count').innerText()
  check('word/character count in status bar', /^\d{3,} words · \d{4,} characters$/.test(wc), wc)
  const hl = await ed.locator('pre code .hljs-keyword').count()
  check('code block syntax-highlighted (lowlight, typescript)', hl >= 2, `${hl} keyword spans`)
  check('code block language picker shows the language', (await ed.getByTestId('code-lang').first().inputValue()) === 'typescript')
  await page.getByTestId('tb-bold').hover()
  await page.waitForTimeout(700) // tooltip delay
  await page.screenshot({ path: shot('screenshot-toolbar.png'), clip: { x: 0, y: 0, width: 1360, height: 520 } })

  // ---------------------------------------------------------------- 2. markdown input rules (real keystrokes)
  await newParagraph(page)
  await page.keyboard.type('## Input rules heading')
  let lb = await lastBlocks(page, 1)
  check('input rule "## " → heading 2', lb[0].type === 'heading' && (await ed.locator('h2', { hasText: 'Input rules heading' }).count()) === 1, `${JSON.stringify(lb)} h2s: ${(await ed.locator('h2').allInnerTexts()).join('|')}`)
  await newParagraph(page)
  await page.keyboard.type('- [ ] Task via markdown')
  lb = await lastBlocks(page, 1)
  check('input rule "- [ ] " → task list (not nested in a bullet list)', lb[0].type === 'taskList' && lb[0].text === 'Task via markdown', JSON.stringify(lb))
  await newParagraph(page)
  await page.keyboard.type('[x] Done task')
  lb = await lastBlocks(page, 1)
  const checked = (await caretBlock(page)).content[0].attrs.checked
  check('input rule "[x] " → checked task item', lb[0].type === 'taskList' && checked === true, JSON.stringify(lb))
  await newParagraph(page)
  await page.keyboard.type('> Quoted via markdown')
  lb = await lastBlocks(page, 1)
  check('input rule "> " → blockquote', lb[0].type === 'blockquote', JSON.stringify(lb))
  await newParagraph(page)
  await page.keyboard.type('- Bullet via markdown')
  lb = await lastBlocks(page, 1)
  check('input rule "- " → bullet list', lb[0].type === 'bulletList', JSON.stringify(lb))
  await newParagraph(page)
  await page.keyboard.type('1. Numbered via markdown')
  lb = await lastBlocks(page, 1)
  check('input rule "1. " → numbered list', lb[0].type === 'orderedList', JSON.stringify(lb))
  await newParagraph(page)
  await page.keyboard.type('Some **bold** and `code` and ==marked== text --port 5105 ')
  const marks = await ed.locator('p', { hasText: 'Some bold and' }).evaluate((p) => ({ b: p.querySelector('strong')?.textContent, c: p.querySelector('code')?.textContent, m: p.querySelector('mark')?.textContent, t: p.textContent }))
  check('input rules **bold**, `code`, ==highlight==', marks.b === 'bold' && marks.c === 'code' && marks.m === 'marked', JSON.stringify(marks))
  check('"--port" is not turned into an em dash (Typography emDash off)', !!marks.t?.includes('--port 5105'), marks.t ?? '')
  await newParagraph(page)
  await page.keyboard.type('---')
  lb = await lastBlocks(page, 2)
  check('input rule "---" → divider', lb.some((b) => b.type === 'horizontalRule'), JSON.stringify(lb))
  await newParagraph(page)
  await page.keyboard.type('```ts ')
  lb = await lastBlocks(page, 1)
  const lang = (await caretBlock(page)).attrs.language
  check('input rule "```ts " → code block with language', lb[0].type === 'codeBlock' && lang === 'ts', `${lb[0].type} ${lang}`)
  await page.keyboard.type('const x: number = 1')
  check('typed code gets highlighted live', (await ed.locator('pre').last().locator('.hljs-keyword').count()) >= 1)

  // ---------------------------------------------------------------- 3. slash menu: table + callout
  await newParagraph(page)
  await page.evaluate(() => {
    const v = (window as any).__editor.view
    const c = v.coordsAtPos(v.state.selection.from)
    window.scrollBy(0, c.top - window.innerHeight / 3)
  })
  await page.keyboard.type('/')
  await page.waitForTimeout(150)
  const slash = page.getByTestId('slash-menu')
  await slash.waitFor({ timeout: 3000 })
  const allItems = await slash.locator('[role="option"]').count()
  check('"/" opens the slash menu', allItems >= 15, `${allItems} items`)
  const sb = (await slash.boundingBox())!
  await page.screenshot({ path: shot('screenshot-slash.png'), clip: { x: 0, y: Math.max(0, sb.y - 120), width: 1360, height: sb.height + 180 } })
  await page.keyboard.type('tab')
  const filtered = await slash.locator('[role="option"]').allInnerTexts()
  check('typing filters the list (/tab)', filtered.length >= 1 && filtered[0].startsWith('Table'), filtered.join(' | '))
  const tablesBefore = await ed.locator('table').count()
  await page.keyboard.press('Enter')
  check('Enter on "Table" inserts a 3×3 table', (await ed.locator('table').count()) === tablesBefore + 1 && (await ed.locator('table').last().locator('tr').count()) === 3)
  check('slash text removed, menu closed', (await slash.count()) === 0 && !(await ed.innerText()).includes('/tab'))
  const table = ed.locator('table').last()

  // ---------------------------------------------------------------- 4. table menu: add row, merge, header column, resize
  const tbl = page.getByTestId('table-bubble')
  await tbl.waitFor({ timeout: 3000 })
  check('table menu appears when the caret is in a table', await tbl.isVisible())
  await page.keyboard.type('Owner')
  await page.keyboard.press('Tab')
  await page.keyboard.type('Due')
  await page.keyboard.press('Tab')
  await page.keyboard.type('State')
  await page.keyboard.press('Tab') // → first body cell
  await page.keyboard.type('Noah')
  await page.waitForTimeout(150)
  const tblBox = (await tbl.boundingBox())!
  const tableBox = (await table.boundingBox())!
  check('table menu sits above the table (not over the cells)', tblBox.y + tblBox.height <= tableBox.y + 2, `menu bottom ${Math.round(tblBox.y + tblBox.height)} vs table top ${Math.round(tableBox.y)}`)
  await page.getByTestId('tbl-addRowAfter').hover()
  await page.waitForTimeout(700)
  await page.screenshot({ path: shot('screenshot-table-menu.png'), clip: { x: 0, y: Math.max(0, tableBox.y - 140), width: 1360, height: 360 } })
  await page.getByTestId('tbl-addRowAfter').click()
  check('table menu: add row below → 4 rows', (await table.locator('tr').count()) === 4)
  // merge: click first body cell, shift-click its right neighbour → CellSelection
  const c1 = table.locator('tr').nth(1).locator('td').nth(0)
  const c2 = table.locator('tr').nth(1).locator('td').nth(1)
  await c1.click()
  await c2.click({ modifiers: ['Shift'] })
  const isCellSel = await page.evaluate(() => (window as any).__editor.state.selection.constructor.name.includes('Cell'))
  check('shift-click selects cells (CellSelection)', isCellSel)
  await page.getByTestId('tbl-mergeCells').click()
  check('table menu: merge cells → colspan=2', (await table.locator('td[colspan="2"]').count()) === 1)
  await page.getByTestId('tbl-toggleHeaderColumn').click()
  check('table menu: header column toggle', (await table.locator('tr').nth(2).locator('th').count()) === 1)
  await page.getByTestId('tbl-toggleHeaderColumn').click()
  // column resize: drag the border between column 1 and 2 of the header row
  const h1 = (await table.locator('tr').first().locator('th').first().boundingBox())!
  await page.mouse.move(h1.x + h1.width - 1, h1.y + h1.height / 2)
  await page.waitForTimeout(100)
  const handle = await ed.locator('.column-resize-handle').count()
  await page.mouse.down()
  await page.mouse.move(h1.x + h1.width + 80, h1.y + h1.height / 2, { steps: 8 })
  await page.mouse.up()
  const h1After = (await table.locator('tr').first().locator('th').first().boundingBox())!
  check('column resize handle + drag widens the column', handle >= 1 && h1After.width > h1.width + 40, `${handle} handle(s), ${Math.round(h1.width)} → ${Math.round(h1After.width)}px`)

  // ---------------------------------------------------------------- 5. slash → callout
  await newParagraph(page)
  await page.keyboard.type('/callout')
  await slash.waitFor()
  await page.keyboard.press('Enter')
  await page.keyboard.type('Callout via slash menu.')
  check('slash: callout inserted, caret inside', (await ed.locator('div.callout', { hasText: 'Callout via slash menu.' }).count()) === 1)

  // slash → raw HTML island (dialog prefilled with an SVG) and image by URL
  await newParagraph(page)
  await page.keyboard.type('/svg')
  await slash.waitFor()
  await page.keyboard.press('Enter')
  const dlg = page.getByTestId('dialog')
  await dlg.waitFor({ timeout: 2000 })
  const islandsBefore = await page.locator('.island').count()
  await page.getByTestId('dialog-submit').click()
  await page.waitForTimeout(100)
  const newIsland = page.locator('.island').nth(islandsBefore)
  const newLabels = await newIsland.evaluate((el) => Array.from(el.querySelector('.island-host')!.shadowRoot!.querySelectorAll('svg text')).map((t) => t.textContent))
  check('slash: raw HTML island inserted from the dialog, SVG renders, labels editable', (await page.locator('.island').count()) === islandsBefore + 1 && newLabels.join(',') === 'Client,Server', newLabels.join(','))
  await newParagraph(page)
  await page.keyboard.type('/image')
  await slash.waitFor()
  await page.keyboard.press('Enter')
  await page.getByTestId('dialog-src').fill('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCIvPg==')
  await page.getByTestId('dialog-alt').fill('Tiny test image')
  await page.keyboard.press('Enter')
  check('slash: image by URL (dialog, alt text)', (await ed.locator('img[alt="Tiny test image"]').count()) === 1)

  // ---------------------------------------------------------------- 6. bubble menu: bold + comment placeholder + link
  const intro = ed.locator('p', { hasText: 'Field technicians lose connectivity' })
  await intro.scrollIntoViewIfNeeded()
  await selectText(page, intro, 'Field technicians')
  const bubble = page.getByTestId('text-bubble')
  await bubble.waitFor({ timeout: 3000 })
  check('bubble menu appears on text selection', await bubble.isVisible())
  await page.screenshot({ path: shot('screenshot-bubble.png'), clip: { x: 0, y: Math.max(0, ((await intro.boundingBox())!.y) - 160), width: 1360, height: 330 } })
  await page.getByTestId('bubble-bold').click()
  check('bubble: bold applied to the selection', (await intro.locator('strong', { hasText: 'Field technicians' }).count()) === 1)
  await page.waitForTimeout(100)
  check('bubble: bold button shows active state', (await page.getByTestId('bubble-bold').getAttribute('aria-pressed')) === 'true')
  await page.getByTestId('bubble-comment').click()
  check('bubble: Comment placeholder → toast', (await page.getByTestId('toast').innerText()).includes('spike 06'))
  await page.keyboard.press(`${mod}+k`)
  const linkInput = page.getByTestId('link-input')
  await linkInput.waitFor({ timeout: 3000 })
  check('⌘K opens the link editor with focus in the URL field', await linkInput.evaluate((el) => el === document.activeElement))
  await page.keyboard.type('https://example.com/field')
  await page.keyboard.press('Enter')
  check('link applied to the selection', (await intro.locator('a[href="https://example.com/field"]', { hasText: 'Field technicians' }).count()) === 1)
  await intro.locator('a[href="https://example.com/field"]').click()
  const lp = page.getByTestId('link-popover')
  await page.locator('[data-testid="link-popover"][data-mode="view"]').waitFor({ timeout: 2000 }).catch(() => {})
  check('caret in a link → link popover (view mode)', (await lp.getAttribute('data-mode')) === 'view' && (await page.getByTestId('link-href').innerText()) === 'https://example.com/field')
  // anchor link jumps inside the doc
  await ed.locator('a[href="#conflicts"]').first().click()
  await page.getByTestId('link-open').click()
  await page.waitForTimeout(700)
  const conflictsTop = (await ed.locator('h2#conflicts').boundingBox())!.y
  check('"#anchor" link → open jumps to the heading in the editor', conflictsTop > 0 && conflictsTop < 200, `top ${Math.round(conflictsTop)}`)

  // ---------------------------------------------------------------- 7. block drag handle: drag "1.1 Non-goals" above "1. Goals"
  const goals = ed.locator('h2#goals')
  const nonGoals = ed.locator('h3#non-goals')
  await goals.scrollIntoViewIfNeeded()
  await page.evaluate(() => window.scrollBy(0, -120))
  const ngBox = (await nonGoals.boundingBox())!
  await page.mouse.move(ngBox.x + 40, ngBox.y + ngBox.height / 2)
  const grip = page.getByTestId('bh-grip')
  await page.waitForTimeout(200)
  const gripBox = (await grip.boundingBox())!
  check('drag handle appears next to the hovered block', !!gripBox && Math.abs(gripBox.y + gripBox.height / 2 - (ngBox.y + ngBox.height / 2)) < 20 && gripBox.x < ngBox.x, JSON.stringify({ grip: gripBox && { x: Math.round(gripBox.x), y: Math.round(gripBox.y) }, block: { x: Math.round(ngBox.x), y: Math.round(ngBox.y) } }))
  const gBox = (await goals.boundingBox())!
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2)
  await page.mouse.down()
  // ProseMirror's dropPoint decides before/after by the text offset inside the target block → drop at its start
  await page.mouse.move(gBox.x + 4, gBox.y + gBox.height / 2, { steps: 12 })
  await page.mouse.move(gBox.x + 2, gBox.y + gBox.height / 2, { steps: 2 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  const order = await topLevelTexts(page)
  const iNG = order.findIndex((t) => t.startsWith('1.1 Non-goals'))
  const iG = order.findIndex((t) => t.startsWith('1. Goals'))
  check('drag handle: block moved above "1. Goals"', iNG >= 0 && iG >= 0 && iNG === iG - 1, `non-goals @${iNG}, goals @${iG}`)
  check('drag handle: moved heading keeps its id', (await ed.locator('h3#non-goals').count()) === 1)
  // keyboard alternative: Alt+Shift+↓ moves it back below the goals list? → one step down = below "1. Goals"
  await nonGoals.click()
  await page.keyboard.press('Alt+Shift+ArrowDown')
  const order2 = await topLevelTexts(page)
  check('Alt+Shift+↓ moves the block down one step (keyboard drag)', order2.findIndex((t) => t.startsWith('1.1 Non-goals')) === order2.findIndex((t) => t.startsWith('1. Goals')) + 1)
  await page.keyboard.press('Alt+Shift+ArrowUp')
  check('Alt+Shift+↑ moves it back up', (await topLevelTexts(page)).findIndex((t) => t.startsWith('1.1 Non-goals')) === iNG)

  // block menu (click on the grip): duplicate + delete
  const ngNow = (await nonGoals.boundingBox())!
  await page.mouse.move(ngNow.x + 40, ngNow.y + ngNow.height / 2)
  await page.waitForTimeout(150)
  await page.getByTestId('bh-grip').click()
  const bm = page.getByTestId('block-menu')
  await bm.waitFor({ timeout: 2000 })
  check('click on the grip opens the block menu (focus on first entry)', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'bm-paragraph'))
  const bmBox = (await bm.boundingBox())!
  await page.screenshot({ path: shot('screenshot-block-menu.png'), clip: { x: 0, y: Math.max(0, ngNow.y - 60), width: 1360, height: bmBox.height + 120 } })
  await page.getByTestId('bm-duplicate').click()
  const ngCopies = ed.locator('h3', { hasText: '1.1 Non-goals' })
  check('block menu: duplicate (copy gets no duplicate id)', (await ngCopies.count()) === 2 && (await ed.locator('h3#non-goals').count()) === 1)
  const copyBox = (await ngCopies.nth(1).boundingBox())!
  await page.mouse.move(copyBox.x + 40, copyBox.y + copyBox.height / 2)
  await page.waitForTimeout(150)
  await page.getByTestId('bh-grip').click()
  await page.getByTestId('bm-deleteBlock').click()
  check('block menu: delete block', (await ngCopies.count()) === 1 && (await ed.locator('h3#non-goals').count()) === 1)

  // ---------------------------------------------------------------- 8. outline (TOC) click
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.getByTestId('outline-tasks').click()
  await page.waitForTimeout(800)
  const tasksTop = (await ed.locator('h2#tasks').boundingBox())!.y
  const selInTasks = await page.evaluate(() => (window as any).__editor.state.selection.$from.parent.textContent)
  check('outline click scrolls to the heading and puts the caret there', tasksTop > 40 && tasksTop < 160 && selInTasks === '5. Open tasks', `top ${Math.round(tasksTop)}, caret in "${selInTasks}"`)
  check('outline highlights the current section', (await page.getByTestId('outline-tasks').getAttribute('class'))?.includes('active') === true)
  const outlineNow = await page.locator('.outline li').allInnerTexts()
  check('outline follows edits (new heading from input rule listed)', outlineNow.some((t) => t.includes('Input rules heading')))

  // ---------------------------------------------------------------- 9. keyboard-only: help, toolbar focus, block type dropdown
  await page.keyboard.press(`${mod}+/`)
  const help = page.getByTestId('help')
  await help.waitFor({ timeout: 2000 })
  const helpText = await help.innerText()
  check('⌘/ opens the shortcut help (from the registry)', helpText.includes('Bold') && helpText.includes('Move block up') && helpText.includes('##'))
  await page.screenshot({ path: shot('screenshot-help.png') })
  await page.keyboard.press('Escape')
  check('Esc closes the help', (await help.count()) === 0)
  await ed.locator('p', { hasText: 'Field technicians' }).first().click()
  await page.waitForTimeout(100) // ProseMirror reads the DOM selection on the async selectionchange event
  await page.keyboard.press('Alt+F10')
  const focused1 = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  const focused2 = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
  check('Alt+F10 focuses the toolbar, ←/→ moves between controls', focused1 === 'tb-undo' && focused2 === 'tb-blocktype', `${focused1} → ${focused2}`)
  await page.keyboard.press('Enter') // opens the block type menu, focus on the active entry
  await page.getByTestId('tb-blocktype-menu').waitFor()
  await page.keyboard.press('ArrowDown') // Text → Heading 1
  await page.keyboard.press('ArrowDown') // → Heading 2
  await page.keyboard.press('ArrowDown') // → Heading 3
  await page.keyboard.press('Enter')
  await page.waitForTimeout(100)
  check('keyboard: block type menu turns the paragraph into Heading 3', (await ed.locator('h3', { hasText: 'Field technicians lose connectivity' }).count()) === 1)
  check('focus returns to the text after picking', await page.evaluate(() => document.activeElement === (window as any).__editor.view.dom))
  await page.keyboard.press(`${mod}+z`)
  check('⌘Z undoes the block type change', (await ed.locator('p', { hasText: 'Field technicians lose connectivity' }).count()) === 1)
  check('no console errors during UI checks', consoleErrors.length === 0, consoleErrors.join(' | '))

  // ---------------------------------------------------------------- 10. save → HTML on disk
  await page.keyboard.press(`${mod}+s`)
  await page.getByTestId('status').filter({ hasText: /^Saved \d/ }).waitFor({ timeout: 5000 })
  const saved = fs.readFileSync(doc, 'utf8')
  fs.mkdirSync(path.join(root, '.work'), { recursive: true })
  fs.writeFileSync(path.join(root, '.work/verify-saved.html'), saved) // for inspection
  check('saved: heading from input rule', /<h2>Input rules heading<\/h2>/.test(saved))
  check('saved: task items (unchecked + checked)', /<li data-checked="false" data-type="taskItem">\s*<label><input type="checkbox" \/><span><\/span><\/label>\s*<div><p>Task via markdown<\/p><\/div>/.test(saved) && /<li data-checked="true" data-type="taskItem">[\s\S]{0,120}<p>Done task<\/p>/.test(saved))
  check('saved: blockquote, bullet, numbered, divider', /<blockquote>\s*<p>Quoted via markdown/.test(saved) && /<ul>\s*<li>\s*<p>Bullet via markdown/.test(saved) && /<ol>\s*<li>\s*<p>Numbered via markdown/.test(saved) && /<hr \/>|<hr>/.test(saved))
  check('saved: code block with language class', /<pre><code class="language-ts">const x: number = 1<\/code><\/pre>/.test(saved))
  check('saved: no highlight markup in the file (hljs spans are decorations only)', !saved.includes('hljs'))
  const savedTable = saved.slice(saved.lastIndexOf('<table'), saved.lastIndexOf('</table>'))
  check('saved: new table with 4 rows, merged cell, header row', (savedTable.match(/<tr/g) ?? []).length === 4 && /colspan="2"/.test(savedTable) && /<th[^>]*>\s*<p>Owner<\/p>/.test(savedTable), `${(savedTable.match(/<tr/g) ?? []).length} rows`)
  check('saved: resized column width persisted (colwidth)', /colwidth="\d+"/.test(savedTable))
  check('saved: callout from slash menu', /<div class="callout info" data-kind="info">\s*<p>Callout via slash menu\.<\/p>/.test(saved))
  check('saved: bold + link from bubble/⌘K', /<a href="https:\/\/example\.com\/field"><strong>Field technicians<\/strong><\/a>|<strong><a href="https:\/\/example\.com\/field">Field technicians<\/a><\/strong>/.test(saved))
  check('saved: dragged block order (non-goals before goals)', saved.indexOf('id="non-goals"') < saved.indexOf('id="goals"'))
  check('saved: island SVG byte-identical', between(saved, '<svg', '</svg>') === origSvg)
  check('saved: inserted island verbatim + image', saved.includes('<text x="250" y="45" text-anchor="middle" font-family="system-ui" font-size="14">Server</text>') && /<img[^>]*alt="Tiny test image"/.test(saved))
  const missing = ids.filter((id) => !saved.includes(`id="${id}"`))
  check(`saved: all ${ids.length} ids survive`, missing.length === 0, missing.join(', '))
  check('saved: no UI attributes leaked (data-toc-id, placeholder, drag handle, suggestion)', !/data-toc-id|data-placeholder|is-empty|drag-handle|class="suggestion"|data-raw-island/.test(saved))
  check('saved: <head> preserved byte-for-byte', saved.startsWith(originalHead))

  // ---------------------------------------------------------------- 11. reload
  await page.reload()
  await page.locator('.island[data-island-kind="figure"]').waitFor()
  const labels = await page.evaluate(() => {
    const host = document.querySelector('.island[data-island-kind="figure"] .island-host') as HTMLElement
    return host.shadowRoot!.querySelectorAll('svg text').length
  })
  const merged = await ed.locator('td[colspan="2"]').allInnerTexts()
  check('reload: island SVG renders again, merged cell still there', labels === 5 && merged.includes('Noah'), `${labels} labels, merged: ${merged.join('|')}`)
  check('no console errors at all', consoleErrors.length === 0, consoleErrors.join(' | '))
} catch (e) {
  console.error(e)
  failures++
} finally {
  await browser?.close()
  server?.proc.kill('SIGTERM')
  fs.rmSync(tmp, { recursive: true, force: true })
}
check('shared sample unchanged', fs.readFileSync(sample, 'utf8') === sampleBefore)

console.log(failures === 0 ? '\nverify (UI): ALL PASS' : `\nverify (UI): ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
