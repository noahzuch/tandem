// Source-level (string) operations with parse5 + source locations. Runs in the browser and in Node.
//   prepareForEditor(body): replace every island element / comment by a placeholder that carries the
//                           exact source slice (byte-exact islands)
//   replaceLeafText(html, path, text): change the text of ONE leaf element inside an island's source,
//                           leaving every other byte untouched
import { parseFragment, type DefaultTreeAdapterTypes as T } from 'parse5'
import { classify, isInlineContext, placeableUnder, CONTAINERISH, INLINE_ELEMENTS, type ElLike } from './classify'
import { placeholder, escapeText } from './raw'

type Node = T.ChildNode
type Parent = T.ParentNode

const isElement = (n: Node): n is T.Element => 'tagName' in n
const isText = (n: Node): n is T.TextNode => n.nodeName === '#text'
const childrenOf = (n: Parent): Node[] => (n.nodeName === 'template' ? (n as T.Template).content.childNodes : n.childNodes)

function parentTagOf(n: Parent): string {
  return 'tagName' in n ? (n as T.Element).tagName.toLowerCase() : '#root'
}

function parse5El(el: T.Element, parent: Parent, insideTaskLabel: boolean): ElLike {
  const siblings = childrenOf(parent)
  return {
    tag: el.tagName.toLowerCase(),
    parentTag: parentTagOf(parent),
    hasChild: (t) => el.childNodes.some((c) => isElement(c) && c.tagName.toLowerCase() === t),
    hasTextSibling: siblings.some((s) => isText(s) && /\S/.test(s.value)),
    insideTaskLabel,
  }
}

export interface PrepareStats {
  blockIslands: number
  inlineIslands: number
  comments: number
  tags: string[]
}

/** Replace island elements + comments by placeholders carrying their exact source. */
export function prepareForEditor(body: string): { html: string; stats: PrepareStats } {
  const frag = parseFragment(body, { sourceCodeLocationInfo: true })
  const edits: { start: number; end: number; text: string }[] = []
  const stats: PrepareStats = { blockIslands: 0, inlineIslands: 0, comments: 0, tags: [] }

  const walk = (parent: Parent, inTaskItem: boolean, inTaskLabel: boolean) => {
    const parentTag = parentTagOf(parent)
    const siblings = childrenOf(parent)
    for (const [idx, n] of siblings.entries()) {
      const loc = n.sourceCodeLocation
      // Loose text directly in body/div/section: ProseMirror keeps its leading space on the 1st load
      // and drops it on the 2nd (spike 02: 2-pass stability). Trim it next to block boundaries.
      if (isText(n) && loc && CONTAINERISH.has(parentTag) && /\S/.test(n.value)) {
        const src = body.slice(loc.startOffset, loc.endOffset)
        const prev = siblings.slice(0, idx).filter((s) => !(isText(s) && !/\S/.test(s.value))).at(-1)
        const next = siblings.slice(idx + 1).find((s) => !(isText(s) && !/\S/.test(s.value)))
        const blockish = (s: Node | undefined) => !s || (isElement(s) && !INLINE_ELEMENTS.has(s.tagName.toLowerCase()))
        let t = src
        if (blockish(prev)) t = t.replace(/^\s+/, '')
        if (blockish(next)) t = t.replace(/\s+$/, '')
        if (t !== src) edits.push({ start: loc.startOffset, end: loc.endOffset, text: t })
        continue
      }
      if (n.nodeName === '#comment') {
        if (!loc || !placeableUnder(parentTag)) continue
        const inline = isInlineContext(parentTag, siblings.some((s) => isText(s) && /\S/.test(s.value)))
        edits.push({ start: loc.startOffset, end: loc.endOffset, text: placeholder(body.slice(loc.startOffset, loc.endOffset), inline) })
        stats.comments++
        continue
      }
      if (!isElement(n)) continue
      const tag = n.tagName.toLowerCase()
      const kind = classify(parse5El(n, parent, inTaskLabel))
      if (kind && loc && placeableUnder(parentTag)) {
        edits.push({ start: loc.startOffset, end: loc.endOffset, text: placeholder(body.slice(loc.startOffset, loc.endOffset), kind === 'inline') })
        kind === 'inline' ? stats.inlineIslands++ : stats.blockIslands++
        stats.tags.push(tag)
        continue
      }
      if (tag === 'pre') continue // code: leave comments/markup inside alone
      const isTaskItem = tag === 'li' && n.attrs.some((a) => a.name === 'data-type' && a.value === 'taskItem')
      walk(n, isTaskItem, inTaskLabel || (inTaskItem && tag === 'label'))
    }
  }
  walk(frag, false, false)

  let html = body
  for (const e of edits.sort((a, b) => b.start - a.start)) html = html.slice(0, e.start) + e.text + html.slice(e.end)
  return { html, stats }
}

// ---------------------------------------------------------------- leaf text editing
/** SVG elements whose text is visible and editable */
const SVG_TEXT = new Set(['text', 'tspan', 'textpath'])
const NOT_EDITABLE = new Set(['script', 'style', 'textarea', 'title', 'desc', 'option', 'noscript', 'template'])

/** text-bearing tags that stay editable when the user emptied them (else an emptied label is lost) */
const TEXTY = new Set([
  'p', 'span', 'figcaption', 'caption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'dt', 'dd',
  'label', 'a', 'strong', 'em', 'b', 'i', 'u', 'small', 'summary', 'button', 'code',
])

/** "leaf" = element whose children are only text (≥1 non-blank). Same test on parse5 and DOM trees. */
export function isLeafTag(tag: string, isSvg: boolean): boolean {
  const t = tag.toLowerCase()
  if (NOT_EDITABLE.has(t)) return false
  return isSvg ? SVG_TEXT.has(t) : true
}

/** may an element WITHOUT any text still be offered for editing? */
export function isEmptyEditable(tag: string, isSvg: boolean): boolean {
  const t = tag.toLowerCase()
  return isSvg ? SVG_TEXT.has(t) : TEXTY.has(t) || t.includes('-')
}

/** path = indices among element children, from the fragment root down */
function elementAt(frag: Parent, path: number[]): T.Element | undefined {
  let cur: Parent = frag
  for (const i of path) {
    const els = childrenOf(cur).filter(isElement)
    const next = els[i]
    if (!next) return undefined
    cur = next
  }
  return cur as T.Element
}

/** Replace the text of the leaf element at `path` in `html`; every other byte stays as it was. */
export function replaceLeafText(html: string, path: number[], text: string): string {
  const frag = parseFragment(html, { sourceCodeLocationInfo: true })
  const el = elementAt(frag, path)
  if (!el) throw new Error(`no element at path ${path.join('/')}`)
  if (!el.childNodes.every(isText)) throw new Error(`element at ${path.join('/')} is not a text leaf`)
  const loc = el.sourceCodeLocation
  if (!loc?.startTag) throw new Error('no source location')
  const start = loc.startTag.endOffset
  const end = loc.endTag ? loc.endTag.startOffset : el.childNodes.length ? el.childNodes.at(-1)!.sourceCodeLocation!.endOffset : start
  return html.slice(0, start) + escapeText(text) + html.slice(end)
}
