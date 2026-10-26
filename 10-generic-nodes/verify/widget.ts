// Spike 10 round 2 — delete UI measurement. Opens samples/battle.html in plain mode and, for the same four cases
// as round 1 (diagram box, x-card, SVG island, hard CSS), hovers the element, hovers the trash button and records
// what the preview shows: the union overlay rect, the summary text, and per descendant (round 1's collectBoxes)
// why it can or cannot be drawn. Then the keyboard path (select → Backspace → confirm bar → Enter) and the block
// menu alternative. Takes the README screenshots (screenshot-widget-*.png; round 1's are screenshot-v1-widget-*.png).
// Writes verify/widget-findings.md. Exits 1 when a documented expectation fails.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { root, startServer, freePort, type ServerHandle } from '../lib/serverProc.ts'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike10-widget-'))
const doc = path.join(tmp, 'battle.html')
fs.copyFileSync(path.join(root, 'samples/battle.html'), doc)

interface Box {
  tag: string
  rect: { x: number; y: number; w: number; h: number } | null
  notes: string[]
  text: string
}
interface Preview {
  rect: { x: number; y: number; w: number; h: number } | null
  elements: number
  words: number
  hidden: number
  offscreen: number
  noBox: number
  outside: number
  summary: string
}

let server: ServerHandle | undefined
let browser: Browser | undefined
const findings: string[] = []
const r0 = (r: { x: number; y: number; w: number; h: number } | null) => (r ? `${Math.round(r.w)}×${Math.round(r.h)} at ${Math.round(r.x)},${Math.round(r.y)}` : 'none')
try {
  server = await startServer(doc, await freePort())
  browser = await chromium.launch()
  const page: Page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  await page.goto(`${server.url}/?collab=0`)
  await page.locator('.tiptap h1').first().waitFor({ timeout: 15000 })
  await sleep(300)
  await page.evaluate(() => ((window as any).__ui = { outline: false }))

  /** hover a node (on its own padding, not a child), hover the trash button, return preview + boxes; screenshot */
  async function widgetOn(selector: string, shotName: string | null, at: 'bottom-right' | 'top-left' = 'bottom-right'): Promise<{ preview: Preview; boxes: Box[]; overlay: number; label: string }> {
    const el = page.locator(selector).first()
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' })) // clear of the fixed status bar
    await sleep(100)
    const b = (await el.boundingBox())!
    if (at === 'bottom-right') await page.mouse.move(b.x + b.width - 6, b.y + b.height - 6)
    else await page.mouse.move(b.x + Math.min(40, b.width / 2), b.y + Math.min(14, b.height / 2))
    await sleep(150)
    const btn = page.getByTestId('delete-widget')
    await btn.waitFor({ state: 'visible', timeout: 2000 })
    await btn.hover()
    await sleep(150)
    const boxes = (await page.evaluate((sel) => (window as any).__deleteWidget.inspect(document.querySelector(sel)), selector)) as Box[]
    const preview = (await page.evaluate((sel) => (window as any).__deleteWidget.previewFor(document.querySelector(sel)), selector)) as Preview
    const label = (await page.getByTestId('delete-summary').textContent()) ?? ''
    const overlay = await page.locator('.dw-overlay').count()
    if (shotName) {
      const bb = (await el.boundingBox())!
      await page.screenshot({ path: path.join(root, shotName), clip: { x: Math.max(0, bb.x - 30), y: Math.max(0, bb.y - 36), width: Math.min(1100, bb.width + 60), height: Math.min(900, bb.height + 70) } })
    }
    await page.mouse.move(5, 5)
    await sleep(200)
    return { preview, boxes, overlay, label }
  }

  // 1. diagram box (free, absolutely positioned children)
  const box = await widgetOn('.tiptap .diagram-box', 'screenshot-widget-diagram-box.png')
  check('diagram box: the trash button targets the box itself (hovered on its own padding)', box.label.startsWith('Delete <div>'), box.label)
  check('diagram box: summary counts 6 elements inside and the words', /6 elements inside · \d+ words/.test(box.label), box.label)
  check('diagram box: one overlay drawn, union = the box itself (children are inside it)', box.overlay === 1 && !!box.preview.rect && box.preview.outside === 0 && box.preview.rect.h >= 160, `${r0(box.preview.rect)} outside=${box.preview.outside}`)
  const tilt = box.boxes.find((b) => b.notes.some((n) => n.startsWith('transformed')))
  check('diagram box: the rotated arrow is still reported (measurement) but no longer drawn separately', !!tilt, JSON.stringify(tilt?.notes))
  findings.push(`diagram box: ${box.label}; overlay ${r0(box.preview.rect)}; ${box.boxes.length} descendants measured, ${box.preview.noBox} without a box`)

  // 2. the free x-card: hovering its text targets the innermost element (x-note); hovering the card's padding the card
  const note = await widgetOn('.tiptap x-card[data-v="1"] x-note', null, 'top-left')
  check('x-card: hovering the note targets <x-note> (innermost element)', note.label.startsWith('Delete <x-note>'), note.label)
  const card = await widgetOn('.tiptap x-card[data-v="1"]', 'screenshot-widget-card.png')
  check('x-card: hovering the card padding targets <x-card>, summary counts title, note, <em>, <x-badge>', card.label.startsWith('Delete <x-card>') && card.preview.elements === 4, card.label)
  findings.push(`x-card: ${card.label}; overlay ${r0(card.preview.rect)}`)

  // 3. the island (shadow root) with the SVG: one overlay over the figure; zero-geometry <g>/<line>/<defs> no longer matter
  const fig = await widgetOn('.tiptap .island[data-island-kind="svg"]', 'screenshot-widget-island.png')
  check('island: one overlay over the island host; the summary counts every SVG element incl. <g>/<line>/<defs>', fig.overlay === 1 && fig.preview.elements === fig.boxes.length && fig.boxes.length >= 12, `${fig.label} (${fig.boxes.length} measured)`)
  check('island: the elements without a box (zero-geometry strokes, defs) are not a visual problem any more (noBox counted, overlay complete)', fig.preview.noBox >= 3 && !!fig.preview.rect && fig.preview.rect.w >= 600, `noBox=${fig.preview.noBox} ${r0(fig.preview.rect)}`)
  findings.push(`island figure: ${fig.label}; overlay ${r0(fig.preview.rect)}; no box: ${fig.boxes.filter((b) => !b.rect).map((b) => `<${b.tag}>`).join(', ')}`)

  // 4. hard CSS: display:contents, overflow, zero size, grid, off-screen, visibility:hidden, rotated
  const hard = await widgetOn('.tiptap .hard', 'screenshot-widget-hard-css.png')
  check('hard: the summary says what the overlay cannot show (1 hidden, 1 off-screen)', hard.preview.hidden === 1 && hard.preview.offscreen === 1 && /1 hidden · 1 off-screen/.test(hard.label), hard.label)
  check('hard: the overlay stays on-screen (the off-screen child does not stretch the union to -9999px)', !!hard.preview.rect && hard.preview.rect.x > 0 && hard.preview.rect.w < 1100, r0(hard.preview.rect))
  const contents = hard.boxes.find((b) => b.notes.some((n) => n.startsWith('display:contents')))
  const clipped = hard.boxes.find((b) => b.notes.some((n) => n.includes('clipped by overflow')))
  check('hard: display:contents wrapper and overflow clipping are still measured (collectBoxes unchanged)', !!contents && !!clipped?.rect && clipped.rect.h <= 26, JSON.stringify([contents?.notes, clipped?.rect]))
  findings.push(`hard css: ${hard.label}; overlay ${r0(hard.preview.rect)}`)
  for (const b of hard.boxes) findings.push(`  <${b.tag}> "${b.text.slice(0, 28)}" → ${b.rect ? `${Math.round(b.rect.w)}×${Math.round(b.rect.h)}` : 'no box'}${b.notes.length ? ' — ' + b.notes.join('; ') : ''}`)

  // 5. keyboard path: click into a diagram node → Escape selects the node → Escape again selects the box → Backspace arms → screenshot → Enter deletes → undo
  const nodeEl = page.locator('.tiptap .diagram-box .node').first()
  await nodeEl.evaluate((e) => e.scrollIntoView({ block: 'center' }))
  const nb = (await nodeEl.boundingBox())!
  await page.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2)
  await sleep(100)
  await page.keyboard.press('Escape')
  await sleep(60)
  const sel1 = await page.evaluate(() => { const s = (window as any).__editor.state.selection; return s.node ? `node:${s.node.attrs.tag}.${s.node.attrs.attrs?.class ?? s.node.attrs.htmlAttrs?.class ?? ''}` : 'text' })
  await page.keyboard.press('Escape')
  await sleep(60)
  const sel2 = await page.evaluate(() => { const s = (window as any).__editor.state.selection; return s.node ? `node:${s.node.attrs.tag}.${s.node.attrs.attrs?.class ?? s.node.attrs.htmlAttrs?.class ?? ''}` : 'text' })
  check('keyboard: Escape selects the <div class="node">, Escape again its parent <div class="diagram-box">', sel1 === 'node:div.node' && sel2 === 'node:div.diagram-box', `${sel1} → ${sel2}`)
  await page.keyboard.press('Backspace')
  await sleep(150)
  const bar = page.getByTestId('delete-bar')
  check('keyboard: Backspace on the selected element shows the confirm bar instead of deleting', await bar.isVisible(), (await bar.textContent()) ?? '')
  check('keyboard: focus is on the Delete button (Enter confirms, Esc keeps)', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'delete-confirm'))
  const bb = (await page.locator('.tiptap .diagram-box').boundingBox())!
  await page.screenshot({ path: path.join(root, 'screenshot-widget-keyboard.png'), clip: { x: Math.max(0, bb.x - 30), y: Math.max(0, bb.y - 36), width: Math.min(1100, bb.width + 60), height: Math.min(900, bb.height + 110) } })
  await page.keyboard.press('Escape')
  await sleep(100)
  check('keyboard: Esc keeps the element', !(await bar.isVisible()) && (await page.locator('.tiptap .diagram-box').count()) === 1)
  await page.keyboard.press('Backspace')
  await sleep(150)
  await page.keyboard.press('Enter')
  await sleep(150)
  check('keyboard: Backspace → Enter deletes the diagram box (structure-unlock meta)', (await page.locator('.tiptap .diagram-box').count()) === 0)
  await page.keyboard.press('ControlOrMeta+z')
  await sleep(150)
  check('undo brings it back', (await page.locator('.tiptap .diagram-box').count()) === 1)

  // 6. the block menu alternative: grip → menu → the delete item carries the summary and previews on hover
  const cardEl = page.locator('.tiptap x-card[data-v="1"]').first()
  await cardEl.evaluate((e) => e.scrollIntoView({ block: 'center' }))
  const cb = (await cardEl.boundingBox())!
  await page.mouse.move(cb.x + 60, cb.y + 20)
  await sleep(250)
  await page.getByTestId('bh-grip').click()
  await sleep(150)
  const item = page.getByTestId('bm-deleteBlock')
  await item.hover()
  await sleep(150)
  const itemText = ((await item.textContent()) ?? '').replace(/\s+/g, ' ').trim()
  check('block menu: "Delete <x-card>" item carries the summary and the preview overlay appears on hover', /Delete <x-card>.*4 elements inside/.test(itemText) && (await page.locator('.dw-overlay').count()) === 1, itemText)
  const mb = (await page.getByTestId('block-menu').boundingBox())!
  await page.screenshot({ path: path.join(root, 'screenshot-widget-block-menu.png'), clip: { x: Math.max(0, cb.x - 80), y: Math.max(0, cb.y - 36), width: Math.min(1100, cb.width + 110), height: Math.min(900, Math.max(cb.height, mb.y + mb.height - cb.y) + 60) } })
  await page.keyboard.press('Escape')
  await sleep(100)
  check('block menu: Esc closes the menu and clears the preview', (await page.locator('.dw-overlay').count()) === 0)

  // 7. the hover path deletes with one click (the preview was shown while hovering the button) and undo restores
  await page.mouse.move(5, 5)
  await sleep(200)
  const before = await page.locator('.tiptap .diagram-box').count()
  const dbox = page.locator('.tiptap .diagram-box')
  await dbox.evaluate((e) => e.scrollIntoView({ block: 'center' }))
  const db = (await dbox.boundingBox())!
  await page.mouse.move(db.x + db.width - 6, db.y + db.height - 6)
  await sleep(150)
  await page.getByTestId('delete-widget').click()
  await sleep(150)
  check('hover path: clicking the trash deletes the diagram box', before === 1 && (await page.locator('.tiptap .diagram-box').count()) === 0)
  await page.keyboard.press('ControlOrMeta+z')
  await sleep(100)
  check('undo brings it back', (await page.locator('.tiptap .diagram-box').count()) === 1)
  findings.push(`keyboard path: Escape → ${sel1} → ${sel2}; Backspace → confirm bar; Enter deletes; Esc keeps`)
} catch (e) {
  console.error(e)
  failures++
} finally {
  await browser?.close()
  if (server) await server.stop()
}
fs.writeFileSync(path.join(root, 'verify/widget-findings.md'), findings.map((f) => (f.startsWith('  ') ? `    ${f.trim()}` : `- ${f}`)).join('\n') + '\n')
console.log(findings.join('\n'))
console.log(failures === 0 ? 'WIDGET OK' : `WIDGET: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
