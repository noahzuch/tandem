// npm run typing-race — A/B for the caret bug found by verify (src/editor/caretFix.ts).
//
// The user types " durableN" inside a paragraph while the agent (ws client) types " and auditorsN" character by character
// into the SAME paragraph, BEFORE the user's caret. Without the fix (?nocaretfix) y-tiptap restores the user's caret to its
// old offset after every remote character, so the user's word comes out scrambled. Exit 0 when the fix holds (3/3 clean).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { root, startServer, freePort } from '../lib/serverProc.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'race06-'))
const doc = path.join(tmp, 'spec.html')
fs.copyFileSync(path.resolve(root, '../samples/spec.html'), doc)
const server = await startServer(doc, await freePort())
const browser = await chromium.launch()
const results: Record<string, string[]> = { 'without fix (?nocaretfix)': [], 'with fix (default)': [] }
let clean = 0
try {
  for (const [label, query] of [
    ['without fix (?nocaretfix)', '&nocaretfix'],
    ['with fix (default)', ''],
  ] as const) {
    for (let i = 0; i < 3; i++) {
      const page = await browser.newPage()
      await page.goto(`${server.url}/?user=Noah${query}`)
      await page.locator('.tiptap h1').waitFor({ timeout: 15000 })
      await page.waitForTimeout(600)
      const word = ` durable${i}`
      const agent = spawn(process.execPath, ['--import', 'tsx', 'agent/agent.ts', '--server', server.url, '--linger', '200', 'type', 'Field technicians', ` and auditors${i}`, '--type-delay', '70'], { cwd: root, stdio: 'ignore' })
      const done = new Promise((r) => agent.on('exit', r))
      await page.waitForTimeout(250)
      await page.evaluate(() => {
        const ed = (window as any).__editor
        let pos = -1
        ed.state.doc.descendants((n: any, p: number) => {
          if (pos < 0 && n.isText && n.text.includes('client-side')) pos = p + n.text.indexOf('client-side') + 'client-side'.length
        })
        ed.commands.setTextSelection(pos)
        ed.view.focus()
      })
      await page.keyboard.type(word, { delay: 70 })
      await done
      await page.waitForTimeout(400)
      const para = await page.evaluate(() => {
        let s = ''
        ;(window as any).__editor.state.doc.descendants((n: any) => {
          if (!s && n.isTextblock && n.textContent.startsWith('Field')) s = n.textContent
        })
        return s
      })
      const got = /client-side \S*/.exec(para)?.[0] ?? '?'
      results[label].push(got)
      if (query === '' && got === `client-side${word}`) clean++
      await page.close()
    }
  }
} finally {
  await browser.close()
  await server.stop()
}
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(28)} ${v.map((x) => JSON.stringify(x)).join('  ')}`)
console.log(clean === 3 ? 'TYPING RACE: fix holds (3/3 clean)' : `TYPING RACE: ${clean}/3 clean with the fix`)
process.exit(clean === 3 ? 0 : 1)
