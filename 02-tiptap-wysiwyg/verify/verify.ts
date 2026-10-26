// npm run verify — headless proof of spike 02's claims. Exits 0 when every check passes.
// Starts its own server (ephemeral port, no HMR) on a temp copy of samples/spec.html.
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser } from 'playwright'
import { root, startServer } from '../lib/serverProc.ts'

const sample = path.resolve(root, '../samples/spec.html')
const sampleBefore = fs.readFileSync(sample, 'utf8')

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike02-'))
const doc = path.join(tmp, 'spec.html')
fs.copyFileSync(sample, doc)
const original = fs.readFileSync(doc, 'utf8')
const originalHead = original.slice(0, original.indexOf('<body>'))

let server: { proc: ChildProcess; url: string } | undefined
let browser: Browser | undefined
try {
  server = await startServer(doc)
  console.log(`server: ${server.url}  doc: ${doc}`)
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const consoleErrors: string[] = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  await page.goto(server.url)
  const ed = page.locator('.tiptap')
  await ed.locator('h1').first().waitFor({ timeout: 15000 })

  // 1. document renders
  check('h1 rendered', (await ed.locator('h1').first().innerText()).includes('Offline sync for field notes'))
  check('h2 headings rendered', (await ed.locator('h2').count()) >= 5, `${await ed.locator('h2').count()} h2`)
  check('h3 heading rendered', await ed.locator('h3', { hasText: 'Non-goals' }).isVisible())
  check('table visible', await ed.locator('table').first().isVisible())
  check('table header row', (await ed.locator('table th').count()) === 3, `${await ed.locator('table th').count()} th`)
  check('bullet list visible', await ed.locator('ul li', { hasText: 'Never lose a note written offline.' }).isVisible())
  check('nested list visible', await ed.locator('ul ul li', { hasText: 'Shown as a banner' }).isVisible())
  check('numbered list visible', await ed.locator('ol li', { hasText: 'Real-time collaboration' }).isVisible())
  check('task list with checkboxes', (await ed.locator('ul[data-type="taskList"] input[type="checkbox"]').count()) === 3)
  check('code block visible', await ed.locator('pre code').first().isVisible())
  check('no console errors on load', consoleErrors.length === 0, consoleErrors.join(' | '))
  check('status "loaded"', (await page.getByTestId('status').innerText()) === 'loaded')

  // screenshot for the README (initial render, before the edit)
  await page.screenshot({ path: path.join(root, 'screenshot.png'), fullPage: true })

  // 2. type a sentence under "1. Goals", select it, bold via toolbar, save
  const sentence = 'Verify sentence typed by Playwright.'
  // click into the empty area right of the heading text -> caret lands at the end of the heading
  const goals = ed.locator('h2', { hasText: '1. Goals' })
  const box = (await goals.boundingBox())!
  await goals.click({ position: { x: box.width - 4, y: box.height / 2 } })
  // ProseMirror picks up the DOM selection asynchronously (selectionchange) — wait for it
  await page.waitForFunction(() => {
    const sel = (window as any).__editor.state.selection
    return sel.$from.parent.textContent === '1. Goals' && sel.$from.parentOffset === 8
  })
  await page.keyboard.press('Enter')
  await page.keyboard.type(sentence)
  for (let i = 0; i < sentence.length; i++) await page.keyboard.press('Shift+ArrowLeft')
  await page.getByTestId('tb-bold').click()
  check('toolbar bold applied in editor', (await ed.locator('strong', { hasText: sentence }).count()) === 1)
  check('status shows unsaved', (await page.getByTestId('status').innerText()) === 'unsaved changes')
  await page.getByTestId('save').click()
  await page.getByTestId('status').filter({ hasText: /^saved/ }).waitFor({ timeout: 5000 })

  // 3. file on disk contains the change; <head> untouched
  const saved = fs.readFileSync(doc, 'utf8')
  const words = sentence.split(' ').map((w) => w.replace('.', '\\.')).join('\\s+')
  check('file on disk contains bold sentence', new RegExp(`<strong>\\s*${words}\\s*</strong>`).test(saved))
  const afterGoals = new RegExp(`1\\. Goals</h2>\\s*<p>\\s*<strong>\\s*${words}`).test(saved)
  const at = saved.indexOf('Verify sentence')
  check('sentence is right after the Goals heading', afterGoals, afterGoals ? '' : saved.slice(at - 300, at + 100))
  check('<head> (title, <style>, comment) preserved byte-for-byte', saved.startsWith(originalHead))
  check('saved file is pretty-printed (many lines)', saved.split('\n').length > 80, `${saved.split('\n').length} lines`)

  // 4. reload shows the saved content
  await page.reload()
  await ed.locator('h1').first().waitFor()
  check('reload shows saved bold sentence', (await ed.locator('strong', { hasText: sentence }).count()) === 1)
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
