// npm run big-journal -- <decisions.md>…  — does the journal panel scale to a real, long Decision Journal?
// Copies each journal into a temp project (never touches the original), opens the shell headless and measures:
// parse time, page load → all entries rendered, and append-on-disk → visible (5 appends).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { root, startServer } from '../lib/serverProc.ts'
import { parseJournal } from '../src/shell/journal.ts'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('usage: npm run big-journal -- path/to/decisions.md …')
  process.exit(1)
}
const browser = await chromium.launch()
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8')
  const t0 = performance.now()
  const parsed = parseJournal(text)
  const parseMs = performance.now() - t0
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike09-big-'))
  fs.copyFileSync(path.join(root, 'demo/spec.html'), path.join(dir, 'spec.html'))
  fs.writeFileSync(path.join(dir, 'decisions.md'), text)
  fs.mkdirSync(path.join(dir, '.collab'))
  fs.writeFileSync(
    path.join(dir, '.collab/spec.html.shell.json'),
    JSON.stringify({ version: 1, layout: { left: { active: 'journal' }, right: {} }, panels: [{ id: 'journal', type: 'file', path: 'decisions.md', render: 'journal', side: 'left' }, { id: 'comments', type: 'comments', side: 'right' }] }),
  )
  const srv = await startServer(path.join(dir, 'spec.html'))
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    const t1 = Date.now()
    await page.goto(`${srv.url}/?user=Noah`)
    await page.waitForFunction((n) => document.querySelectorAll('[data-entry]').length === n, parsed.entries.length, { timeout: 30000 })
    const loadMs = Date.now() - t1
    const lat: number[] = []
    for (let i = 0; i < 5; i++) {
      const id = `F-${9000 + i}`
      const ta = Date.now()
      fs.appendFileSync(path.join(dir, 'decisions.md'), `\n${id}: [verified] Appended entry ${i}. (Source: big-journal)\n`)
      await page.waitForSelector(`[data-entry="${id}"]`, { timeout: 5000 })
      lat.push(Date.now() - ta)
      await new Promise((r) => setTimeout(r, 300))
    }
    const nodes = await page.evaluate(() => document.querySelectorAll('.journal *').length)
    console.log(
      `${path.basename(path.dirname(f))}/${path.basename(f)}: ${text.split('\n').length} lines, ${(text.length / 1024).toFixed(0)} KB, ${parsed.entries.length} entries | parse ${parseMs.toFixed(1)} ms | page load → all entries rendered ${loadMs} ms | append → visible ${lat.join('/')} ms | ${nodes} DOM nodes in the panel`,
    )
    await page.close()
  } finally {
    await srv.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
await browser.close()
