// The one rule that decides "editable Tiptap node" vs. "raw HTML island" — spike 10 adds a third outcome:
// "generic node" (tag + attributes kept, children editable), chosen per element by src/generic/policy.ts.
//
//   KNOWN_TAGS                 → real schema node/mark (prose, lists, tables, code, callout, details, containers…)
//   unknown tag, policy says   → generic node (free | locked) with a derived shape (block / textblock / inline)
//   otherwise / non-prose      → raw HTML island (spike 04)
//
// Used in two places with two adapters:
//   * source.ts (parse5, on the source string) → byte-exact islands (primary path)
//   * extensions.ts parse rules (live DOM) → fallback for HTML that never went through prepare
import { decide, policy, FLOW_TAGS, type GenericMode, type GenericShape } from '../generic/policy'

/** Tags the schema models (as node, mark or container). Anything else is generic / island. */
export const KNOWN_TAGS = new Set([
  // blocks
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'blockquote', 'hr',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col',
  // containers (editable, tag + attributes preserved)
  'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav', 'address', 'hgroup',
  'details', 'summary',
  // inline
  'br', 'img', 'a', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'strike', 'ins', 'mark', 'code',
  'sub', 'sup', 'span', 'small', 'abbr', 'kbd', 'cite', 'q', 'dfn', 'var', 'samp', 'time', 'bdi', 'bdo',
  'data', 'font', 'big', 'tt',
  // Tiptap's own task item markup (<label><input type=checkbox><span>) — see insideTaskLabel
  'label',
])

/** Tags that only hold phrasing content: an island inside them must be an inline island. */
export const PHRASING_PARENTS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary', 'a', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
  'strike', 'ins', 'mark', 'code', 'sub', 'sup', 'span', 'small', 'abbr', 'kbd', 'cite', 'q', 'dfn',
  'var', 'samp', 'time', 'bdi', 'bdo', 'data', 'font', 'big', 'tt', 'label',
])

/** Inline (phrasing) elements: text next to them is part of the same line. */
export const INLINE_ELEMENTS = new Set([
  'a', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'strike', 'ins', 'mark', 'code', 'sub', 'sup', 'span',
  'small', 'abbr', 'kbd', 'cite', 'q', 'dfn', 'var', 'samp', 'time', 'bdi', 'bdo', 'data', 'font', 'big',
  'tt', 'br', 'img', 'label', 'input', 'button', 'select', 'svg',
])

/** Parents in which a block island / comment placeholder can be placed by ProseMirror. */
const BLOCK_PARENTS = new Set([
  '#root', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav', 'address', 'hgroup',
  'details', 'blockquote', 'li', 'td', 'th',
])

/** Minimal view of an element, so the rule runs on parse5 trees and on live DOM alike. */
export interface ElLike {
  tag: string // lower-case local name
  parentTag: string // '#root' for top level
  hasChild(tag: string): boolean
  /** a non-whitespace text node is a sibling */
  hasTextSibling: boolean
  /** element sits inside Tiptap's task item <label> (its checkbox UI) */
  insideTaskLabel: boolean
  // spike 10
  attr(name: string): string | null
  /** has a child element that is flow (block-level) content → the generic node needs block+ content */
  hasFlowChild: boolean
  /** inside an <svg> (the svg-as-nodes experiment owns everything in there) */
  inSvg: boolean
  /** the parent is a generic node → children inherit its mode (unless an attribute / rule says otherwise) */
  parentGeneric: GenericDecision | null
}

export type IslandKind = false | 'block' | 'inline'

export interface GenericDecision {
  kind: 'generic'
  shape: GenericShape
  mode: Exclude<GenericMode, 'island'>
  marks: string[]
}
export type Outcome = { kind: 'node' } | { kind: 'island'; inline: boolean } | GenericDecision

/** the flow/phrasing distinction of the HTML content model, for tags the schema doesn't know */
export function isFlowTag(tag: string): boolean {
  if (FLOW_TAGS.has(tag)) return true
  if (INLINE_ELEMENTS.has(tag)) return false
  // custom elements default to display:inline in browsers; treat them as flow when they hold flow (decided by hasFlowChild)
  return false
}

/**
 * Does this child list hold flow content? (decides block+ vs inline* for a generic node)
 *   a flow-tag child, or a block island placeholder                         → yes
 *   only elements, none of them known-inline, and no text at all             → yes (a wrapper of boxes)
 *   text (possibly with inline elements / unknown inline-ish elements)       → no  (a text block)
 */
export function flowChildren(kids: ({ text: boolean } | { tag: string; blockPlaceholder: boolean } | null)[]): boolean {
  const els = kids.filter((k): k is { tag: string; blockPlaceholder: boolean } => !!k && 'tag' in k)
  if (els.some((k) => isFlowTag(k.tag) || k.blockPlaceholder)) return true
  const hasText = kids.some((k) => !!k && 'text' in k && k.text)
  return !hasText && els.length > 0 && els.some((k) => !INLINE_ELEMENTS.has(k.tag))
}

/** known wrapper tags that an attribute or a rule may still turn into a generic node (e.g. a locked `div.diagram-box`) */
export const OVERRIDABLE_TAGS = new Set(['div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav', 'address', 'hgroup'])

/** spike 10: the full decision (node / generic / island) */
export function classifyAll(el: ElLike): Outcome {
  if (el.insideTaskLabel) return { kind: 'node' }
  if ((el.inSvg || el.tag === 'svg') && policy.svg === 'nodes') return { kind: 'node' } // the svg-as-nodes experiment
  const known = KNOWN_TAGS.has(el.tag) && !(el.tag === 'table' && el.hasChild('caption'))
  const inline = isInlineContext(el.parentTag, el.hasTextSibling) || el.parentGeneric?.shape === 'inline' || (el.parentGeneric?.shape === 'textblock' && INLINE_ELEMENTS.has(el.tag))
  // round 2 Enter variant (a): text-bearing elements get block+ content like a table cell (text gets <p>-wrapped)
  const shapeOf = (): GenericShape => (inline ? 'inline' : el.hasFlowChild || policy.textblocks === 'block' ? 'block' : 'textblock')
  if (known) {
    if (!OVERRIDABLE_TAGS.has(el.tag)) return { kind: 'node' }
    const d = decide(el, el.parentGeneric?.mode)
    if (d.mode === 'island') return { kind: 'node' }
    // a known wrapper (div, section, …) holding flow content stays spike 04's Container (block+) unless an
    // attribute / rule / generic parent asks for a generic node. Round 2: a wrapper that holds only text /
    // phrasing content (`<div class="node">Device editor</div>`) becomes a generic TEXTBLOCK instead, so its text
    // is not wrapped in a <p> on load (the free diagram box round-trips byte-for-byte modulo whitespace).
    if (d.by === 'default' && (el.hasFlowChild || inline || policy.textblocks === 'block')) return { kind: 'node' }
    return { kind: 'generic', shape: shapeOf(), mode: d.mode, marks: d.marks }
  }
  if (el.tag === 'table') return { kind: 'island', inline }
  const d = decide(el, el.parentGeneric?.mode)
  if (d.mode === 'island') return { kind: 'island', inline }
  return { kind: 'generic', shape: shapeOf(), mode: d.mode, marks: d.marks }
}

/** spike 04 API: island or not (generic nodes are "not an island") */
export function classify(el: ElLike): IslandKind {
  const o = classifyAll(el)
  return o.kind === 'island' ? (o.inline ? 'inline' : 'block') : false
}

/** Containers whose content is block+: loose text there becomes its own paragraph, so an island
 *  next to it can stay a block island. */
export const CONTAINERISH = new Set([
  '#root', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav', 'address', 'hgroup',
  'details', 'blockquote',
])

export function isInlineContext(parentTag: string, hasTextSibling: boolean): boolean {
  return PHRASING_PARENTS.has(parentTag) || (hasTextSibling && !CONTAINERISH.has(parentTag))
}

/** Can a comment / island placeholder be placed under this parent at all? (not inside ul, tr, pre…) */
export function placeableUnder(parentTag: string, parentGeneric: GenericDecision | null = null): boolean {
  if (parentGeneric) return true
  return BLOCK_PARENTS.has(parentTag) || PHRASING_PARENTS.has(parentTag)
}

// ---------------------------------------------------------------- DOM adapter (parse rules)
const SVG_NS = 'http://www.w3.org/2000/svg'

export function domEl(el: Element): ElLike {
  const parent = el.parentElement
  const parentTag = !parent || parent.localName === 'body' ? '#root' : parent.localName
  const siblings = parent ? Array.from(parent.childNodes) : []
  // the parent's own outcome (for mode inheritance) — not for the parse root (body, or a detached wrapper element)
  const parentOutcome = parent && parent.localName !== 'body' && parent.parentElement ? classifyAll(domEl(parent)) : null
  return {
    tag: el.localName,
    parentTag,
    hasChild: (t) => Array.from(el.children).some((c) => c.localName === t),
    hasTextSibling: siblings.some((n) => n.nodeType === 3 && /\S/.test(n.textContent ?? '')),
    insideTaskLabel: !!el.closest('li[data-type="taskItem"] > label'),
    attr: (n) => el.getAttribute(n),
    hasFlowChild: flowChildren(
      Array.from(el.childNodes).map((n) => (n.nodeType === 3 ? { text: /\S/.test(n.textContent ?? '') } : n.nodeType === 1 ? { tag: (n as Element).localName, blockPlaceholder: (n as Element).localName === 'div' && (n as Element).hasAttribute('data-raw-island') } : null)),
    ),
    inSvg: el.namespaceURI === SVG_NS || !!el.closest('svg'),
    parentGeneric: parentOutcome?.kind === 'generic' ? parentOutcome : null,
  }
}
