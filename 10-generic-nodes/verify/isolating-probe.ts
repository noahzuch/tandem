// npm run probe:isolating — what does `isolating` change? (a) Transform-level deleteRange/replaceRange across an element edge (the path no
// keymap sees: agent ops, drag-drop, input events) and (b) ProseMirror's own join commands invoked WITHOUT the
// keymap (other extensions, programmatic chains, nested structures the keymap defers to).
// Compares ?isolating=1 and ?isolating=0 on the same fixtures. Output is quoted in README.md.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { root, startServer, freePort } from '../lib/serverProc.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'))
const doc = path.join(tmp, 'battle.html')
fs.copyFileSync(path.join(root, 'samples/battle.html'), doc)
const server = await startServer(doc, await freePort())
const browser = await chromium.launch()
const CARD = `<p>Before</p><x-card><x-title id="f">Card</x-title><x-note id="t">Alpha beta gamma</x-note></x-card><p>After</p>`
const GRID = `<p>Before</p><div class="two-col" style="display:grid"><div><h3 id="f">Left</h3><p id="t">Alpha beta gamma</p></div><div><h3>Right</h3><p>Other</p></div></div><p>After</p>`
const LIST = `<p>Before</p><x-card><ul><li><p id="t">Alpha beta gamma</p></li><li><p>Second</p></li></ul></x-card><p>After</p>`
const HELPERS = `
  const ed = window.__editor
  const short = (n) => (n.type.name === 'paragraph' ? 'p' : n.type.name === 'heading' ? 'h3' : n.type.name.startsWith('generic') || n.type.name === 'container' ? n.attrs.tag : n.type.name === 'bulletList' ? 'ul' : n.type.name === 'listItem' ? 'li' : n.type.name)
  const t = (n) => { const kids = []; n.forEach((c) => !c.isText && kids.push(t(c))); return short(n) + (kids.length ? '(' + kids.join(',') + ')' : '') }
  const tree = (d) => { const out = []; d.forEach((n) => out.push(t(n))); return out.join(',') }
  const text = (d) => d.textBetween(0, d.content.size, '|')
  const find = (s) => { let pos = -1; ed.state.doc.descendants((n, p) => { if (pos < 0 && n.isText && n.text.includes(s)) pos = p + n.text.indexOf(s) }); return pos }
  const show = (d) => tree(d) + '  ' + JSON.stringify(text(d))
`
for (const iso of ['1', '0']) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  await page.goto(`${server.url}/?collab=0&isolating=${iso}`)
  await page.locator('.tiptap h1').first().waitFor({ timeout: 15000 })
  await sleep(300)
  for (const [name, html] of [['card', CARD], ['grid', GRID]]) {
    await page.evaluate((h) => (window as any).__load(h), html)
    await sleep(100)
    const out = await page.evaluate(`(() => {
      ${HELPERS}
      const res = {}
      let tr = ed.state.tr.deleteRange(find('Before') + 3, find('Alpha') + 6)
      res['tr.deleteRange(Bef|ore … Alpha |beta)'] = show(tr.doc)
      tr = ed.state.tr.deleteRange(find('Alpha') + 6, find('After') + 3)
      res['tr.deleteRange(Alpha |beta … Aft|er)'] = show(tr.doc)
      const slice = ed.state.doc.slice(find('Before'), find('Before') + 6)
      tr = ed.state.tr.replaceRange(find('Before') + 3, find('Alpha') + 6, slice)
      res['tr.replaceRange(Bef|ore … Alpha |beta, "Before")'] = show(tr.doc)
      // ProseMirror's own commands, invoked without the keymap (what another extension / a chain would do)
      const { TextSelection } = window.__pmState
      const at = (pos) => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, pos)))
      at(find('Alpha') + 16)
      ed.commands.joinForward()
      res['commands.joinForward() at the end of the target'] = show(ed.state.doc)
      window.__load(${JSON.stringify(html)})
      at(find('Left') >= 0 ? find('Left') : find('Card'))
      ed.commands.joinBackward()
      res['commands.joinBackward() at the start of the first child'] = show(ed.state.doc)
      window.__load(${JSON.stringify(html)})
      at(find('Alpha'))
      ed.commands.lift()
      res['commands.lift() on the target'] = show(ed.state.doc)
      return res
    })()`)
    console.log(`isolating=${iso} ${name}:`, JSON.stringify(out, null, 1))
  }
  await page.evaluate((h) => (window as any).__load(h), LIST)
  await sleep(100)
  const out = await page.evaluate(`(() => {
    ${HELPERS}
    const res = {}
    const { TextSelection } = window.__pmState
    const at = (pos) => ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, pos)))
    at(find('Alpha'))
    ed.commands.joinBackward()
    res['commands.joinBackward() at the start of the first list item inside the card'] = show(ed.state.doc)
    window.__load(${JSON.stringify(LIST)})
    at(find('Alpha'))
    ed.commands.liftListItem('listItem')
    res['liftListItem at the first item'] = show(ed.state.doc)
    return res
  })()`)
  console.log(`isolating=${iso} list-in-card:`, JSON.stringify(out, null, 1))
  await page.close()
}
await browser.close()
await server.stop()
