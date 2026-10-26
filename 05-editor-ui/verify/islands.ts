// Spike 04's island checks, kept as a regression suite for spike 05 (npm run verify runs it after verify.ts). Exits 0 when every check passes.
// Starts its own server (ephemeral port, no HMR) on a temp copy of samples/spec.html.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike05-islands-'))
const doc = path.join(tmp, 'spec.html')
fs.copyFileSync(sample, doc)
const original = fs.readFileSync(doc, 'utf8')
const originalHead = original.slice(0, original.indexOf('<body>'))
const between = (s: string, a: string, b: string) => {
  const i = s.indexOf(a)
  const j = s.indexOf(b, i)
  return i < 0 || j < 0 ? '' : s.slice(i, j + b.length)
}
const origFigure = between(original, '<figure class="diagram">', '</figure>')
const origSvg = between(original, '<svg', '</svg>')
const ids = Array.from(original.slice(original.indexOf('<body>')).matchAll(/\sid="([^"]+)"/g)).map((m) => m[1])

const LABEL = 'Outbox queue'
const LABEL_EDITED = 'Outbox queue (SQLite)'
const CAPTION_ADD = ' Edited in place.'
const CALLOUT_ADD = ' Callout edited by Playwright.'

/** bounding box of an element inside the figure island's shadow root */
async function shadowBox(page: Page, selector: string, text?: string) {
  return page.evaluate(
    ([sel, txt]) => {
      const host = document.querySelector('.island[data-island-kind="figure"] .island-host') as HTMLElement
      const el = Array.from(host.shadowRoot!.querySelectorAll(sel)).find((e) => !txt || e.textContent === txt)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    },
    [selector, text ?? ''] as const,
  )
}
const shadowTexts = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const host = document.querySelector('.island[data-island-kind="figure"] .island-host') as HTMLElement
    return Array.from(host.shadowRoot!.querySelectorAll(sel)).map((e) => e.textContent)
  }, selector)
const figureAttr = (page: Page) =>
  page.evaluate(() => {
    let html = ''
    ;(window as any).__editor.state.doc.descendants((n: any) => {
      if (n.type.name === 'htmlIsland' && String(n.attrs.html).startsWith('<figure')) html = n.attrs.html
    })
    return html
  })

let server: { proc: ChildProcess; url: string } | undefined
let browser: Browser | undefined
try {
  server = await startServer(doc)
  console.log(`server: ${server.url}  doc: ${doc}`)
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const consoleErrors: string[] = []
  // Vite's HMR client noise when another dev server on this machine holds the default ws port is not ours
  const viteNoise = /WebSocket|\[vite\]|Vite server/
  page.on('console', (m) => m.type() === 'error' && !viteNoise.test(m.text()) && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => !viteNoise.test(String(e)) && consoleErrors.push(String(e)))

  await page.goto(server.url)
  const ed = page.locator('.tiptap')
  await ed.locator('h1').first().waitFor({ timeout: 15000 })
  await page.locator('.island[data-island-kind="figure"]').waitFor()

  // ---------------------------------------------------------------- 1. what Tiptap used to destroy is there
  check('no console errors on load', consoleErrors.length === 0, consoleErrors.join(' | '))
  check('figure island rendered', (await page.locator('.island[data-island-kind="figure"]').count()) === 1)
  const svgBox = await shadowBox(page, 'svg')
  check('SVG diagram visible as SVG (in shadow root)', !!svgBox && svgBox.width > 600 && svgBox.height > 100, JSON.stringify(svgBox))
  const labels = await shadowTexts(page, 'svg text')
  check('5 SVG labels rendered', labels.length === 5 && labels.includes(LABEL), labels.join(' | '))
  check('SVG labels marked editable', (await shadowTexts(page, 'svg text[data-leaf-path]')).length === 5)
  check('callout is a real editable node (div.callout#decision-needed)', (await ed.locator('div.callout#decision-needed[data-kind="warning"] p').count()) === 1)
  const calloutBg = await ed.locator('div.callout').evaluate((e) => getComputedStyle(e).backgroundColor)
  check('callout styled by the doc\'s own CSS (@scope)', calloutBg === 'rgb(255, 247, 230)', calloutBg)
  const gridDisplay = await ed.locator('div.two-col').evaluate((e) => getComputedStyle(e).display)
  check('two-column grid kept as editable container with its style', gridDisplay === 'grid', gridDisplay)
  check('header container + h1#title', (await ed.locator('header.doc-meta[data-doc-id] h1#title').count()) === 1)
  check('details/summary node', (await ed.locator('details, .pm-details').count()) === 1 && (await ed.locator('summary').innerText()).includes('Appendix A'))
  check('x-agent-note kept as island', (await page.locator('.island[data-island-kind="x-agent-note"]').count()) === 1)
  check('heading ids in the editor DOM', (await ed.locator('h2#goals, h2#flow, h2#conflicts').count()) === 3)
  check('anchor link keeps no target=_blank', (await ed.locator('a[href="#conflicts"]').getAttribute('target')) === null)
  const textBefore = await page.evaluate(() => (window as any).__editor.state.doc.textContent as string)

  // ---------------------------------------------------------------- 2. edit callout text (normal node)
  const calloutP = ed.locator('div.callout p')
  const cb = (await calloutP.boundingBox())!
  // click right after the last character of the callout paragraph
  const endRect = await calloutP.evaluate((p) => {
    const r = document.createRange()
    r.selectNodeContents(p)
    const rects = r.getClientRects()
    const last = rects[rects.length - 1]
    return { x: last.right - 1, y: last.top + last.height / 2 }
  })
  await page.mouse.click(endRect.x, endRect.y)
  await page.waitForFunction(() => {
    const s = (window as any).__editor.state.selection
    return s.$from.parent.textContent.endsWith('Conflict handling.') && s.$from.parentOffset === s.$from.parent.content.size
  })
  await page.keyboard.type(CALLOUT_ADD)
  check('callout text typed', (await calloutP.innerText()).endsWith(CALLOUT_ADD.trim()), `${cb.width}px wide`)

  // ---------------------------------------------------------------- 3. edit an SVG label in place
  await page.evaluate(() => document.querySelector('.island[data-island-kind="figure"]')!.scrollIntoView({ block: 'center' }))
  const lb = (await shadowBox(page, 'svg text', LABEL))!
  await page.mouse.click(lb.x + lb.width - 1, lb.y + lb.height / 2) // right edge → caret after last char
  const overlay = page.locator('.island[data-island-kind="figure"] .island-host').locator('[data-testid="svg-overlay"]')
  await overlay.waitFor({ timeout: 3000 })
  check('click on SVG label opens in-place text overlay', await overlay.isVisible())
  await page.keyboard.type(LABEL_EDITED.slice(LABEL.length))
  check('typing updates the SVG <text> live', (await shadowTexts(page, 'svg text')).includes(LABEL_EDITED), (await shadowTexts(page, 'svg text')).join(' | '))
  check('typing updates the node attribute (transaction)', (await figureAttr(page)).includes(`>${LABEL_EDITED}</text>`))
  await page.keyboard.press('Enter')
  check('Enter closes the overlay', (await overlay.count()) === 0)
  // ---------------------------------------------------------------- 4. edit figcaption (HTML leaf, contenteditable)
  const cap = (await shadowBox(page, 'figcaption'))!
  const capEnd = await page.evaluate(() => {
    const host = document.querySelector('.island[data-island-kind="figure"] .island-host') as HTMLElement
    const fc = host.shadowRoot!.querySelector('figcaption')!
    const r = document.createRange()
    r.selectNodeContents(fc)
    const rects = r.getClientRects()
    const last = rects[rects.length - 1]
    return { x: last.right - 1, y: last.top + last.height / 2 }
  })
  await page.mouse.click(capEnd.x, capEnd.y)
  await page.keyboard.type(CAPTION_ADD)
  const capText = (await shadowTexts(page, 'figcaption'))[0] ?? ''
  check('figcaption edited in place (contenteditable leaf)', capText.endsWith(CAPTION_ADD), `${cap.width}px: ${capText}`)
  await page.keyboard.press('Escape')
  const textAfter = await page.evaluate(() => (window as any).__editor.state.doc.textContent as string)
  check('island typing did not leak into ProseMirror text', textAfter === textBefore.replace('Conflict handling.', 'Conflict handling.' + CALLOUT_ADD), `${textAfter.length} vs ${textBefore.length + CALLOUT_ADD.length}`)
  check('no console errors while editing', consoleErrors.length === 0, consoleErrors.join(' | '))

  // ---------------------------------------------------------------- 5. save → file on disk
  await page.getByTestId('save').click()
  await page.getByTestId('status').filter({ hasText: /^Saved/ }).waitFor({ timeout: 5000 })
  const saved = fs.readFileSync(doc, 'utf8')
  const savedSvg = between(saved, '<svg', '</svg>')
  check('file has the changed SVG label', saved.includes(`>${LABEL_EDITED}</text>`))
  check('SVG otherwise byte-identical (modulo the label)', savedSvg === origSvg.replace(`>${LABEL}</text>`, `>${LABEL_EDITED}</text>`), `${savedSvg.length} vs ${origSvg.length} chars`)
  check('whole <figure> byte-identical modulo label + caption', between(saved, '<figure class="diagram">', '</figure>') ===
    origFigure.replace(`>${LABEL}</text>`, `>${LABEL_EDITED}</text>`).replace('then to the server.</figcaption>', `then to the server.${CAPTION_ADD}</figcaption>`))
  check('callout edit saved, callout attrs kept', /<div class="callout warning" data-kind="warning" id="decision-needed">[\s\S]*Callout edited by\s+Playwright\./.test(saved))
  const missing = ids.filter((id) => !saved.includes(`id="${id}"`))
  check(`all ${ids.length} ids survive (${ids.join(', ')})`, missing.length === 0, missing.join(', '))
  check('x-agent-note byte-identical', saved.includes(between(original, '<x-agent-note', '</x-agent-note>')))
  check('grid layout div byte-equal attrs', saved.includes('class="two-col"') && /style="display: ?grid/.test(saved))
  check('<head> preserved byte-for-byte', saved.startsWith(originalHead))
  check('no island placeholder left in file', !saved.includes('data-raw-island'))

  // ---------------------------------------------------------------- 6. undo restores the label
  // undo steps: caption typing, label typing (each grouped by ProseMirror history)
  const undoUntil = async (pred: () => Promise<boolean>, max = 10) => {
    for (let i = 0; i < max; i++) {
      if (await pred()) return i
      await page.getByTestId('tb-undo').click()
    }
    return (await pred()) ? max : -1
  }
  const steps = await undoUntil(async () => (await shadowTexts(page, 'svg text')).includes(LABEL))
  check('undo restores the SVG label', steps > 0, `${steps} undo click(s)`)
  check('undo restored the node attribute too', (await figureAttr(page)).includes(`>${LABEL}</text>`))
  check('callout edit still there after label undo', (await calloutP.innerText()).endsWith(CALLOUT_ADD.trim()))
  await page.getByTestId('save').click()
  await page.getByTestId('status').filter({ hasText: /^Saved/ }).waitFor({ timeout: 5000 })
  const saved2 = fs.readFileSync(doc, 'utf8')
  check('after undo + save: SVG byte-identical to the original', between(saved2, '<svg', '</svg>') === origSvg)

  // ---------------------------------------------------------------- 6b. robustness: custom element island
  const NOTE = 'Agent: I assumed SQLite on the device; please confirm.'
  const noteAttr = () =>
    page.evaluate(() => {
      let html = ''
      ;(window as any).__editor.state.doc.descendants((n: any) => {
        if (n.type.name === 'htmlIsland' && String(n.attrs.html).startsWith('<x-agent-note')) html = n.attrs.html
      })
      return html
    })
  const note = page.locator('.island[data-island-kind="x-agent-note"] .island-host x-agent-note') // pierces shadow
  await note.scrollIntoViewIfNeeded()
  await note.click()
  await page.keyboard.press('ControlOrMeta+a') // selects inside the editing host only
  await page.keyboard.type('Rewritten note.')
  check('select-all + type replaces only the leaf text', (await note.innerText()) === 'Rewritten note.' && (await noteAttr()).includes('>Rewritten note.</x-agent-note>'))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 })
  const midComposition = await noteAttr()
  await cdp.send('Input.insertText', { text: '日本' })
  check('IME: no commit mid-composition, committed on compositionend', !midComposition.includes('にほ') && (await noteAttr()).includes('>Rewritten note.日本</x-agent-note>'), await note.innerText())
  await page.keyboard.press('ControlOrMeta+z') // inside the island → routed to ProseMirror's history
  const afterUndo = await noteAttr()
  check('⌘/Ctrl+Z inside the island undoes via ProseMirror history', afterUndo.includes(`>${NOTE}</x-agent-note>`), afterUndo)
  check('island DOM re-rendered from the attribute after undo', (await note.innerText()) === NOTE)
  await note.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  check('leaf can be emptied', (await noteAttr()).includes('></x-agent-note>'))
  await page.getByTestId('tb-undo').click()
  await page.getByTestId('tb-redo').click() // forces a re-render of the emptied island
  check('emptied leaf is still editable after re-render', (await note.getAttribute('contenteditable')) === 'plaintext-only')
  await note.click()
  await page.keyboard.type('Typed into an emptied element.')
  check('typing into the emptied leaf works', (await noteAttr()).includes('>Typed into an emptied element.</x-agent-note>'))
  await page.keyboard.press('Enter') // leaves the island (no newline inserted)
  check('Enter inserts no newline/<br>', !(await noteAttr()).includes('<br') && !(await noteAttr()).includes('\n'))
  // island toolbar: edit source
  const noteIsland = page.locator('.island[data-island-kind="x-agent-note"]')
  await noteIsland.hover()
  await noteIsland.getByTestId('island-source').click()
  const src = noteIsland.getByTestId('island-src-text')
  check('"source" opens the raw HTML', (await src.inputValue()).startsWith('<x-agent-note data-agent="claude"'))
  await src.fill('<x-agent-note data-agent="claude"><b>Structure</b> changed via source.</x-agent-note>')
  await noteIsland.getByTestId('island-src-apply').click()
  check('source edit re-renders the island', (await noteIsland.locator('.island-host b').innerText()) === 'Structure' && (await noteAttr()).includes('<b>Structure</b>'))
  check('mixed-content element: only its text-only children are editable', (await noteIsland.locator('.island-host b').getAttribute('contenteditable')) === 'plaintext-only' && (await noteIsland.locator('.island-host x-agent-note').getAttribute('contenteditable')) === null)
  check('no console errors after robustness checks', consoleErrors.length === 0, consoleErrors.join(' | '))

  // ---------------------------------------------------------------- 7. reload
  await page.reload()
  await page.locator('.island[data-island-kind="figure"]').waitFor()
  check('reload: islands render again', (await shadowTexts(page, 'svg text')).length === 5)
} catch (e) {
  console.error(e)
  failures++
} finally {
  await browser?.close()
  server?.proc.kill('SIGTERM')
  fs.rmSync(tmp, { recursive: true, force: true })
}
check('shared sample unchanged', fs.readFileSync(sample, 'utf8') === sampleBefore)

console.log(failures === 0 ? '\nverify: ALL PASS' : `\nverify: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
