// Spike 10: generic element nodes. An element the schema doesn't model keeps its tag + ALL attributes
// and holds editable children — its text is part of ProseMirror's tree (marks, comments, per-character
// Yjs merge), unlike an island (one string attribute).
//
//   genericBlock      <x-card> / <figure> / <dl> … with block children        content: block+
//   genericTextBlock  <x-note>, <figcaption>, <dt>, <dd> … holding text        content: inline*
//   genericInline     <x-badge> inside a paragraph                             inline node, content: inline*
//
// `mode` (free | locked) and `marks` (allowed in locked mode) come from src/generic/policy.ts at parse time
// and are not rendered (a `data-edit` attribute, if the author used one, is kept like any other attribute).
// `attrs` keeps every attribute verbatim except editor-internal ones and on* handlers (same policy as spike 04).
import { Node, mergeAttributes, type NodeViewRenderer } from '@tiptap/core'
// (the editor marks generic nodes with a `data-generic` node DECORATION — see guards.ts — so nothing
//  editor-internal ends up in the saved HTML)
import { classifyAll, domEl } from '../islands/classify'
import { ISLAND_ATTR } from '../islands/raw'
import { policy, type GenericShape } from './policy'

const NEVER = new Set(['contenteditable', 'draggable', ISLAND_ATTR, 'data-pm-slice', 'data-bid'])

export function collectAllAttrs(el: Element): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const a of Array.from(el.attributes)) {
    if (NEVER.has(a.name) || /^on/i.test(a.name)) continue
    out[a.name] = a.value
  }
  return Object.keys(out).length ? out : null
}

export const GENERIC_TYPES = ['genericBlock', 'genericTextBlock', 'genericInline'] as const
export type GenericType = (typeof GENERIC_TYPES)[number]
export const isGenericType = (name: string): name is GenericType => (GENERIC_TYPES as readonly string[]).includes(name)

function genericAttrs() {
  return {
    tag: { default: 'div', rendered: false },
    attrs: { default: null, rendered: false },
    mode: { default: 'free', rendered: false },
    marks: { default: null, rendered: false },
  }
}

function parseRule(shape: GenericShape) {
  return {
    tag: '*',
    priority: 5, // below the explicit nodes (Callout 60, Container 40), above the island fallback (1)
    getAttrs: (el: HTMLElement) => {
      const o = classifyAll(domEl(el))
      if (o.kind !== 'generic' || o.shape !== shape) return false
      return { tag: el.localName, attrs: collectAllAttrs(el), mode: o.mode, marks: o.marks }
    },
  }
}

const render = ({ node, HTMLAttributes }: { node: { attrs: Record<string, unknown> }; HTMLAttributes: Record<string, unknown> }) =>
  [node.attrs.tag as string, mergeAttributes((node.attrs.attrs as Record<string, string>) ?? {}, HTMLAttributes), 0] as const

export interface GenericOptions {
  view: NodeViewRenderer | null
}

export const GenericBlock = Node.create<GenericOptions>({
  name: 'genericBlock',
  group: 'block',
  content: 'block+',
  defining: true,
  // round 2: like a table cell — joins / lifts / deleteRange never cross the element's edge (policy.isolating
  // is read when the schema is built: ?isolating=0 measures the alternative)
  isolating: () => policy.isolating,
  // an isolating node makes every position next to its children a gap-cursor stop (prosemirror-gapcursor's
  // closedBefore/closedAfter): → from "Before" would first land *inside* the card before its first child.
  // Enter at the start/end of a child element inserts a paragraph there instead (protect.ts).
  allowGapCursor: false,
  selectable: true,
  draggable: false,
  addOptions: () => ({ view: null }),
  addAttributes: genericAttrs,
  parseHTML: () => [parseRule('block')],
  renderHTML: render,
  addNodeView() {
    return this.options.view
  },
})

export const GenericTextBlock = Node.create<GenericOptions>({
  name: 'genericTextBlock',
  group: 'block',
  content: 'inline*',
  defining: true,
  // NOT isolating (measured in round 2): an isolating TEXTBLOCK makes ProseMirror's replace fitter refuse to open
  // it for an inline insertion — Tiptap's insertContent of a hardBreak / image fails, Shift+Enter does nothing.
  // The edge protection of a textblock comes from the keymap (protect.ts) and, when nested, from the enclosing
  // block's isolating edge (lift / joinBackward stop at the block).
  selectable: true,
  draggable: false,
  addOptions: () => ({ view: null }),
  addAttributes: genericAttrs,
  parseHTML: () => [parseRule('textblock')],
  renderHTML: render,
  addNodeView() {
    return this.options.view
  },
})

export const GenericInline = Node.create({
  name: 'genericInline',
  group: 'inline',
  inline: true,
  content: 'inline*',
  selectable: false,
  addAttributes: genericAttrs,
  parseHTML: () => [parseRule('inline')],
  renderHTML: render,
})
