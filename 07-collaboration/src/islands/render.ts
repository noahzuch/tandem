// Display of a raw HTML island inside the editor (browser only).
//
// * Shadow DOM: the island's markup and the document's own <style> live in a shadow root, so
//   (1) the doc CSS styles the island exactly like in the file without leaking onto the editor UI,
//   (2) editor CSS (.tiptap p {…}) doesn't restyle the island, and
//   (3) ProseMirror's MutationObserver never sees edits inside it (shadow trees are not observed).
// * Sanitising is for DISPLAY only — the stored source is never touched by it. It must not add or
//   remove elements (leaf paths must match the parse5 tree of the source), so it only rewrites attributes.
import { isLeafTag, isEmptyEditable } from './source'

export const SVG_NS = 'http://www.w3.org/2000/svg'
const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'srcdoc', 'data', 'poster']

export type IslandShape =
  | { kind: 'comment'; label: string }
  | { kind: 'inert'; label: string } // script / style / noscript / template: shown as a chip
  | { kind: 'html'; label: string }

export function shapeOf(html: string): IslandShape {
  const t = html.trimStart()
  if (t.startsWith('<!--')) return { kind: 'comment', label: 'comment' }
  const tag = /^<([a-zA-Z][\w:-]*)/.exec(t)?.[1]?.toLowerCase() ?? 'html'
  if (['script', 'style', 'noscript', 'template'].includes(tag)) return { kind: 'inert', label: tag }
  return { kind: 'html', label: tag }
}

/** neutralise active content without changing the element structure */
export function sanitizeForDisplay(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase()
      if (n.startsWith('on')) el.removeAttribute(a.name)
      else if (URL_ATTRS.includes(n) && /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value)) el.removeAttribute(a.name)
    }
    const tag = el.localName
    if (tag === 'iframe') el.setAttribute('sandbox', '') // no scripts, no same-origin, no navigation
    if (tag === 'video' || tag === 'audio') el.removeAttribute('autoplay')
    if (['input', 'button', 'select', 'textarea'].includes(tag)) el.setAttribute('disabled', '')
  }
  // <script> inserted via innerHTML never executes; <meta>/<base>/<link> could still act → hide by type
  for (const el of Array.from(root.querySelectorAll('meta, base, link'))) {
    el.setAttribute('data-neutralised', el.localName)
    for (const a of Array.from(el.attributes)) if (a.name !== 'data-neutralised') el.removeAttribute(a.name)
  }
}

const BASE_CSS = `
:host { display: block; }
:host([data-inline]) { display: inline-block; vertical-align: middle; }
.root { position: relative; }
[data-leaf-path] { border-radius: 3px; outline: 1px dashed transparent; outline-offset: 1px; cursor: text; }
.root:hover [data-leaf-path]:not(text):not(tspan) { outline-color: #9db6e0; }
.root:hover text[data-leaf-path], .root:hover tspan[data-leaf-path] { text-decoration: underline dotted #4a78c2; }
/* an emptied text element would collapse to 0×0 and could never be clicked again */
[data-leaf-path]:empty:not(text):not(tspan) { display: inline-block; min-width: 3em; min-height: 1.2em; outline-color: #c9c9c4; }
[data-leaf-path]:focus { outline: 2px solid #4a78c2; background: #eef3fb; }
.svg-overlay { position: absolute; z-index: 5; padding: 0 3px; white-space: pre; background: #fff;
  outline: 2px solid #4a78c2; border-radius: 3px; line-height: 1.2; color: #1d1d1d; }
.chip { display: inline-block; font: 12px/1.6 ui-monospace, monospace; color: #666; background: #f3f3f1;
  border: 1px dashed #c9c9c4; border-radius: 4px; padding: 0 6px; max-width: 100%; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
`

/** element-children index path from the fragment root ("0/2/1") */
function pathOf(el: Element, root: Element): string {
  const parts: number[] = []
  let cur: Element | null = el
  while (cur && cur !== root) {
    const parent: Element | null = cur.parentElement
    if (!parent) break
    parts.unshift(Array.from(parent.children).indexOf(cur))
    cur = parent
  }
  return parts.join('/')
}

function isLeaf(el: Element): boolean {
  const kids = Array.from(el.childNodes)
  const svg = el.namespaceURI === SVG_NS
  if (!kids.every((n) => n.nodeType === 3)) return false
  if (!/\S/.test(el.textContent ?? '')) return isEmptyEditable(el.localName, svg) // emptied by the user
  return isLeafTag(el.localName, svg)
}

/** Render `html` into the shadow root; returns the .root element. Marks editable text leaves. */
export function renderIsland(shadow: ShadowRoot, html: string, docCss: string, editable: boolean): HTMLElement {
  shadow.innerHTML = ''
  const style = document.createElement('style')
  // doc CSS: `:root` (custom properties) → :host so variables reach the island
  style.textContent = docCss.replace(/:root\b/g, ':host') + BASE_CSS
  const root = document.createElement('div')
  root.className = 'root'
  shadow.append(style, root)
  const shape = shapeOf(html)
  if (shape.kind !== 'html') {
    const chip = document.createElement('span')
    chip.className = 'chip'
    const text = shape.kind === 'comment' ? html.trim() : `<${shape.label}> · ${html.length} chars · not executed in the editor`
    chip.textContent = text.length > 120 ? text.slice(0, 117) + '…' : text
    chip.title = html
    root.append(chip)
    return root
  }
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  sanitizeForDisplay(tpl.content)
  root.append(tpl.content)
  if (editable) {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (!isLeaf(el)) continue
      el.setAttribute('data-leaf-path', pathOf(el, root))
      if (el.namespaceURI !== SVG_NS) {
        // native editing for HTML text; plaintext-only = no <b>/<div> insertion, paste as text
        el.setAttribute('contenteditable', 'plaintext-only')
        el.setAttribute('spellcheck', 'false')
      }
    }
  }
  return root
}
