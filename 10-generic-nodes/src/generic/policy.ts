// Spike 10: the policy that decides what an element the schema does NOT model becomes.
//
//   island   spike 04: exact source in one attribute, shadow-root render, text-only leaves editable (plain text)
//   free     generic node (tag + all attributes + editable children); structure protected by src/generic/protect.ts
//            the way Tiptap's table protects its cells (not by rejecting transactions)
//   locked   round 1's alternative: generic node, text + (configured) marks editable, every structural
//            transaction rejected (src/generic/guards.ts) — kept as an option for comparison only
//
// Round 2's rule is deliberately simple (the user's decision): non-prose elements (ALWAYS_ISLAND, HTML comments,
// tables with <caption>) are islands, EVERYTHING ELSE is a free generic node. No data-edit attribute and no
// selector rules are needed in the default configuration. Both still exist as overrides:
//   (1) a per-element attribute   data-edit="free|locked|island"   (highest priority; the matrix uses it for its
//                                                                   locked / island comparison columns)
//   (2) config rules              selector → mode (+ allowed marks)   `policy.rules` (empty by default)
//   (3) the preset                `policy.default`  (--mode free|locked|islands on the server, ?mode= per tab)
//
// The *shape* of a generic node is NOT configured. It is derived (HTML content model + what the source holds):
//   inline context (phrasing parent / text siblings)           → genericInline   (inline node, inline* content)
//   children contain a flow (block-level) element              → genericBlock    (block+ content)
//   children are text / phrasing only                           → genericTextBlock (inline* content)
// `policy.textblocks = 'block'` is round 2's Enter variant (a): every non-inline generic element gets block+
// content (like a table cell), so <x-note>text</x-note> is saved as <x-note><p>text</p></x-note>.

export type GenericMode = 'free' | 'locked' | 'island'
export type GenericShape = 'block' | 'textblock' | 'inline'

export interface GenericRule {
  /** tiny selector: `tag`, `.class`, `tag.class`, `[attr]`, `[attr=value]`, `tag[attr=value]`, `x-*` (tag prefix) */
  match: string
  mode: GenericMode
  /** locked mode: mark types the user may still toggle inside (default: policy.lockedMarks) */
  marks?: string[]
}

export interface GenericPolicy {
  default: GenericMode
  rules: GenericRule[]
  /** marks allowed inside locked nodes when a rule doesn't say */
  lockedMarks: string[]
  /** 'island' (spike 04) or 'nodes' (experiment: svg elements as ProseMirror nodes) */
  svg: 'island' | 'nodes'
  /** round 2: `isolating: true` on generic blocks / textblocks / spike 04's Container (?isolating=0 to compare) */
  isolating: boolean
  /** round 2, Enter variant (a): 'block' = text-bearing generic elements get block+ content like a table cell */
  textblocks: 'inline' | 'block'
}

/** Non-prose elements: never a generic node. Their value is structure/behaviour, not text. */
export const ALWAYS_ISLAND = new Set([
  'svg', 'math', 'canvas', 'iframe', 'embed', 'object', 'video', 'audio', 'picture', 'source', 'track',
  'script', 'style', 'noscript', 'template', 'slot',
  'form', 'input', 'select', 'textarea', 'button', 'option', 'optgroup', 'fieldset', 'legend', 'datalist', 'output', 'progress', 'meter',
  'map', 'area', 'link', 'meta', 'base',
])

/** HTML flow-only elements (block-level in the content model) that are NOT in the schema's KNOWN_TAGS. */
export const FLOW_TAGS = new Set([
  'figure', 'figcaption', 'dl', 'dt', 'dd', 'caption', 'fieldset', 'legend', 'dialog', 'menu', 'search',
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'blockquote', 'hr', 'table', 'div', 'section', 'article',
  'header', 'footer', 'aside', 'main', 'nav', 'address', 'hgroup', 'details', 'summary', 'center',
])

/** round 1's rule set (preset `rules`), kept so the two rounds can be compared on one document */
export const ROUND1_RULES: GenericRule[] = [
  { match: '.box', mode: 'locked' },
  { match: '.diagram-box', mode: 'locked' },
  { match: 'figure', mode: 'free' },
  { match: 'figcaption', mode: 'free' },
  { match: 'dl', mode: 'free' },
  { match: 'x-*', mode: 'free' },
]

export const policy: GenericPolicy = {
  default: 'free',
  rules: [],
  lockedMarks: ['bold', 'italic', 'code', 'link'],
  svg: 'island',
  isolating: true,
  textblocks: 'inline',
}

export const PRESETS = ['free', 'locked', 'islands', 'rules'] as const

/** app/server switch: ?mode=free|locked|islands|rules  /  --mode … (default: free) */
export function setPolicyPreset(preset: string | null | undefined): void {
  switch (preset) {
    case 'locked':
      policy.default = 'locked'
      policy.rules = []
      break
    case 'islands':
    case 'island':
      policy.default = 'island'
      policy.rules = []
      break
    case 'rules': // round 1's default: islands unless a rule says otherwise
      policy.default = 'island'
      policy.rules = ROUND1_RULES
      break
    case 'generic': // round 1's name for "everything free" (+ its rules)
      policy.default = 'free'
      policy.rules = ROUND1_RULES
      break
    default:
      policy.default = 'free'
      policy.rules = []
  }
}

// ---------------------------------------------------------------- selector matching (parse5 + DOM)
export interface ElementView {
  tag: string
  attr(name: string): string | null
}

const SEL_RE = /^([a-z][\w-]*\*?)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:=("?)([^\]"]*)\4)?\])?$/i

export function matches(el: ElementView, selector: string): boolean {
  const m = SEL_RE.exec(selector.trim())
  if (!m) return false
  const [, tag, cls, attr, , value] = m
  if (tag) {
    if (tag.endsWith('*')) {
      if (!el.tag.startsWith(tag.slice(0, -1))) return false
    } else if (el.tag !== tag.toLowerCase()) return false
  }
  if (cls && !(el.attr('class') ?? '').split(/\s+/).includes(cls)) return false
  if (attr) {
    const v = el.attr(attr)
    if (v === null) return false
    if (value !== undefined && v !== value) return false
  }
  return true
}

export interface Decision {
  mode: GenericMode
  marks: string[]
  by: 'attribute' | 'rule' | 'inherited' | 'default' | 'always-island'
}

/** mode for an element the schema doesn't model; `inherit` = the mode of an enclosing generic node */
export function decide(el: ElementView, inherit?: GenericMode): Decision {
  if (ALWAYS_ISLAND.has(el.tag) && !(el.tag === 'svg' && policy.svg === 'nodes')) return { mode: 'island', marks: [], by: 'always-island' }
  const attr = el.attr('data-edit')
  if (attr === 'free' || attr === 'locked' || attr === 'island') return { mode: attr, marks: policy.lockedMarks, by: 'attribute' }
  for (const r of policy.rules) if (matches(el, r.match)) return { mode: r.mode, marks: r.marks ?? policy.lockedMarks, by: 'rule' }
  if (inherit && inherit !== 'island') return { mode: inherit, marks: policy.lockedMarks, by: 'inherited' }
  return { mode: policy.default, marks: policy.lockedMarks, by: 'default' }
}
