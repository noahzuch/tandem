// The one rule that decides "editable Tiptap node" vs. "raw HTML island".
//
// Rule: an element becomes a **raw HTML island** iff its tag is NOT in KNOWN_TAGS, i.e. the schema has
// no node/mark that can hold it without loss (svg, figure, iframe, video, form, dl, script, custom
// elements, …), or it is a known tag in a shape the schema can't hold (a <table> with <caption>).
// Everything in KNOWN_TAGS is parsed into real nodes/marks (prose, lists, tables, code, callout,
// details, generic containers like section/header/div) and stays fully editable.
//
// Used in two places with two adapters:
//   * prepare.ts (parse5, on the source string) → byte-exact islands (primary path)
//   * extensions.ts parse rules (live DOM) → fallback for HTML that never went through prepare
//     (paste, setContent from code); there the island keeps DOM-normalised outerHTML.

/** Tags the schema models (as node, mark or container). Anything else is an island. */
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
}

export type IslandKind = false | 'block' | 'inline'

export function classify(el: ElLike): IslandKind {
  if (el.insideTaskLabel) return false
  const island = !KNOWN_TAGS.has(el.tag) || (el.tag === 'table' && el.hasChild('caption'))
  if (!island) return false
  return isInlineContext(el.parentTag, el.hasTextSibling) ? 'inline' : 'block'
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
export function placeableUnder(parentTag: string): boolean {
  return BLOCK_PARENTS.has(parentTag) || PHRASING_PARENTS.has(parentTag)
}

// ---------------------------------------------------------------- DOM adapter (parse rules)
export function domEl(el: Element): ElLike {
  const parent = el.parentElement
  const parentTag = !parent || parent.localName === 'body' ? '#root' : parent.localName
  const siblings = parent ? Array.from(parent.childNodes) : []
  return {
    tag: el.localName,
    parentTag,
    hasChild: (t) => Array.from(el.children).some((c) => c.localName === t),
    hasTextSibling: siblings.some((n) => n.nodeType === 3 && /\S/.test(n.textContent ?? '')),
    insideTaskLabel: !!el.closest('li[data-type="taskItem"] > label'),
  }
}
