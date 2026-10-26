// Does the user's caret stay put when the agent inserts a BLOCK before the block the user is typing in?
// (Found in the P3 run: the user's last keystrokes landed in the agent's new <li>: "Sync (u01).uses at most 2 % battery".)
//
//   npm run caret-structural            → table: path × (with / without CollabCaretFix) → where the typing ended up
//
// For each path the user types "AAAA" at the end of the "Sync completes…" item, the agent inserts a new list item
// BEFORE it, the user types "BBBB" without touching the mouse. Pass = the item ends with "AAAABBBB".
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Page } from 'playwright'
import { root, startServer } from '../lib/serverProc.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sample = path.resolve(root, '../samples/spec.html')

type Path = 'P2 op insert-after' | 'P3 patch' | 'P1 file edit'
type Scenario = 'insert-before' | 'replace-before-caret' | 'both'
const INS = { old: 'Never lose a note written offline.</p></li>', new: 'Never lose a note written offline.</p></li>\n  <li><p>Sync uses at most 2 % battery per day.</p></li>' }
const REP = { old: 'for a typical day of notes.', new: 'for up to 500 queued notes.' }
async function agentEdit(p: Path, s: Scenario, url: string, doc: string) {
  const edits = s === 'insert-before' ? [INS] : s === 'replace-before-caret' ? [REP] : [REP, INS]
  if (p === 'P2 op insert-after') {
    for (const e of edits) {
      const op = e === INS ? { op: 'insert-after', find: 'Never lose a note written offline.', html: '<li><p>Sync uses at most 2 % battery per day.</p></li>' } : { op: 'replace-text', find: e.old, replace: e.new }
      await fetch(`${url}/agent/op`, { method: 'POST', body: JSON.stringify({ op }) })
    }
  } else if (p === 'P3 patch') {
    const r = await fetch(`${url}/agent/patch`, { method: 'POST', body: JSON.stringify({ edits }) })
    if (!r.ok) throw new Error(await r.text())
  } else {
    let f = fs.readFileSync(doc, 'utf8')
    for (const e of edits) f = f.replace(e.old, e.new)
    fs.writeFileSync(doc, f)
  }
}

export async function caretStructural(paths: Path[] = ['P2 op insert-after', 'P3 patch', 'P1 file edit'], fixModes = [true, false], scenarios: Scenario[] = ['insert-before', 'replace-before-caret', 'both'], serverArgs: string[] = []) {
  const rows: { path: Path; scenario: Scenario; caretFix: boolean; item: string; newItem: string; ok: boolean }[] = []
  const browser = await chromium.launch()
  try {
    for (const p of paths)
      for (const fix of fixModes)
      for (const sc of scenarios) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike08-caret-'))
        const doc = path.join(tmp, 'spec.html')
        fs.copyFileSync(sample, doc)
        const srv = await startServer(doc, 0, serverArgs)
        try {
          const page: Page = await browser.newPage()
          await page.goto(`${srv.url}/?user=Noah${fix ? '' : '&nocaretfix'}`)
          await page.waitForFunction(() => (window as any).__editor && (window as any).__provider?.synced)
          await sleep(500)
          await page.evaluate(() => {
            const ed = (window as any).__editor
            let end = -1
            ed.state.doc.descendants((n: any, pos: number) => {
              if (end < 0 && n.isTextblock && n.textContent.includes('Sync completes within')) end = pos + n.nodeSize - 1
              return end < 0
            })
            ed.commands.setTextSelection(end)
            ed.view.focus()
          })
          // the user keeps typing WHILE the agent's edit arrives (that is what the P3 run hit)
          if (p === 'P1 file edit') {
            await fetch(`${srv.url}/doc/flush`, { method: 'POST' })
            await sleep(200)
          }
          const typing = page.keyboard.type('AAAABBBB', { delay: 90 })
          await sleep(300)
          await agentEdit(p, sc, srv.url, doc)
          await typing
          await sleep(p === 'P1 file edit' ? 1500 : 600)
          const r = await page.evaluate(() => {
            const ed = (window as any).__editor
            let item = ''
            let newItem = ''
            ed.state.doc.descendants((n: any) => {
              if (n.isTextblock && n.textContent.includes('Sync completes')) item = n.textContent
              if (n.isTextblock && n.textContent.includes('battery')) newItem = n.textContent
            })
            return { item, newItem }
          })
          rows.push({ path: p, scenario: sc, caretFix: fix, ...r, ok: r.item.endsWith('AAAABBBB') && !/[AB]/.test(r.newItem) })
          await page.close()
        } finally {
          await srv.stop()
          fs.rmSync(tmp, { recursive: true, force: true })
        }
      }
  } finally {
    await browser.close()
  }
  return rows
}

if (process.argv[1]?.endsWith('caret-structural.ts')) {
  const rows = await caretStructural()
  for (const r of rows) console.log(`${r.ok ? 'OK  ' : 'JUMP'}  ${r.path.padEnd(20)} ${r.scenario.padEnd(21)} caretFix=${r.caretFix ? 'on ' : 'off'}  item: …${r.item.slice(-34)} | new: ${r.newItem}`)
}
