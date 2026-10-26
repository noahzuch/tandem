// Spike 10 — the interaction matrix. Rows = interactions driven with REAL keyboard/mouse input (Playwright),
// columns = node kinds. Every cell is recorded as an observation string (target text, document text, node tree,
// extras) plus a verdict (ok / broken / guarded). `npm run verify` compares every cell with
// verify/matrix.expected.json: cells that are broken by design are asserted as observed, not hidden.
//
//   tsx verify/matrix.ts            run + compare (exit 1 on any difference or missing expectation)
//   tsx verify/matrix.ts --record   write the observations as the new expectations (review the diff!)
//
// Plain-mode rows run in one tab with ?collab=0 (each cell reloads a tiny fixture with window.__load);
// the two concurrency rows run in collaboration mode (two tabs + the agent CLI) on a combined fixture.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'
import { root, startServer, freePort, type ServerHandle } from '../lib/serverProc.ts'

const RECORD = process.argv.includes('--record')
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7)
const expectedPath = path.join(root, 'verify/matrix.expected.json')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- columns
export interface Kind {
  id: string
  label: string
  /** fixture: "Before" paragraph, the target (id="t", text "Alpha beta gamma"), "After" paragraph */
  html: string
  /** text of the block before / after the target inside its parent (for join expectations) */
  prev: string
  next: string
  /** first textblock after "Before" (what → from the end of "Before" should reach) */
  first: string
  svgNodes?: boolean
  /** round 2: the structure is protected by design, so "nothing happened, tree intact" is a guard, not a bug */
  protectedStructure: boolean
  /** the target sits inside an element the delete UI handles (generic node / container / island) */
  unit: boolean
}
const T = 'Alpha beta gamma'
// fixtures: "Before", the target (id="t"), "After"; the element's first child carries id="f" (round 2 rows)
const KINDS: Kind[] = [
  { id: 'paragraph', label: 'plain paragraph', html: `<p>Before</p><p id="t">${T}</p><p>After</p>`, prev: 'Before', next: 'After', first: 'Alpha beta g', protectedStructure: false, unit: false },
  {
    id: 'container',
    label: 'spike 04 Container (grid column)',
    html: `<p>Before</p><div class="two-col" style="display:grid;grid-template-columns:1fr 1fr;gap:16px"><div><h3 id="f">Left</h3><p id="t">${T}</p></div><div><h3>Right</h3><p>Other</p></div></div><p>After</p>`,
    prev: 'Left',
    next: 'Right',
    first: 'Left',
    protectedStructure: true,
    unit: true,
  },
  // round 2: the default needs no data-edit; the free column is what any unknown element gets
  { id: 'free', label: 'generic node, free (round 2 default)', html: `<p>Before</p><x-card><x-title id="f">Card</x-title><x-note id="t">${T}</x-note></x-card><p>After</p>`, prev: 'Card', next: 'After', first: 'Card', protectedStructure: true, unit: true },
  { id: 'locked', label: 'generic node, structure-locked (round 1, comparison)', html: `<p>Before</p><x-card data-edit="locked"><x-title id="f">Card</x-title><x-note id="t">${T}</x-note></x-card><p>After</p>`, prev: 'Card', next: 'After', first: 'Card', protectedStructure: true, unit: true },
  { id: 'island', label: 'island leaf (spike 04, comparison)', html: `<p>Before</p><x-card data-edit="island"><x-title id="f">Card</x-title><x-note id="t">${T}</x-note></x-card><p>After</p>`, prev: 'Card', next: 'After', first: 'Card', protectedStructure: true, unit: true },
  {
    id: 'svgText',
    label: 'SVG <text> as PM node (experiment)',
    html: `<p>Before</p><svg width="320" height="60" viewBox="0 0 320 60" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="310" height="50" fill="#eef3fb" stroke="#4a78c2"/><text id="t" x="20" y="35" font-family="sans-serif" font-size="16">${T}</text></svg><p>After</p>`,
    prev: 'Before',
    next: 'After',
    first: 'Alpha beta g',
    svgNodes: true,
    protectedStructure: false,
    unit: false,
  },
]

// ---------------------------------------------------------------- page helpers (installed once per page)
const HELPERS = `
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const ed = () => window.__editor
  window.__findEl = (id) => {
    let el = document.querySelector('.tiptap #' + id)
    if (!el) for (const h of document.querySelectorAll('.island-host')) { el = h.shadowRoot && h.shadowRoot.querySelector('#' + id); if (el) break }
    return el
  }
  window.__caretXY = (id, idx) => {
    const el = window.__findEl(id)
    if (!el) return null
    if (el.namespaceURI === SVG_NS) {
      const n = el.getNumberOfChars()
      const ctm = el.getScreenCTM()
      if (n === 0) { const b = el.getBoundingClientRect(); return { x: b.left + 1, y: b.top + Math.max(1, b.height / 2) } }
      const p = idx >= n ? el.getEndPositionOfChar(n - 1) : el.getStartPositionOfChar(idx)
      const ext = el.getExtentOfChar(Math.max(0, Math.min(idx, n - 1)))
      const pt = new DOMPoint(p.x, ext.y + ext.height / 2).matrixTransform(ctm)
      return { x: pt.x, y: pt.y }
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let acc = 0, node
    while ((node = walker.nextNode())) {
      const len = node.textContent.length
      if (idx <= acc + len) {
        const r = document.createRange()
        r.setStart(node, idx - acc); r.collapse(true)
        const rect = r.getClientRects()[0] || r.getBoundingClientRect()
        return { x: rect.left, y: rect.top + rect.height / 2 }
      }
      acc += len
    }
    const rect = el.getBoundingClientRect()
    return { x: rect.left + 2, y: rect.top + rect.height / 2 }
  }
  const short = (n) => {
    const t = n.type.name
    if (t === 'paragraph') return 'p'
    if (t === 'heading') return 'h' + n.attrs.level
    if (t.startsWith('generic')) return n.attrs.tag
    if (t.startsWith('svg')) return t === 'svgRoot' ? 'svg' : t === 'svgText' ? 'text' : n.attrs.tag
    if (t === 'htmlIsland' || t === 'htmlIslandInline') return 'island'
    if (t === 'container') return n.attrs.tag
    if (t === 'bulletList') return 'ul'
    if (t === 'orderedList') return 'ol'
    if (t === 'listItem') return 'li'
    if (t === 'hardBreak') return 'br'
    if (t === 'tableRow') return 'tr'
    if (t === 'tableCell') return 'td'
    if (t === 'tableHeader') return 'th'
    return t
  }
  const tree = (n) => {
    const kids = []
    n.forEach((c) => { if (!c.isText) kids.push(tree(c)) })
    return short(n) + (kids.length ? '(' + kids.join(',') + ')' : '')
  }
  window.__tree = () => { const out = []; ed().state.doc.forEach((n) => out.push(tree(n))); return out.join(',') }
  window.__docText = () => ed().state.doc.textBetween(0, ed().state.doc.content.size, '|', '\\u25a1')
  window.__units = () => { let n = 0; ed().state.doc.descendants((x) => { if (x.type.name.startsWith('generic') || x.type.name === 'container' || x.type.name.startsWith('htmlIsland')) n++ }); return n }
  window.__targetText = (id) => {
    let text = null
    ed().state.doc.descendants((n) => {
      if (text !== null || n.isText) return
      const a = n.attrs || {}
      const nid = (a.attrs && a.attrs.id) || (a.htmlAttrs && a.htmlAttrs.id) || (a.id)
      if (nid === id) { text = n.isTextblock ? n.textContent : '<' + short(n) + '>'; return false }
      if ((n.type.name === 'htmlIsland' || n.type.name === 'htmlIslandInline') && String(a.html).includes('id="' + id + '"')) {
        const doc = new DOMParser().parseFromString(a.html, 'text/html')
        const el = doc.getElementById(id)
        text = el ? el.textContent : null
        return false
      }
    })
    return text
  }
  window.__targetHtml = (id) => {
    const el = window.__findEl(id)
    return el ? el.outerHTML : null
  }
  window.__caret = () => {
    const s = ed().state.selection
    if (s.node) return 'node:' + short(s.node)
    const $f = s.$from
    const parent = $f.parent
    const where = parent.type.name === 'doc' ? 'doc' : short(parent)
    const txt = parent.textContent
    return where + '@' + $f.parentOffset + (s.empty ? '' : ' sel="' + ed().state.doc.textBetween(s.from, s.to, '|') + '"') + (parent.isTextblock ? ' "' + txt.slice(0, 12) + '"' : '')
  }
  window.__caretOffset = (id) => {
    const el = window.__findEl(id)
    if (!el) return null
    const rootNode = el.getRootNode()
    if (rootNode instanceof ShadowRoot) {
      const s = rootNode.getSelection ? rootNode.getSelection() : null
      if (!s || !s.anchorNode || !el.contains(s.anchorNode)) return null
      return s.anchorOffset
    }
    const st = ed().state.selection
    if (st.node) return null
    const $f = st.$from
    const dom = ed().view.nodeDOM($f.before($f.depth))
    if (dom !== el && !(dom && dom.contains && dom.contains(el)) && !(el.contains && el.contains(dom))) return null
    return $f.parentOffset
  }
  window.__selText = () => {
    const sel = window.getSelection()
    const s = ed().state.selection
    const pm = s.empty ? '' : ed().state.doc.textBetween(s.from, s.to, '|')
    // inside an island the selection lives in the shadow root
    let shadow = ''
    for (const h of document.querySelectorAll('.island-host')) { const r = h.shadowRoot; if (r && r.getSelection) { const ss = r.getSelection(); if (ss && ss.toString()) shadow = ss.toString() } }
    return pm || shadow || (sel ? sel.toString() : '')
  }
  window.__pasteHtml = (html, text) => {
    const dt = new DataTransfer()
    dt.setData('text/html', html)
    dt.setData('text/plain', text)
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : ed().view.dom
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    target.dispatchEvent(ev)
    return target.tagName
  }
  window.__focused = () => {
    const a = document.activeElement
    const inShadow = a && a.shadowRoot && a.shadowRoot.activeElement
    return inShadow ? 'island:' + inShadow.tagName.toLowerCase() : a ? (a.classList.contains('tiptap') ? 'editor' : a.tagName.toLowerCase()) : 'none'
  }
})()
`

interface Obs {
  target: string | null
  doc: string
  tree: string
  extra: string
}
const obsString = (o: Obs) => `target=${JSON.stringify(o.target)} doc=${JSON.stringify(o.doc)} tree=${o.tree}${o.extra ? ' ' + o.extra : ''}`

interface Ctx {
  page: Page
  kind: Kind
  mod: string
  cdp: import('playwright').CDPSession
  click: (idx: number, opts?: { clickCount?: number; shift?: boolean; id?: string }) => Promise<void>
  /** keyboard.press + a short wait: ProseMirror reads the DOM selection asynchronously (spike 02 finding) */
  key: (name: string) => Promise<void>
  clickText: (text: string, idx: number, clickCount?: number, shift?: boolean) => Promise<void>
  obs: (extra?: string) => Promise<Obs>
  ev: <T>(fn: string) => Promise<T>
}

type Verdict = 'ok' | 'broken' | 'guarded'
interface Row {
  id: string
  label: string
  run: (c: Ctx) => Promise<string | void>
  /** did the interaction do what it does in a plain paragraph? */
  ideal: (o: Obs, k: Kind, start: Obs) => boolean
  /** cells this row does not apply to */
  skip?: (k: Kind) => string | null
  /** "nothing happened" is not a guard for this row (probing rows: caret, selection, undo, hover) */
  noGuard?: boolean
}

const verdictOf = (row: Row, o: Obs, k: Kind, start: Obs): Verdict => {
  if (row.ideal(o, k, start)) return 'ok'
  if (o.extra.includes('guard=')) return 'guarded' // the structure lock rejected a transaction
  if (!row.noGuard && k.protectedStructure && o.tree === start.tree) return 'guarded' // structure intact (island: native editing stays inside the leaf)
  return 'broken'
}

// ---------------------------------------------------------------- rows
const EXT_HTML = '<p>Ext <b>bold</b></p><ul><li>item one</li></ul>'
const ROWS: Row[] = [
  { id: 'type', noGuard: true, label: 'typing in the middle', run: async (c) => { await c.click(6); await c.page.keyboard.type('X') }, ideal: (o) => o.target === 'Alpha Xbeta gamma' },
  { id: 'bs-start', label: 'Backspace at start', run: async (c) => { await c.click(0); await c.key('Backspace') }, ideal: (o, k) => o.doc.includes(`${k.prev}Alpha beta gamma`) },
  { id: 'bs-mid', noGuard: true, label: 'Backspace in the middle', run: async (c) => { await c.click(6); await c.key('Backspace') }, ideal: (o, _k, s) => o.target === 'Alphabeta gamma' && o.tree === s.tree },
  { id: 'bs-end', noGuard: true, label: 'Backspace at end', run: async (c) => { await c.click(16); await c.key('Backspace') }, ideal: (o, _k, s) => o.target === 'Alpha beta gamm' && o.tree === s.tree },
  { id: 'del-start', noGuard: true, label: 'Delete at start', run: async (c) => { await c.click(0); await c.key('Delete') }, ideal: (o, _k, s) => o.target === 'lpha beta gamma' && o.tree === s.tree },
  { id: 'del-mid', noGuard: true, label: 'Delete in the middle', run: async (c) => { await c.click(6); await c.key('Delete') }, ideal: (o, _k, s) => o.target === 'Alpha eta gamma' && o.tree === s.tree },
  { id: 'del-end', label: 'Delete at end', run: async (c) => { await c.click(16); await c.key('Delete') }, ideal: (o, k) => o.doc.includes(`Alpha beta gamma${k.next}`) },
  {
    id: 'cross-del',
    label: 'selection from "Before" into the target, Backspace',
    run: async (c) => { await c.clickText('Before', 3); await c.click(6, { shift: true }); await c.key('Backspace') },
    ideal: (o) => o.doc.startsWith('Befbeta gamma'),
  },
  {
    id: 'cross-del-out',
    label: 'selection from the target into "After", Backspace',
    run: async (c) => { await c.click(6); await c.clickText('After', 3, 1, true); await c.key('Backspace') },
    ideal: (o) => o.doc.includes('Alpha er'),
  },
  {
    id: 'bs-first',
    label: 'Backspace at the start of the element\'s first child',
    run: async (c) => { await c.click(0, { id: 'f' }); await c.key('Backspace') },
    ideal: (o, k) => o.doc.includes(`Before${k.first}`),
    skip: (k) => (!k.unit ? 'no enclosing element' : null),
  },
  {
    id: 'del-first-end',
    label: 'Delete at the end of the first child (would pull the target in)',
    run: async (c) => { await c.click(4, { id: 'f' }); await c.key('Delete') },
    ideal: (o, k) => o.doc.includes(`${k.first}${T}`),
    skip: (k) => (!k.unit ? 'no enclosing element' : null),
  },
  {
    id: 'inner-del',
    label: 'select first child → end of target (inside the element), Backspace',
    run: async (c) => { await c.click(0, { id: 'f' }); await c.click(16, { shift: true }); await c.key('Backspace'); return `units=${await c.ev<number>('__units()')}` },
    ideal: (o, k, s) => !o.doc.includes(k.first) && !o.doc.includes('Alpha') && o.extra.startsWith(`units=${s.extra.replace('units=', '')}`),
    skip: (k) => (!k.unit ? 'no enclosing element' : null),
  },
  { id: 'enter', label: 'Enter in the middle', run: async (c) => { await c.click(6); await c.key('Enter'); return `dupId=${(await c.ev<number>('document.querySelectorAll(\'[id="t"]\').length')) > 1 ? 'yes' : 'no'}` }, ideal: (o) => o.doc.includes('Alpha |beta gamma') && !o.tree.includes('text,text') && !o.extra.includes('dupId=yes') },
  { id: 'enter-end', label: 'Enter at the end, type "new"', run: async (c) => { await c.click(16); await c.key('Enter'); await c.page.keyboard.type('new') }, ideal: (o) => o.doc.includes(`${T}|new`) && !o.tree.includes('text,text') },
  { id: 'shift-enter', label: 'Shift+Enter in the middle', run: async (c) => { await c.click(6); await c.key('Shift+Enter'); return `br=${/<br/.test((await c.ev<string>('__targetHtml("t")')) ?? '') ? 'in-target' : 'elsewhere'}` }, ideal: (o, _k, s) => o.extra.startsWith('br=in-target') && o.target === T && o.doc.replace('\u25a1', '') === s.doc },
  { id: 'tab', noGuard: true, label: 'Tab', run: async (c) => { await c.click(6); await c.key('Tab'); return `focus=${await c.ev<string>('__focused()')}` }, ideal: (o, _k, s) => o.target === s.target && o.tree === s.tree && o.extra.includes('focus=editor') },
  { id: 'select-all-type', label: 'select all, then type', run: async (c) => { await c.click(6); await c.key(`${c.mod}+a`); await c.page.keyboard.type('Z') }, ideal: (o) => o.doc === 'Z' },
  { id: 'select-all-del', label: 'select all, then Backspace', run: async (c) => { await c.click(6); await c.key(`${c.mod}+a`); await c.key('Backspace') }, ideal: (o) => o.doc === '' },
  { id: 'dblclick', noGuard: true, label: 'double-click a word', run: async (c) => { await c.click(8, { clickCount: 2 }); return `selected=${JSON.stringify(await c.ev<string>('__selText()'))}` }, ideal: (o) => o.extra === 'selected="beta"' },
  { id: 'tripleclick', noGuard: true, label: 'triple-click', run: async (c) => { await c.click(8, { clickCount: 3 }); return `selected=${JSON.stringify((await c.ev<string>('__selText()')).trim())}` }, ideal: (o) => o.extra === `selected="${T}"` },
  { id: 'arrow-in', noGuard: true, label: '→ from the end of "Before" into the target', run: async (c) => { await c.clickText('Before', 6); await c.key('ArrowRight'); return `caret=${await c.ev<string>('__caret()')}` }, ideal: (o, k) => o.extra.includes(`@0 "${k.first}`) },
  { id: 'arrow-out', noGuard: true, label: '→ from the end of the target', run: async (c) => { await c.click(16); await c.key('ArrowRight'); return `caret=${await c.ev<string>('__caret()')}` }, ideal: (o, k) => new RegExp(`@0 "${k.next}`).test(o.extra) },
  { id: 'arrow-down-out', noGuard: true, label: '↓ from inside the target', run: async (c) => { await c.click(6); await c.key('ArrowDown'); return `caret=${await c.ev<string>('__caret()')}` }, ideal: (o, k) => o.extra.includes(`"${k.next}`) },
  {
    id: 'cut-paste',
    noGuard: true,
    label: 'cut "beta ", paste it at the end (within)',
    run: async (c) => { await c.click(6); await c.click(11, { shift: true }); await c.key(`${c.mod}+x`); for (let i = 0; i < 5; i++) await c.key('ArrowRight'); await c.key(`${c.mod}+v`) },
    ideal: (o, _k, s) => o.target === 'Alpha gammabeta ' && o.tree === s.tree,
  },
  {
    id: 'copy-out',
    noGuard: true,
    label: 'copy "beta", paste at the end of "After"',
    run: async (c) => { await c.click(6); await c.click(10, { shift: true }); await c.key(`${c.mod}+c`); await c.clickText('After', 5); await c.key(`${c.mod}+v`) },
    ideal: (o, _k, s) => o.doc.includes('Afterbeta') && o.target === s.target,
  },
  {
    id: 'copy-block-out',
    noGuard: true,
    label: 'triple-click the target, copy, paste at the end of "After"',
    run: async (c) => { await c.click(8, { clickCount: 3 }); await c.key(`${c.mod}+c`); await c.clickText('After', 5); await c.key(`${c.mod}+v`) },
    ideal: (o) => o.doc.includes(`After${T}`) || o.doc.includes(`After|${T}`),
  },
  {
    id: 'paste-text',
    noGuard: true,
    label: 'double-click "Before", copy, paste in the middle of the target',
    run: async (c) => { await c.clickText('Before', 3, 2); await c.key(`${c.mod}+c`); await c.click(6); await c.key(`${c.mod}+v`) },
    ideal: (o, _k, s) => o.target === 'Alpha Beforebeta gamma' && o.tree === s.tree,
  },
  {
    id: 'paste-html',
    label: 'paste external HTML (p + list) in the middle (synthetic paste event)',
    run: async (c) => { await c.click(6); return `into=${await c.ev<string>(`__pasteHtml(${JSON.stringify(EXT_HTML)}, 'Ext bold item one')`)}` },
    ideal: (o) => o.doc.includes('Ext bold') && o.doc.includes('item one') && o.tree.includes('ul(li(p))'),
    skip: (k) => (k.id === 'island' ? 'plaintext-only leaf in a shadow root: a native paste inserts plain text, a synthetic paste event cannot be aimed at it' : null),
  },
  {
    id: 'drag-block',
    label: 'drag handle: drag the block below "After"',
    run: async (c) => {
      const xy = await c.ev<{ x: number; y: number }>('__caretXY("t", 6)')
      await c.page.mouse.move(xy.x, xy.y)
      await sleep(250)
      const grip = c.page.getByTestId('bh-grip')
      const g = await grip.boundingBox()
      if (!g) return 'handle=none'
      const after = await c.page.evaluate(() => { const ps = Array.from(document.querySelectorAll('.tiptap > p')); const el = ps.find((p) => p.textContent === 'After')!; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height } })
      await c.page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
      await c.page.mouse.down()
      await c.page.mouse.move(after.x + after.w - 4, after.y + after.h - 2, { steps: 12 })
      await c.page.mouse.move(after.x + after.w - 2, after.y + after.h - 1, { steps: 3 })
      await c.page.mouse.up()
      await sleep(200)
      return 'handle=shown'
    },
    ideal: (o, _k, s) => o.extra === 'handle=shown' && o.target === s.target && o.doc.replace(/\|$/, '') === `Before|After|${s.doc.replace(/^Before\|/, '').replace(/\|After$/, '')}`,
  },
  {
    id: 'drag-text',
    label: 'drag selected "beta" onto the end of "After"',
    run: async (c) => {
      await c.click(6)
      await c.click(10, { shift: true })
      const from = await c.ev<{ x: number; y: number }>('__caretXY("t", 8)')
      const to = await c.ev<{ x: number; y: number }>('(() => { const el = Array.from(document.querySelectorAll(".tiptap p")).find((p) => p.textContent.startsWith("After")); const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return { x: b.right - 1, y: b.top + b.height / 2 } })()')
      await c.ev('(() => { window.__drags = 0; document.addEventListener("dragstart", () => window.__drags++, { once: true }) })()')
      await c.page.mouse.move(from.x, from.y)
      await c.page.mouse.down()
      await c.page.mouse.move(from.x + 10, from.y + 2, { steps: 6 })
      await c.page.mouse.move(to.x, to.y, { steps: 20 })
      await c.page.mouse.up()
      await sleep(200)
      return `dragstart=${await c.ev<number>('window.__drags')}`
    },
    ideal: (o) => o.target === 'Alpha  gamma' && o.doc.includes('Afterbeta'),
    // measured in the first runs on every kind: `dragstart` never fires for a mouse-driven text drag in headless
    // Chromium (Playwright synthesises drag events only for draggable elements), so the row cannot be automated
    skip: () => 'not automatable: headless Chromium starts no native text drag (dragstart=0 on every kind)',
  },
  {
    id: 'undo',
    noGuard: true,
    label: 'type "one two", pause, type "X", undo ×2, redo ×2',
    run: async (c) => {
      await c.click(16)
      await c.page.keyboard.type(' one two', { delay: 15 })
      await sleep(700)
      await c.page.keyboard.type('X')
      await sleep(50)
      await c.key(`${c.mod}+z`)
      await sleep(50)
      const u1 = await c.ev<string>('__targetText("t")')
      await c.key(`${c.mod}+z`)
      await sleep(50)
      const u2 = await c.ev<string>('__targetText("t")')
      await c.key(`${c.mod}+Shift+z`)
      await c.key(`${c.mod}+Shift+z`)
      await sleep(50)
      return `undo1=${JSON.stringify(u1)} undo2=${JSON.stringify(u2)}`
    },
    ideal: (o) => o.target === `${T} one twoX` && o.extra === `undo1="${T} one two" undo2="${T}"`,
  },
  {
    id: 'ime',
    noGuard: true,
    label: 'IME composition (CDP): compose にほ, commit 日本',
    run: async (c) => {
      await c.click(6)
      await c.cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 })
      await sleep(60)
      const mid = await c.ev<string>('__targetText("t")')
      await c.cdp.send('Input.insertText', { text: '日本' })
      await sleep(60)
      return `mid=${JSON.stringify(mid)}`
    },
    ideal: (o) => o.target === 'Alpha 日本beta gamma',
  },
  { id: 'slash-h2', label: 'slash menu: /h2 (turn into heading 2)', run: async (c) => { await c.click(16); await c.page.keyboard.type(' /h2'); await c.page.getByTestId('slash-menu').waitFor({ timeout: 1500 }).catch(() => {}); await c.key('Enter'); await sleep(100) }, ideal: (o) => o.tree.includes('h2') && o.doc.includes(T) },
  { id: 'slash-list', label: 'slash menu: /bullet (toggle bullet list)', run: async (c) => { await c.click(16); await c.page.keyboard.type(' /bullet'); await c.page.getByTestId('slash-menu').waitFor({ timeout: 1500 }).catch(() => {}); await c.key('Enter'); await sleep(100) }, ideal: (o) => o.tree.includes('ul(li(p') && o.doc.includes(T) },
  { id: 'slash-table', label: 'slash menu: /table (insert 3×3 table)', run: async (c) => { await c.click(16); await c.page.keyboard.type(' /table'); await c.page.getByTestId('slash-menu').waitFor({ timeout: 1500 }).catch(() => {}); await c.key('Enter'); await sleep(100) }, ideal: (o) => o.tree.includes('table(') && o.doc.includes(T) },
  { id: 'slash-callout', label: 'slash menu: /callout', run: async (c) => { await c.click(16); await c.page.keyboard.type(' /callout'); await c.page.getByTestId('slash-menu').waitFor({ timeout: 1500 }).catch(() => {}); await c.key('Enter'); await sleep(100) }, ideal: (o) => o.tree.includes('callout(') && o.doc.includes(T) },
  { id: 'bold', label: 'select "beta", ⌘B', run: async (c) => { await c.click(6); await c.click(10, { shift: true }); await c.key(`${c.mod}+b`); return `html=${/<(strong|b)>beta<\/(strong|b)>/.test((await c.ev<string>('__targetHtml("t")')) ?? '') ? 'bold' : 'plain'}` }, ideal: (o) => o.extra === 'html=bold' },
  { id: 'underline', label: 'select "beta", ⌘U (not in the locked mark list)', run: async (c) => { await c.click(6); await c.click(10, { shift: true }); await c.key(`${c.mod}+u`); return `html=${/<u>beta<\/u>/.test((await c.ev<string>('__targetHtml("t")')) ?? '') ? 'underlined' : 'plain'}` }, ideal: (o) => o.extra === 'html=underlined' },
  { id: 'bubble', noGuard: true, label: 'select "beta": does the text bubble menu appear?', run: async (c) => { await c.click(6); await c.click(10, { shift: true }); await sleep(300); return `bubble=${(await c.page.locator('.text-bubble').count()) > 0 && (await c.page.locator('.text-bubble').isVisible()) ? 'shown' : 'hidden'}` }, ideal: (o) => o.extra === 'bubble=shown' },
  {
    id: 'handle',
    noGuard: true,
    label: 'hover: which block does the drag handle grip select?',
    run: async (c) => { const xy = await c.ev<{ x: number; y: number }>('__caretXY("t", 6)'); await c.page.mouse.move(xy.x, xy.y); await sleep(250); const grip = c.page.getByTestId('bh-grip'); if (!(await grip.count()) || !(await grip.isVisible())) return 'handle=none'; await grip.click(); await sleep(100); const sel = await c.ev<string>('__caret()'); await c.key('Escape'); return `handle=${sel}` },
    ideal: (o) => o.extra.startsWith('handle=node:'),
  },
  {
    id: 'empty',
    noGuard: true,
    label: 'select the target text (triple-click), Backspace: does an empty element remain, clickable, saved?',
    run: async (c) => {
      await c.click(8, { clickCount: 3 })
      await c.key('Backspace')
      await sleep(80)
      const html = await c.ev<string | null>('__targetHtml("t")')
      const box = await c.ev<{ w: number; h: number } | null>('(() => { const el = __findEl("t"); if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) } })()')
      // click it again and type
      const xy = await c.ev<{ x: number; y: number } | null>('__caretXY("t", 0)')
      if (xy) { await c.page.mouse.click(xy.x + 2, xy.y); await sleep(80); await c.page.keyboard.type('Re') }
      const saved = await c.ev<string>('(() => { const h = __islands.expandIslands(__editor.getHTML()); return h.includes(\'id="t"\') ? "element-kept" : "element-gone" })()')
      return `emptyHtml=${html ? 'present' : 'gone'} box=${box ? `${box.w}x${box.h}` : 'none'} saved=${saved}`
    },
    ideal: (o) => o.target === 'Re' && o.extra.includes('emptyHtml=present') && !o.extra.includes('box=0x0') && o.extra.includes('element-kept'),
  },
  {
    id: 'delete-widget',
    label: 'delete UI: hover the element → trash → preview (overlay + summary) → click deletes the element',
    run: async (c) => {
      const xy = await c.ev<{ x: number; y: number }>('__caretXY("t", 6)')
      await c.page.mouse.move(xy.x, xy.y)
      await sleep(150)
      const btn = c.page.getByTestId('delete-widget')
      if (!(await btn.isVisible().catch(() => false))) return 'widget=none'
      await btn.hover()
      await sleep(100)
      const overlay = await c.page.locator('.dw-overlay').count()
      const summary = (await c.page.getByTestId('delete-summary').textContent()) ?? ''
      await btn.click()
      await sleep(100)
      return `widget=shown overlay=${overlay} summary=${JSON.stringify(summary)}`
    },
    ideal: (o) => o.target === null && o.extra.startsWith('widget=shown overlay=1'),
    skip: (k) => (!k.unit ? 'no element to delete (the delete UI covers generic nodes, containers and islands)' : null),
  },
  {
    id: 'nodesel-del',
    noGuard: true,
    label: 'keyboard: block handle grip selects the block, Backspace → confirm bar → Enter deletes',
    run: async (c) => {
      const xy = await c.ev<{ x: number; y: number }>('__caretXY("t", 6)')
      await c.page.mouse.move(xy.x, xy.y)
      await sleep(250)
      const grip = c.page.getByTestId('bh-grip')
      if (!(await grip.count()) || !(await grip.isVisible())) return 'handle=none'
      await grip.click()
      await sleep(100)
      await c.key('Escape') // closes the block menu, keeps the NodeSelection
      const sel = await c.ev<string>('__caret()')
      await c.key('Backspace')
      await sleep(120)
      const bar = c.page.getByTestId('delete-bar')
      const shown = await bar.isVisible().catch(() => false)
      const text = shown ? ((await bar.locator('.dw-bar-text').textContent()) ?? '') : ''
      if (shown) await c.key('Enter')
      await sleep(100)
      return `sel=${sel} confirm=${shown ? 'shown' : 'none'}${text ? ' ' + JSON.stringify(text) : ''}`
    },
    ideal: (o, k) => o.target === null && o.extra.includes(k.unit ? 'confirm=shown' : 'confirm=none'),
    skip: (k) => (k.id === 'svgText' ? 'experiment column' : null),
  },
]

// ---------------------------------------------------------------- driving
async function makeCtx(page: Page, kind: Kind): Promise<Ctx> {
  const cdp = await page.context().newCDPSession(page)
  const ev = <T,>(fn: string) => page.evaluate(fn) as Promise<T>
  const click: Ctx['click'] = async (idx, opts = {}) => {
    const id = opts.id ?? 't'
    const xy = await ev<{ x: number; y: number } | null>(`__caretXY(${JSON.stringify(id)}, ${idx})`)
    if (!xy) throw new Error(`no caret position for #${id}@${idx}`)
    if (opts.shift) await page.keyboard.down('Shift')
    await page.mouse.click(xy.x + 0.5, xy.y, { clickCount: opts.clickCount ?? 1 })
    if (opts.shift) await page.keyboard.up('Shift')
    await sleep(150) // ProseMirror syncs the click's DOM selection asynchronously; a key sent earlier can be lost
    // a click lands on the nearest caret position; correct off-by-one placements with arrow keys so every row
    // starts where it says
    if (!opts.shift && (opts.clickCount ?? 1) === 1) {
      for (let i = 0; i < 4; i++) {
        const at = await ev<number | null>(`__caretOffset(${JSON.stringify(id)})`)
        if (at === null || at === idx) break
        await page.keyboard.press(at < idx ? 'ArrowRight' : 'ArrowLeft')
        await sleep(45)
      }
    }
  }
  const clickText: Ctx['clickText'] = async (text, idx, clickCount = 1, shift = false) => {
    const xy = await ev<{ x: number; y: number } | null>(`(() => { const el = Array.from(document.querySelectorAll('.tiptap p, .tiptap h3')).find((p) => p.textContent === ${JSON.stringify(text)}); if (!el) return null; const r = document.createRange(); r.setStart(el.firstChild, ${idx}); r.collapse(true); const b = r.getClientRects()[0] || r.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2 } })()`)
    if (!xy) throw new Error(`no block with text ${text}`)
    if (shift) await page.keyboard.down('Shift')
    await page.mouse.click(xy.x + 0.5, xy.y, { clickCount })
    if (shift) await page.keyboard.up('Shift')
    await sleep(150)
  }
  const obs: Ctx['obs'] = async (extra = '') => ({
    target: await ev<string | null>('__targetText("t")'),
    doc: await ev<string>('__docText()'),
    tree: await ev<string>('__tree()'),
    extra,
  })
  const key = async (name: string) => {
    await page.keyboard.press(name)
    await sleep(60)
  }
  return { page, kind, mod: 'ControlOrMeta', cdp, click, key, clickText, obs, ev }
}

async function load(page: Page, kind: Kind) {
  await page.evaluate(([html, svg]) => {
    const w = window as any
    w.__policy.svg = svg ? 'nodes' : 'island'
    w.__guardLog = []
    w.__load(html)
    w.__editor.commands.blur()
  }, [kind.html, !!kind.svgNodes] as const)
  // Chromium's multi-click counter spans cells: a double-click 300 ms after the previous cell's click is a
  // triple-click. Wait out the double-click interval (500 ms) before every cell.
  await sleep(560)
}

interface Cell {
  verdict: Verdict
  obs: string
}
const results = new Map<string, Cell>()
const key = (r: string, k: string) => `${r}/${k}`

async function runPlain(page: Page, rows = ROWS, kinds = KINDS, suffix = '') {
  await page.evaluate(HELPERS)
  for (const row of rows) {
    if (ONLY && row.id !== ONLY) continue
    for (const kind of kinds) {
      const skipReason = row.skip?.(kind)
      if (skipReason) {
        results.set(key(row.id, kind.id) + suffix, { verdict: 'ok', obs: `n/a: ${skipReason}` })
        continue
      }
      await load(page, kind)
      const ctx = await makeCtx(page, kind)
      const start = await ctx.obs()
      let extra = ''
      let error = ''
      try {
        extra = (await row.run(ctx)) ?? ''
      } catch (e) {
        error = (e as Error).message.split('\n')[0]
      }
      await sleep(60)
      const o = await ctx.obs(extra)
      const guards = await page.evaluate(() => ((window as any).__guardLog ?? []) as string[])
      if (guards.length) o.extra += `${o.extra ? ' ' : ''}guard=${JSON.stringify(guards[0].slice(0, 60))}`
      if (error) o.extra += ` error=${JSON.stringify(error.slice(0, 80))}`
      const verdict = verdictOf(row, o, kind, start)
      results.set(key(row.id, kind.id) + suffix, { verdict, obs: obsString(o) })
      await ctx.cdp.detach().catch(() => {})
    }
    process.stdout.write(`${(row.id + suffix).padEnd(22)} ${kinds.map((k) => (results.get(key(row.id, k.id) + suffix)?.verdict ?? '-').padEnd(8)).join(' ')}\n`)
  }
}

// ---------------------------------------------------------------- the isolating trade-off (round 2)
/** rows whose outcome depends on `isolating: true`; re-run with ?isolating=0 on the two protected block kinds */
const ISO_ROWS = ['bs-start', 'bs-first', 'del-end', 'del-first-end', 'cross-del', 'cross-del-out', 'inner-del', 'enter', 'paste-html', 'slash-list']
const ISO_KINDS = ['container', 'free']
const NOISO = '@isolating=0'

// ---------------------------------------------------------------- concurrency rows (collab mode)
function combinedFixture(): string {
  const parts = KINDS.map((k) => k.html.replace('id="t"', `id="t-${k.id}"`).replace(T, `${k.id} alpha beta gamma`))
  return `<!doctype html><html><head><meta charset="utf-8"><title>matrix collab</title><style>x-card{display:block;border:1px solid #ccc;padding:6px;margin:8px 0} x-card>x-title,x-card>x-note{display:block}</style></head><body>\n${parts.join('\n')}\n</body></html>`
}

function agent(url: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', 'agent/agent.ts', '--server', url, '--json', '--linger', '100', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (out += d.toString()))
    proc.on('exit', (code) => resolve({ code, out }))
  })
}

async function runCollab(browser: Browser, url: string) {
  const a = await browser.newPage({ viewport: { width: 1100, height: 1200 } })
  const b = await browser.newPage({ viewport: { width: 1100, height: 1200 } })
  for (const p of [a, b]) {
    await p.goto(`${url}/?user=${p === a ? 'Ann' : 'Bob'}&svg=nodes`)
    await p.locator('.tiptap p').first().waitFor({ timeout: 15000 })
    await sleep(600)
    await p.evaluate(HELPERS)
  }
  const synced = async (p: Page) => {
    const t0 = Date.now()
    while (Date.now() - t0 < 8000) {
      const st = await p.evaluate(() => { const pr = (window as any).__provider; return pr.isSynced && pr.unsyncedChanges === 0 })
      if (st) break
      await sleep(50)
    }
  }
  for (const kind of KINDS) {
    const id = `t-${kind.id}`
    const text = `${kind.id} alpha beta gamma`
    const ctxA = await makeCtx(a, kind)
    const ctxB = await makeCtx(b, kind)
    // row: two clients typing concurrently in the same node (A at the start, B at the end)
    if (!ONLY || ONLY === 'concurrent') {
      await ctxA.click(0, { id })
      await ctxB.click(text.length, { id })
      await Promise.all([a.keyboard.type('AAA', { delay: 40 }), b.keyboard.type('BBB', { delay: 40 })])
      await sleep(900)
      await synced(a)
      await synced(b)
      await sleep(300)
      const ta = await a.evaluate((i) => (window as any).__targetText(i), id)
      const tb = await b.evaluate((i) => (window as any).__targetText(i), id)
      const ideal = ta === `AAA${text}BBB` && tb === ta
      const verdict: Verdict = ideal ? 'ok' : 'broken'
      // an island is one Y attribute: which side wins depends on Yjs client ids (spike 07) → record the shape, not the winner
      const lww = ta === tb && (ta === `AAA${text}` || ta === `${text}BBB`)
      results.set(key('concurrent', kind.id), { verdict, obs: lww ? `one side lost (last writer wins per island), both clients agree: ${JSON.stringify(ta.replace(/AAA|BBB/, ''))} + the winner's text` : `A=${JSON.stringify(ta)} B=${JSON.stringify(tb)}` })
    }
    // row: agent op on the node while the user types in it
    if (!ONLY || ONLY === 'agent') {
      const cur = (await a.evaluate((i) => (window as any).__targetText(i), id)) as string
      await ctxA.click(0, { id })
      // the concurrent row may have split the kind's name (caret placement in SVG text): search around "alpha"
      const i = cur.indexOf('alpha')
      const find = cur.slice(Math.max(0, i - 4), i + 5)
      const op = kind.id === 'island' ? ['set-island-text', find, find.replace('alpha', 'ALPHA')] : ['replace-text', find, find.replace('alpha', 'ALPHA')]
      const run = agent(url, [...op, '--lock-timeout', '300'])
      await sleep(250)
      await a.keyboard.type('UU', { delay: 30 })
      const r = await run
      await sleep(700)
      await synced(a)
      const ta = (await a.evaluate((i) => (window as any).__targetText(i), id)) as string
      const expect = `UU${cur.replace(find, find.replace('alpha', 'ALPHA'))}`
      const j = (() => { try { return JSON.parse(r.out.split('\n').find((l) => l.startsWith('{')) ?? '{}') } catch { return {} } })()
      const ideal = ta === expect && r.code === 0
      const shown = kind.id === 'island' ? ta.replace(/AAA|BBB/, '') + ' + the winner\'s text' : ta // see the concurrent row
      results.set(key('agent', kind.id), { verdict: ideal ? 'ok' : r.code === 5 ? 'guarded' : 'broken', obs: `exit=${r.code} target=${JSON.stringify(shown)}${j.locked ? ' locked=' + j.lockedBy : ''}${r.code !== 0 && r.code !== 5 ? ' ' + r.out.trim().slice(0, 100) : ''}` })
    }
    await ctxA.cdp.detach().catch(() => {})
    await ctxB.cdp.detach().catch(() => {})
  }
  for (const r of ['concurrent', 'agent']) process.stdout.write(`${r.padEnd(16)} ${KINDS.map((k) => (results.get(key(r, k.id))?.verdict ?? '-').padEnd(8)).join(' ')}\n`)
  await a.close()
  await b.close()
}

// ---------------------------------------------------------------- main
const COLLAB_ROWS = [
  { id: 'concurrent', label: 'two clients type in the same node at once (A at start, B at end)' },
  { id: 'agent', label: 'agent replace-text / set-island-text while the user types at the start' },
]

let server: ServerHandle | undefined
let browser: Browser | undefined
let failures = 0
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike10-matrix-'))
try {
  const plainDoc = path.join(tmp, 'plain.html')
  fs.copyFileSync(path.join(root, 'samples/battle.html'), plainDoc)
  const port = await freePort()
  server = await startServer(plainDoc, port)
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors: string[] = []
  const noise = /WebSocket|\[vite\]|Vite server/
  page.on('pageerror', (e) => !noise.test(String(e)) && errors.push(String(e)))
  await page.goto(`${server.url}/?collab=0`)
  await page.locator('.tiptap h1').first().waitFor({ timeout: 15000 })
  await sleep(300)
  console.log(`matrix: ${ROWS.length} rows × ${KINDS.length} kinds (plain mode)`)
  console.log(`${''.padEnd(22)} ${KINDS.map((k) => k.id.padEnd(8)).join(' ')}`)
  await runPlain(page)
  if (!ONLY) {
    console.log(`\nisolating trade-off: ${ISO_ROWS.length} rows × ${ISO_KINDS.join('/')} with ?isolating=0`)
    await page.goto(`${server.url}/?collab=0&isolating=0`)
    await page.locator('.tiptap h1').first().waitFor({ timeout: 15000 })
    await sleep(300)
    await runPlain(page, ROWS.filter((r) => ISO_ROWS.includes(r.id)), KINDS.filter((k) => ISO_KINDS.includes(k.id)), NOISO)
  }
  if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(' | ')}`)
  await page.close()
  await server.stop()
  // collaboration rows on their own document + server (svg as nodes so the svgText column exists there too)
  const collabDoc = path.join(tmp, 'collab.html')
  fs.writeFileSync(collabDoc, combinedFixture())
  server = await startServer(collabDoc, port, ['--svg', 'nodes'])
  await runCollab(browser, server.url)
} catch (e) {
  console.error(e)
  failures++
} finally {
  await browser?.close()
  if (server) await server.stop()
}

// ---------------------------------------------------------------- compare / record
const allRows = [...ROWS.map((r) => ({ id: r.id, label: r.label })), ...COLLAB_ROWS]
const expected: Record<string, Cell> = fs.existsSync(expectedPath) ? JSON.parse(fs.readFileSync(expectedPath, 'utf8')) : {}
if (RECORD || ONLY) {
  const merged = { ...expected }
  for (const [k, v] of results) merged[k] = v
  fs.writeFileSync(expectedPath, JSON.stringify(merged, null, 2) + '\n')
  console.log(`recorded ${results.size} cells → ${path.relative(root, expectedPath)}`)
} else {
  let same = 0
  for (const [k, v] of results) {
    const e = expected[k]
    if (!e) {
      console.log(`MISSING   ${k}: ${v.verdict} ${v.obs}`)
      failures++
    } else if (e.verdict !== v.verdict || e.obs !== v.obs) {
      console.log(`CHANGED   ${k}\n   expected: ${e.verdict} ${e.obs}\n   observed: ${v.verdict} ${v.obs}`)
      failures++
    } else same++
  }
  console.log(`matrix: ${same} cells as expected, ${failures} differ`)
}

// matrix.md: verdict table + the observations (+ the isolating trade-off)
const md: string[] = []
md.push(`| interaction | ${KINDS.map((k) => k.id).join(' | ')} |`)
md.push(`|---|${KINDS.map(() => '---').join('|')}|`)
const sym = (c?: Cell) => (!c ? '–' : c.obs.startsWith('n/a') ? 'n/a' : c.verdict === 'ok' ? 'ok' : c.verdict === 'guarded' ? '**guarded**' : '**broken**')
for (const r of allRows) md.push(`| ${r.label} | ${KINDS.map((k) => sym(results.get(key(r.id, k.id)))).join(' | ')} |`)
md.push('', '## isolating: true (default) vs ?isolating=0', '')
md.push(`| interaction | ${ISO_KINDS.map((k) => `${k} isolating`).join(' | ')} | ${ISO_KINDS.map((k) => `${k} not isolating`).join(' | ')} |`)
md.push(`|---|${ISO_KINDS.map(() => '---|---').join('|')}|`)
for (const r of allRows.filter((r) => ISO_ROWS.includes(r.id))) md.push(`| ${r.label} | ${ISO_KINDS.map((k) => sym(results.get(key(r.id, k)))).join(' | ')} | ${ISO_KINDS.map((k) => sym(results.get(key(r.id, k) + NOISO))).join(' | ')} |`)
md.push('', '## Observations', '')
for (const r of allRows) {
  md.push(`### ${r.id}: ${r.label}`, '')
  for (const k of KINDS) {
    const c = results.get(key(r.id, k.id))
    if (c) md.push(`- **${k.id}** — ${c.verdict}: \`${c.obs.replace(/`/g, "'")}\``)
  }
  for (const k of ISO_KINDS) {
    const c = results.get(key(r.id, k) + NOISO)
    if (c) md.push(`- **${k} (not isolating)** — ${c.verdict}: \`${c.obs.replace(/`/g, "'")}\``)
  }
  md.push('')
}
fs.writeFileSync(path.join(root, 'verify/matrix.md'), md.join('\n'))

// matrix-diff.md: round 1 (verify/matrix-v1.expected.json) vs this run, cell by cell
const v1Path = path.join(root, 'verify/matrix-v1.expected.json')
if (fs.existsSync(v1Path) && !ONLY) {
  const v1: Record<string, Cell> = JSON.parse(fs.readFileSync(v1Path, 'utf8'))
  const verdictOfCell = (c?: Cell) => (!c ? '—' : c.obs.startsWith('n/a') ? 'n/a' : c.verdict)
  const diff: string[] = []
  const cmpKinds = KINDS.filter((k) => k.id !== 'svgText')
  const counts = { same: 0, changed: 0, fixed: 0, protectedNow: 0, worse: 0, sameVerdict: 0, newCells: 0 }
  diff.push(`| interaction | ${cmpKinds.map((k) => k.id).join(' | ')} |`)
  diff.push(`|---|${cmpKinds.map(() => '---').join('|')}|`)
  const rank = { broken: 0, guarded: 1, ok: 2, 'n/a': 1, '—': 1 } as Record<string, number>
  for (const r of allRows) {
    const cells = cmpKinds.map((k) => {
      const a = v1[key(r.id, k.id)]
      const b = results.get(key(r.id, k.id))
      const va = verdictOfCell(a)
      const vb = verdictOfCell(b)
      if (!a) {
        counts.newCells++
        return `new: ${vb}`
      }
      if (va === vb && a.obs === b?.obs) {
        counts.same++
        return va
      }
      counts.changed++
      if (va === vb) counts.sameVerdict++
      else if (va === 'broken') counts.fixed++
      else if (va === 'ok' && vb === 'guarded') counts.protectedNow++
      else if (rank[vb] < rank[va]) counts.worse++
      return va === vb ? `${va} (differs)` : `**${va} → ${vb}**`
    })
    diff.push(`| ${r.label} | ${cells.join(' | ')} |`)
  }
  diff.unshift(`${counts.same} cells identical (verdict + observation), ${counts.changed} changed: ${counts.fixed} fixed (broken → guarded/ok), ${counts.protectedNow} now protected (ok → guarded: the interaction used to work like in a paragraph by destroying structure), ${counts.worse} worse, ${counts.sameVerdict} same verdict with a different observation; ${counts.newCells} new (round 2 rows). svgText (the experiment) is not compared.`, '')
  diff.push('', '## Changed cells, observation before → after', '')
  for (const r of allRows)
    for (const k of cmpKinds) {
      const a = v1[key(r.id, k.id)]
      const b = results.get(key(r.id, k.id))
      if (!a || !b || (a.verdict === b.verdict && a.obs === b.obs)) continue
      diff.push(`- **${r.id} / ${k.id}**: ${a.verdict} → ${b.verdict}`, `  - v1: \`${a.obs.replace(/`/g, "'")}\``, `  - v2: \`${b.obs.replace(/`/g, "'")}\``)
    }
  fs.writeFileSync(path.join(root, 'verify/matrix-diff.md'), diff.join('\n') + '\n')
}
console.log(failures === 0 ? 'MATRIX OK' : `MATRIX: ${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
