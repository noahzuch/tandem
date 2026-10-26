// Headless (Node + jsdom) version of the editor's load/save path (spike 03/04):
//   load:  HTML file → split shell/body → prepareForEditor (byte-exact islands) → ProseMirror doc
//   save:  ProseMirror doc → DOMSerializer (island placeholders) → prettier → expandIslands → join shell
// plus the Yjs conversions the server and the agent CLI share.
import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { getSchema } from '@tiptap/core'
import { DOMParser as PMDOMParser, DOMSerializer, Fragment, Node as PMNode, type Schema } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import * as Y from 'yjs'
import { initProseMirrorDoc, prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap'
import { buildExtensions, BLOCK_ID_ATTR, BLOCK_ID_TYPES, generateBlockId } from '../src/extensions.ts'
import { prepareForEditor } from '../src/islands/source.ts'
import { expandIslands } from '../src/islands/raw.ts'
import { splitDocument, joinDocument, formatBody, type DocParts } from './htmlDoc.ts'

export const extensions = buildExtensions()
export const schema: Schema = getSchema(extensions)
/** Tiptap Collaboration's default fragment name */
export const Y_FIELD = 'default'

const win = new JSDOM('<!DOCTYPE html><html><body></body></html>').window
const document = win.document

export const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')

// ---------------------------------------------------------------- HTML ⇄ ProseMirror
/** body HTML → ProseMirror doc (exactly the editor's parse, minus the browser) */
export function bodyToDoc(body: string): PMNode {
  const prepared = prepareForEditor(body).html
  const host = document.createElement('div')
  host.innerHTML = prepared
  return PMDOMParser.fromSchema(schema).parse(host as unknown as globalThis.Node)
}

/** an HTML snippet (one or more blocks) → block nodes, as the agent would paste them */
export function htmlToBlocks(html: string): Fragment {
  const content = bodyToDoc(html).content
  // the parser pads an empty result with one paragraph; drop a trailing empty paragraph that the snippet didn't ask for
  if (content.childCount > 1 && content.lastChild?.type.name === 'paragraph' && content.lastChild.content.size === 0 && !/<p>\s*<\/p>\s*$/.test(html))
    return content.cut(0, content.size - content.lastChild.nodeSize)
  return content
}

/** ProseMirror doc → body HTML with island placeholders (what editor.getHTML() returns) */
export function docToRawBody(doc: PMNode): string {
  const wrap = document.createElement('div')
  DOMSerializer.fromSchema(schema).serializeFragment(doc.content, { document: document as unknown as Document }, wrap as unknown as HTMLElement)
  return wrap.innerHTML
}

/** ProseMirror doc → body HTML as the server saves it: prettier on placeholders, then expand */
export async function docToBody(doc: PMNode, pretty = true): Promise<string> {
  const raw = docToRawBody(doc)
  return expandIslands(pretty ? await formatBody(raw) : raw)
}

export interface Loaded {
  parts: DocParts
  doc: PMNode
}

export function loadHtml(file: string): Loaded {
  const parts = splitDocument(file)
  return { parts, doc: bodyToDoc(parts.body) }
}

export async function saveHtml(l: Loaded, pretty = true): Promise<string> {
  return joinDocument(l.parts, await docToBody(l.doc, pretty))
}

// ---------------------------------------------------------------- block ids
/** give every addressable block that has none a block id (the UniqueID extension does this in the browser) */
export function withBlockIds(doc: PMNode): PMNode {
  const tr = new Transform(doc)
  const seen = new Set<string>()
  doc.descendants((node, pos) => {
    if (!BLOCK_ID_TYPES.includes(node.type.name)) return
    const id = node.attrs[BLOCK_ID_ATTR] as string | null
    if (id && !seen.has(id)) {
      seen.add(id)
      return
    }
    tr.setNodeMarkup(tr.mapping.map(pos), undefined, { ...node.attrs, [BLOCK_ID_ATTR]: generateBlockId() })
  })
  return tr.doc
}

// ---------------------------------------------------------------- Yjs
export const fragmentOf = (ydoc: Y.Doc) => ydoc.getXmlFragment(Y_FIELD)

/** seed an (empty) Y.Doc fragment from a ProseMirror doc */
export function seedFragment(ydoc: Y.Doc, doc: PMNode): void {
  prosemirrorToYXmlFragment(doc, fragmentOf(ydoc))
}

export function yToDoc(ydoc: Y.Doc): PMNode {
  return yXmlFragmentToProseMirrorRootNode(fragmentOf(ydoc), schema)
}

/** ProseMirror doc + the Y type → node mapping the reconciler needs to produce minimal ops */
export function yToDocWithMapping(ydoc: Y.Doc) {
  return initProseMirrorDoc(fragmentOf(ydoc), schema)
}

/** plain text of a doc, blocks separated by \n (for assertions and logs) */
export const docText = (doc: PMNode) => doc.textBetween(0, doc.content.size, '\n', '￼')
