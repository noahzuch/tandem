// Spike 10 round 2: the explicit delete UI for generic nodes, containers and islands.
//
// Round 1 drew a box around every descendant plus a red badge; the user found it ugly. Round 2:
//   hover an element      → the <tag> chip (CSS) and a small ghost trash button at the element's top-right
//   hover / focus the trash → the PREVIEW: one soft tinted overlay over the element's union area (its own box
//                            ∪ every drawable descendant box, clipped), a 1px outline on the outer boundary,
//                            the rest of the page washed out a little, the content faded; the button grows into
//                            the summary "Delete <x-card> · 3 elements · 42 words" (plus "· 1 hidden",
//                            "· 1 off-screen" when the visuals cannot show everything — the text is the source of
//                            truth, the overlay is a hint)
//   click the trash       → delete (one transaction with `structure-unlock`, undoable)
//   keyboard              → Escape selects the enclosing element, Backspace/Delete on that selection ARMS the
//                            widget: the same preview + a confirm bar ("Delete · Cancel") with focus on Delete,
//                            Enter/Delete confirms, Esc cancels. Nothing is removed without this step.
//   block menu            → BlockHandle.vue shows the same summary on its "Delete …" item and previews on hover
//                            (the inline-confirm alternative; same preview code).
//
// `collectBoxes()` is round 1's measured per-descendant analysis and is kept as the measurement API
// (verify/widget.ts); `previewOf()` derives the union rect + summary from it.
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { isUnit, tagOf } from './protect'
import { UNLOCK_META } from './guards'

export interface Box {
  tag: string
  /** viewport rect the widget could draw (after clipping), or null when nothing can be drawn */
  rect: { x: number; y: number; w: number; h: number } | null
  /** what happened to it */
  notes: string[]
  text: string
}

const SKIP = (el: Element) => el.hasAttribute('data-island-ui') || el.classList.contains('island-bar') || el.classList.contains('ProseMirror-trailingBreak') || el.localName === 'style'

/** all descendant elements, piercing one level of shadow root (islands render in a shadow root) */
function descendants(root: Element): Element[] {
  const out: Element[] = []
  const walk = (n: Element) => {
    for (const c of Array.from(n.children)) {
      if (SKIP(c)) continue
      out.push(c)
      walk(c)
    }
    if (n.shadowRoot) {
      const r = n.shadowRoot.querySelector('.root')
      if (r) walk(r)
    }
  }
  walk(root)
  return out
}

function intersect(a: DOMRect, b: DOMRect): DOMRect {
  const x = Math.max(a.left, b.left)
  const y = Math.max(a.top, b.top)
  const r = Math.min(a.right, b.right)
  const btm = Math.min(a.bottom, b.bottom)
  return new DOMRect(x, y, Math.max(0, r - x), Math.max(0, btm - y))
}

export function collectBoxes(root: Element): Box[] {
  const rootRect = root.getBoundingClientRect()
  const boxes: Box[] = []
  for (const el of descendants(root)) {
    const notes: string[] = []
    const cs = getComputedStyle(el)
    const text = (el.textContent ?? '').trim().slice(0, 40)
    let rect: DOMRect | null = el.getBoundingClientRect()
    if (cs.display === 'contents') {
      notes.push('display:contents → no box (children are boxed)')
      rect = null
    } else if (rect.width === 0 && rect.height === 0) {
      notes.push('zero size → no box')
      rect = null
    } else {
      if (cs.visibility === 'hidden' || cs.opacity === '0') notes.push('invisible (visibility/opacity) but boxed')
      if (cs.transform !== 'none') notes.push('transformed → axis-aligned bounding box')
      if (rect.right < 0 || rect.bottom < 0 || rect.left > innerWidth || rect.top > innerHeight) notes.push('off-screen (position far away)')
      // clip to overflow-hidden ancestors between el and root
      let p: Element | null = el.parentElement
      const host = (el.getRootNode() as ShadowRoot).host as Element | undefined
      while (p && p !== root) {
        const pcs = getComputedStyle(p)
        if (/hidden|clip|scroll|auto/.test(pcs.overflow) || /hidden|clip/.test(pcs.overflowY)) {
          const clipped = intersect(rect, p.getBoundingClientRect())
          if (clipped.width !== rect.width || clipped.height !== rect.height) notes.push(clipped.width === 0 || clipped.height === 0 ? 'fully clipped by overflow → no box' : 'clipped by overflow:hidden ancestor')
          rect = clipped
        }
        p = p.parentElement ?? (p.parentNode === p.getRootNode() && host ? host : null)
      }
      if (rect.width === 0 || rect.height === 0) {
        notes.push('zero width/height geometry (SVG stroke not counted) → no box')
        rect = null
      } else if (rect.left < rootRect.left - 1 || rect.top < rootRect.top - 1 || rect.right > rootRect.right + 1 || rect.bottom > rootRect.bottom + 1) notes.push('outside the node box (absolute/transform)')
      if (el.getRootNode() !== document) notes.push('in shadow root (island)')
    }
    boxes.push({ tag: el.localName, rect: rect ? { x: rect.left, y: rect.top, w: rect.width, h: rect.height } : null, notes, text })
  }
  return boxes
}

const wordsOf = (el: Element) => (el.textContent ?? '').split(/\s+/).filter(Boolean).length

export interface Preview {
  /** union of the element's own box and every drawable, visible, on-screen descendant box (viewport coords) */
  rect: { x: number; y: number; w: number; h: number } | null
  elements: number
  words: number
  /** descendants the overlay cannot show, by reason */
  hidden: number
  offscreen: number
  noBox: number
  /** descendants that reach outside the element's own box (absolute / transform) — the union grew to include them */
  outside: number
  summary: string
}

/** what the delete of `el` would remove, as one rect + one sentence */
export function previewOf(el: Element, tag = el.localName): Preview {
  const boxes = collectBoxes(el)
  const own = el.getBoundingClientRect()
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  const add = (r: { x: number; y: number; w: number; h: number }) => {
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.w)
    y2 = Math.max(y2, r.y + r.h)
  }
  if (own.width > 0 || own.height > 0) add({ x: own.left, y: own.top, w: own.width, h: own.height })
  let hidden = 0
  let offscreen = 0
  let noBox = 0
  let outside = 0
  for (const b of boxes) {
    const invisible = b.notes.some((n) => n.startsWith('invisible'))
    const off = b.notes.some((n) => n.startsWith('off-screen'))
    if (invisible) hidden++
    if (off) offscreen++
    if (!b.rect) noBox++
    if (!b.rect || invisible || off) continue
    if (b.notes.some((n) => n.startsWith('outside'))) outside++
    add(b.rect)
  }
  const rect = x1 < Infinity ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null
  const words = wordsOf(el)
  const parts: string[] = []
  if (boxes.length) parts.push(`${boxes.length} element${boxes.length === 1 ? '' : 's'} inside`)
  parts.push(`${words} word${words === 1 ? '' : 's'}`)
  if (hidden) parts.push(`${hidden} hidden`)
  if (offscreen) parts.push(`${offscreen} off-screen`)
  return { rect, elements: boxes.length, words, hidden, offscreen, noBox, outside, summary: `Delete <${tag}> · ${parts.join(' · ')}` }
}

// lucide "trash-2" (ISC), the icon the editor's menus use for Delete
const TRASH = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>'

interface Target {
  dom: Element
  pos: number
  tag: string
}

export class DeleteWidget {
  private btn: HTMLButtonElement
  private label: HTMLSpanElement
  private bar: HTMLDivElement
  private confirmBtn: HTMLButtonElement
  private layer: HTMLDivElement
  private target: Target | null = null
  private armed = false
  private leaveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private editor: Editor) {
    this.btn = document.createElement('button')
    this.btn.type = 'button'
    this.btn.className = 'dw-btn'
    this.btn.dataset.testid = 'delete-widget'
    this.btn.hidden = true
    this.btn.innerHTML = TRASH
    this.label = document.createElement('span')
    this.label.className = 'dw-label'
    this.label.dataset.testid = 'delete-summary'
    this.btn.append(this.label)
    this.btn.addEventListener('mousedown', (e) => e.preventDefault())
    this.btn.addEventListener('mouseenter', () => {
      if (this.leaveTimer) clearTimeout(this.leaveTimer)
      this.preview()
    })
    this.btn.addEventListener('focus', () => this.preview())
    this.btn.addEventListener('mouseleave', () => {
      if (this.armed) return
      this.clearPreview()
      this.onLeave()
    })
    this.btn.addEventListener('blur', () => !this.armed && this.clearPreview())
    this.btn.addEventListener('click', () => this.deleteTarget())

    this.bar = document.createElement('div')
    this.bar.className = 'dw-bar'
    this.bar.dataset.testid = 'delete-bar'
    this.bar.hidden = true
    const text = document.createElement('span')
    text.className = 'dw-bar-text'
    this.confirmBtn = document.createElement('button')
    this.confirmBtn.type = 'button'
    this.confirmBtn.className = 'dw-confirm'
    this.confirmBtn.dataset.testid = 'delete-confirm'
    this.confirmBtn.innerHTML = `${TRASH}<span>Delete</span>`
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'dw-cancel'
    cancel.dataset.testid = 'delete-cancel'
    cancel.textContent = 'Cancel'
    const hint = document.createElement('span')
    hint.className = 'dw-hint'
    hint.textContent = 'Enter to delete · Esc to keep'
    this.bar.append(text, this.confirmBtn, cancel, hint)
    this.confirmBtn.addEventListener('click', () => this.deleteTarget())
    cancel.addEventListener('click', () => this.disarm())
    this.bar.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        this.disarm()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        this.deleteTarget()
      }
    })
    for (const b of [this.confirmBtn, cancel]) b.addEventListener('mousedown', (e) => e.preventDefault())

    this.layer = document.createElement('div')
    this.layer.className = 'dw-layer'
    this.layer.dataset.testid = 'delete-preview'
    document.body.append(this.btn, this.bar, this.layer)
    editor.view.dom.addEventListener('mousemove', this.onMove)
    editor.view.dom.addEventListener('mouseleave', this.onLeave)
    ;(window as unknown as { __deleteWidget: DeleteWidget }).__deleteWidget = this
  }

  // ------------------------------------------------------------ targeting
  /** the INNERMOST generic node / container / island whose DOM contains `el` */
  private resolve(el: Element | null): Target | null {
    const unit = el?.closest('[data-generic], .island')
    if (!unit || !this.editor.view.dom.contains(unit)) return null
    const pos = this.editor.view.posAtDOM(unit, 0)
    const $pos = this.editor.state.doc.resolve(pos)
    // posAtDOM gives the position *inside*; the node itself starts one before (for a NodeView wrapper: before)
    let nodePos = $pos.depth > 0 ? $pos.before($pos.depth) : pos
    let node = this.editor.state.doc.nodeAt(nodePos)
    if (!node || !isUnit(node)) {
      node = this.editor.state.doc.nodeAt(pos)
      nodePos = pos
    }
    if (!node || !isUnit(node)) return null
    return { dom: unit, pos: nodePos, tag: (unit as HTMLElement).dataset.tag ?? unit.getAttribute('data-island-kind') ?? tagOf(node) }
  }

  private onMove = (e: MouseEvent) => {
    if (this.armed) return
    const t = this.resolve(e.target as Element)
    if (!t) return this.onLeave()
    if (this.target?.dom !== t.dom) {
      this.target = t
      this.showButton()
    }
  }
  private onLeave = () => {
    if (this.armed) return
    // the button sits outside the editor DOM: give the pointer a moment to reach it before hiding
    if (this.leaveTimer) clearTimeout(this.leaveTimer)
    this.leaveTimer = setTimeout(() => {
      if (this.btn.matches(':hover') || this.armed) return
      this.btn.hidden = true
      this.target = null
      this.clearPreview()
    }, 150)
  }

  private showButton() {
    if (!this.target) return
    const r = this.target.dom.getBoundingClientRect()
    this.btn.hidden = false
    this.btn.classList.remove('labelled')
    this.btn.title = `Delete <${this.target.tag}>`
    this.btn.setAttribute('aria-label', this.btn.title)
    this.label.textContent = ''
    this.btn.style.left = `${Math.max(8, r.right - 26)}px`
    this.btn.style.top = `${r.top - 12 + scrollY}px`
  }

  // ------------------------------------------------------------ preview
  /** measured per-descendant boxes (round 1's API, used by verify/widget.ts) */
  inspect(el: Element): Box[] {
    return collectBoxes(el)
  }
  /** the union rect + summary the UI shows (used by BlockHandle.vue and the tests) */
  previewFor(el: Element, tag?: string): Preview {
    return previewOf(el, tag)
  }

  preview(): Preview | null {
    if (!this.target) return null
    const p = previewOf(this.target.dom, this.target.tag)
    this.drawPreview(this.target.dom, p)
    this.btn.classList.add('labelled')
    this.label.textContent = p.summary
    const r = this.target.dom.getBoundingClientRect()
    this.btn.style.left = `${Math.max(8, r.right - this.btn.offsetWidth - 2)}px`
    return p
  }
  /** preview for an arbitrary node position (the block menu) */
  previewAt(pos: number): Preview | null {
    const node = this.editor.state.doc.nodeAt(pos)
    const dom = this.editor.view.nodeDOM(pos) as Element | null
    if (!node || !dom || !(dom instanceof Element)) return null
    const p = previewOf(dom, tagOf(node))
    this.drawPreview(dom, p)
    return p
  }
  // NB: the preview never touches the editor's DOM (no class on the element): ProseMirror's DOM observer treats an
  // attribute mutation on a node as a change, re-reads the selection and turns a NodeSelection into a text
  // selection (measured: the keyboard path broke on the second Backspace). The fade comes from the overlay.
  private drawPreview(dom: Element, p: Preview) {
    this.layer.innerHTML = ''
    if (p.rect) {
      const o = document.createElement('div')
      o.className = 'dw-overlay'
      o.dataset.testid = 'delete-overlay'
      o.style.left = `${p.rect.x + scrollX}px`
      o.style.top = `${p.rect.y + scrollY}px`
      o.style.width = `${p.rect.w}px`
      o.style.height = `${p.rect.h}px`
      this.layer.append(o)
    }
    const own = dom.getBoundingClientRect()
    if (own.width > 0 && p.rect && (own.width < p.rect.w - 1 || own.height < p.rect.h - 1)) {
      // the union grew beyond the element's own box (absolute / transformed children): show both boundaries
      const b = document.createElement('div')
      b.className = 'dw-bounds'
      b.style.left = `${own.left + scrollX}px`
      b.style.top = `${own.top + scrollY}px`
      b.style.width = `${own.width}px`
      b.style.height = `${own.height}px`
      this.layer.append(b)
    }
  }
  clearPreview() {
    this.layer.innerHTML = ''
    this.btn.classList.remove('labelled')
    this.label.textContent = ''
  }

  // ------------------------------------------------------------ keyboard path
  /** select element → Backspace/Delete: show the preview and a confirm bar; nothing is deleted yet */
  arm(pos: number): boolean {
    const node = this.editor.state.doc.nodeAt(pos)
    const dom = this.editor.view.nodeDOM(pos) as Element | null
    if (!node || !dom || !(dom instanceof Element) || !isUnit(node)) return false
    this.target = { dom, pos, tag: (dom as HTMLElement).dataset.tag ?? dom.getAttribute('data-island-kind') ?? tagOf(node) }
    this.armed = true
    this.btn.hidden = true
    const p = this.preview()!
    this.btn.hidden = true
    const r = dom.getBoundingClientRect()
    this.bar.hidden = false
    ;(this.bar.firstChild as HTMLElement).textContent = p.summary.replace(/^Delete /, '')
    this.bar.style.left = `${Math.max(8, Math.min(r.left + scrollX, innerWidth - this.bar.offsetWidth - 8))}px`
    this.bar.style.top = `${r.bottom + scrollY + 6}px`
    this.confirmBtn.focus()
    return true
  }
  disarm() {
    this.armed = false
    this.bar.hidden = true
    this.clearPreview()
    this.target = null
    this.editor.view.focus()
  }
  get isArmed() {
    return this.armed
  }

  // ------------------------------------------------------------ the act
  deleteTarget() {
    if (!this.target) return
    const { pos } = this.target
    const node = this.editor.state.doc.nodeAt(pos)
    if (!node) return
    const tr = this.editor.state.tr.setSelection(NodeSelection.create(this.editor.state.doc, pos)).deleteSelection().setMeta(UNLOCK_META, true)
    this.editor.view.dispatch(tr.scrollIntoView())
    this.armed = false
    this.bar.hidden = true
    this.btn.hidden = true
    this.target = null
    this.clearPreview()
    this.editor.view.focus()
  }
  destroy() {
    this.editor.view.dom.removeEventListener('mousemove', this.onMove)
    this.editor.view.dom.removeEventListener('mouseleave', this.onLeave)
    this.btn.remove()
    this.bar.remove()
    this.layer.remove()
  }
}
