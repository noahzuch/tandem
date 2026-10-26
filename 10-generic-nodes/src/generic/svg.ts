// Spike 10 experiment: SVG as ProseMirror nodes (instead of an island).
//
//   svgRoot   <svg …>            block node, content: svgChild*     rendered with the SVG namespace
//   svgEl     <rect>, <g>, <defs>, <path>, <line>, <marker> …   content: svgChild*  (tag + attrs)
//   svgText   <text …>           TEXTBLOCK (content: text*) rendered as "http://www.w3.org/2000/svg text"
//
// DOMOutputSpec supports "namespace tag" (prosemirror-model: a space in the tag name = createElementNS).
// Enabled by policy.svg = 'nodes' (?svg=nodes in the app, --svg nodes on the server); otherwise the
// parse rules decline and spike 04's island rule takes the <svg>. What Chromium does with a caret inside
// an SVG <text> that lives in a contenteditable HTML ancestor is measured by verify/matrix.ts (column svgText).
import { Node, mergeAttributes } from '@tiptap/core'
import { policy } from './policy'
import { collectAllAttrs } from './nodes'

export const SVG_NS = 'http://www.w3.org/2000/svg'
const on = () => policy.svg === 'nodes'
const isSvg = (el: Element) => el.namespaceURI === SVG_NS

export const SvgRoot = Node.create({
  name: 'svgRoot',
  group: 'block',
  content: 'svgChild*',
  selectable: true,
  draggable: false,
  addAttributes: () => ({ attrs: { default: null, rendered: false } }),
  parseHTML: () => [{ tag: 'svg', priority: 5, getAttrs: (el: HTMLElement) => (on() ? { attrs: collectAllAttrs(el) } : false) }],
  renderHTML: ({ node, HTMLAttributes }) => [`${SVG_NS} svg`, mergeAttributes(node.attrs.attrs ?? {}, HTMLAttributes), 0],
})

export const SvgText = Node.create({
  name: 'svgText',
  group: 'svgChild',
  content: 'text*',
  marks: '',
  addAttributes: () => ({ attrs: { default: null, rendered: false } }),
  parseHTML: () => [{ tag: 'text', priority: 5, getAttrs: (el: HTMLElement) => (on() && isSvg(el) ? { attrs: collectAllAttrs(el) } : false) }],
  renderHTML: ({ node, HTMLAttributes }) => [`${SVG_NS} text`, mergeAttributes(node.attrs.attrs ?? {}, HTMLAttributes), 0],
})

export const SvgEl = Node.create({
  name: 'svgEl',
  group: 'svgChild',
  content: 'svgChild*',
  selectable: false,
  addAttributes: () => ({ tag: { default: 'g', rendered: false }, attrs: { default: null, rendered: false } }),
  parseHTML: () => [
    {
      tag: '*',
      priority: 4,
      getAttrs: (el: HTMLElement) => (on() && isSvg(el) && el.localName !== 'svg' && el.localName !== 'text' ? { tag: el.localName, attrs: collectAllAttrs(el) } : false),
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [`${SVG_NS} ${node.attrs.tag}`, mergeAttributes(node.attrs.attrs ?? {}, HTMLAttributes), 0],
})
