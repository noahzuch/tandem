// npm run verify — spike 10's headless proof. Exits 0 only when all three parts are green:
//   1. verify/matrix.ts   the interaction matrix (every cell equals verify/matrix.expected.json — broken-by-design
//                         cells are asserted as observed, not hidden)
//   2. verify/widget.ts   the delete widget against hard CSS (+ the README screenshots)
//   3. this file          the collaboration save path with generic nodes (round 2 default: everything free, protected
//                         like table cells): the server seeds the Y.Doc from samples/battle.html, the browser edits
//                         text inside a generic node and inside the FREE diagram box (Enter in a positioned node = <br>),
//                         the agent CLI edits a generic node, the file on disk keeps every element and attribute, and
//                         the result is a fixed point.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser } from 'playwright'
import { root, startServer, freePort, type ServerHandle } from '../lib/serverProc.ts'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function part(name: string, script: string) {
  console.log(`\n=== ${name} (${script}) ===`)
  const r = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: root, stdio: 'inherit' })
  check(`${name} green`, r.status === 0, `exit ${r.status}`)
}

part('interaction matrix', 'verify/matrix.ts')
part('delete widget', 'verify/widget.ts')

console.log('\n=== collaboration save path with generic nodes ===')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike10-verify-'))
const doc = path.join(tmp, 'battle.html')
fs.copyFileSync(path.join(root, 'samples/battle.html'), doc)
const original = fs.readFileSync(doc, 'utf8')
let server: ServerHandle | undefined
let browser: Browser | undefined
try {
  server = await startServer(doc, await freePort())
  const url = server.url
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1200, height: 1400 } })
  const errors: string[] = []
  const noise = /WebSocket|\[vite\]|Vite server/
  page.on('console', (m) => m.type() === 'error' && !noise.test(m.text()) && errors.push(m.text()))
  page.on('pageerror', (e) => !noise.test(String(e)) && errors.push(String(e)))
  await page.goto(`${url}/?user=Noah`)
  await page.locator('.tiptap h1').first().waitFor({ timeout: 15000 })
  await sleep(800)
  const health = async () => (await fetch(`${url}/health`)).json() as Promise<Record<string, any>>
  const h0 = await health()
  check('server seeded the Y.Doc from the HTML (generic nodes parsed server-side)', h0.loadedFrom === 'html' && h0.live === true, `loadedFrom=${h0.loadedFrom}`)
  const tree = await page.evaluate(() => {
    const ed = (window as any).__editor
    const out: string[] = []
    ed.state.doc.descendants((n: any) => {
      if (n.type.name.startsWith('generic')) out.push(`${n.type.name}<${n.attrs.tag}>[${n.attrs.mode}]`)
      if (n.type.name === 'container') out.push(`container<${n.attrs.tag}.${n.attrs.htmlAttrs?.class ?? ''}>`)
    })
    return out
  })
  check('browser: x-card / dl / x-badge are free generic nodes, the diagram box is a Container holding generic textblocks (its text-only divs)', tree.includes('genericBlock<x-card>[free]') && tree.includes('container<div.diagram-box>') && tree.filter((t) => t === 'genericTextBlock<div>[free]').length >= 6 && tree.includes('genericBlock<dl>[free]') && tree.includes('genericInline<x-badge>[free]'), tree.slice(0, 10).join(' '))

  // user types inside the free card and inside the locked diagram box
  const typeIn = async (selector: string, text: string) => {
    const el = page.locator(selector).first()
    await el.scrollIntoViewIfNeeded()
    const b = (await el.boundingBox())!
    await page.mouse.click(b.x + b.width - 4, b.y + b.height / 2)
    await sleep(80)
    await page.keyboard.type(text, { delay: 10 })
    await sleep(80)
  }
  await typeIn('.tiptap x-card[data-v="1"] x-title', ' (edited)')
  await typeIn('.tiptap .diagram-box .node', ' v2')
  const guardLog = await page.evaluate(() => (window as any).__guardLog ?? [])
  check('typing inside the free diagram box needs no intervention (guard log empty)', guardLog.length === 0, JSON.stringify(guardLog))
  // Enter inside a positioned node: a line break, not a second node at the same coordinates
  await page.keyboard.press('Enter')
  await sleep(60)
  const nodes = await page.locator('.tiptap .diagram-box .node').count()
  const guardLog2 = await page.evaluate(() => (window as any).__guardLog ?? [])
  check('Enter inside the positioned .node inserts a <br> (no duplicate node)', nodes === 3 && (await page.locator('.tiptap .diagram-box .node br').count()) >= 1 && guardLog2.some((g: string) => g.includes('line break')), `${nodes} .node elements; ${JSON.stringify(guardLog2)}`)

  // the agent edits a generic node's text (text search works because the text is in the tree)
  const agent = spawnSync(process.execPath, ['--import', 'tsx', 'agent/agent.ts', '--server', url, '--json', '--linger', '100', 'replace-text', 'Last writer wins.', 'Last writer wins (LWW).'], { cwd: root, encoding: 'utf8' })
  check('agent replace-text inside a generic <dd> (exit 0)', agent.status === 0, agent.stdout.trim().slice(-120))
  await sleep(300)
  const dd = await page.locator('.tiptap dl dd').first().textContent()
  check('browser shows the agent edit in the <dd>', dd === 'Last writer wins (LWW).', dd ?? 'null')

  // flush → file on disk
  await fetch(`${url}/doc/flush`, { method: 'POST' })
  await sleep(300)
  const file = fs.readFileSync(doc, 'utf8')
  const head = original.slice(0, original.indexOf('<body>'))
  check('file: <head> byte-identical', file.startsWith(head))
  // prettier puts a closing ">" on its own line and the browser drops a trailing ";" in style (spike 04): both harmless
  check('file: x-card keeps its attributes and the typed text', /<x-card data-v="1"[^>]*>\s*<x-title[^>]*>Card title \(edited\)<\/x-title\s*>/.test(file))
  check('file: free diagram box keeps class/style of every absolutely positioned child + typed text + the <br>', file.includes('class="diagram-box"') && /<div class="node" style="left: 20px; top: 30px;?"[^>]*>\s*Device editor v2\s*<br\s*\/?>\s*<\/div\s*>/.test(file) && (file.match(/class="node" style="left: \d+px; top: 30px;?"/g) ?? []).length === 3 && !/<div class="node"[^>]*>\s*<p>/.test(file), file.slice(file.indexOf('class="node"') - 10, file.indexOf('class="node"') + 120).replace(/\n/g, ' '))
  check('file: no editor-internal attributes leaked (data-generic / contenteditable)', !/data-generic|contenteditable/.test(file))
  check('file: svg island byte-identical', file.includes(original.slice(original.indexOf('<svg'), original.indexOf('</svg>') + 6)))
  check('file: x-badge inline generic node round-trips inside its text', /<x-badge[^>]*>badge<\/x-badge>/.test(file))
  check('file: agent edit is in the <dd>', file.includes('<dd>Last writer wins (LWW).</dd>') || /<dd[^>]*>Last writer wins \(LWW\)\.<\/dd>/.test(file))
  // fixed point: load the written file again through the pipeline
  const { loadHtml, saveHtml } = await import('../lib/pipeline.ts')
  const again = await saveHtml(loadHtml(file), true)
  check('file: fixed point (load → save gives the same bytes)', again === file, again === file ? '' : `differs at ${[...again].findIndex((c, i) => c !== file[i])}`)
  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '))
  await page.screenshot({ path: path.join(root, 'screenshot-full.png'), fullPage: true })
} catch (e) {
  console.error(e)
  failures++
} finally {
  await browser?.close()
  if (server) await server.stop()
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
