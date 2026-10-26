// Headless (Node + jsdom) version of the editor's load/save path from spike 04:
//   load:  HTML file → split shell/body → prepareForEditor (byte-exact islands) → ProseMirror doc
//   save:  ProseMirror doc → DOMSerializer (island placeholders) → prettier → expandIslands → join shell
// Plus the converters for the other candidate formats (ProseMirror JSON, Yjs state).
import { JSDOM } from 'jsdom'
import { getSchema } from '@tiptap/core'
import { DOMParser as PMDOMParser, DOMSerializer, Node as PMNode, type Schema } from '@tiptap/pm/model'
import * as Y from 'yjs'
import { prosemirrorToYDoc, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { buildExtensions } from '../src/extensions.ts'
import { prepareForEditor } from '../src/islands/source.ts'
import { expandIslands } from '../src/islands/raw.ts'
import { splitDocument, joinDocument, formatBody, type DocParts } from './htmlDoc.ts'

export const extensions = buildExtensions()
export const schema: Schema = getSchema(extensions)

const win = new JSDOM('<!DOCTYPE html><html><body></body></html>').window
const document = win.document

// ---------------------------------------------------------------- HTML
/** body HTML → ProseMirror doc (exactly the editor's parse, minus the browser) */
export function bodyToDoc(body: string): PMNode {
  const prepared = prepareForEditor(body).html
  const host = document.createElement('div')
  host.innerHTML = prepared
  return PMDOMParser.fromSchema(schema).parse(host as unknown as globalThis.Node)
}

/** ProseMirror doc → body HTML with island placeholders (what editor.getHTML() returns) */
export function docToRawBody(doc: PMNode): string {
  const wrap = document.createElement('div')
  DOMSerializer.fromSchema(schema).serializeFragment(
    doc.content,
    { document: document as unknown as Document },
    wrap as unknown as HTMLElement,
  )
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

/** what the file looks like after the editor opened and saved it once */
export async function canonicalHtml(file: string): Promise<string> {
  return saveHtml(loadHtml(file))
}

// ---------------------------------------------------------------- ProseMirror JSON
export interface JsonFile {
  format: 'collab-pm-json'
  version: 1
  /** the HTML shell (doctype, <head>, <body> tag / closing tags): the editor doesn't model it */
  shell: { before: string; after: string }
  doc: unknown
}

/** strip attributes that equal the schema default (getJSON() writes every attr, mostly nulls) */
export function minimizeJson(json: any): any {
  if (Array.isArray(json)) return json.map(minimizeJson)
  if (!json || typeof json !== 'object') return json
  const out: any = {}
  for (const [k, v] of Object.entries(json)) {
    if (k === 'attrs') {
      const type = json.type as string
      const spec = schema.nodes[type]?.spec.attrs ?? schema.marks[type]?.spec.attrs ?? {}
      const attrs: any = {}
      for (const [ak, av] of Object.entries(v as object)) {
        const def = (spec as any)[ak]?.default
        if (JSON.stringify(av) !== JSON.stringify(def === undefined ? null : def)) attrs[ak] = av
      }
      if (Object.keys(attrs).length) out.attrs = attrs
    } else out[k] = minimizeJson(v)
  }
  return out
}

export function toJsonFile(l: Loaded, minimal: boolean): string {
  const docJson = l.doc.toJSON()
  const f: JsonFile = {
    format: 'collab-pm-json',
    version: 1,
    shell: { before: l.parts.before, after: l.parts.after },
    doc: minimal ? minimizeJson(docJson) : docJson,
  }
  return JSON.stringify(f, null, 2) + '\n'
}

export function loadJsonFile(text: string): Loaded {
  const f = JSON.parse(text) as JsonFile
  const doc = PMNode.fromJSON(schema, f.doc)
  doc.check()
  return { parts: { before: f.shell.before, body: '', after: f.shell.after }, doc }
}

// ---------------------------------------------------------------- Yjs
export const Y_FRAGMENT = 'default' // Tiptap Collaboration's default field name

export function toYDoc(l: Loaded): Y.Doc {
  const ydoc = prosemirrorToYDoc(l.doc, Y_FRAGMENT)
  // the shell has to live somewhere too
  const shell = ydoc.getMap('shell')
  shell.set('before', l.parts.before)
  shell.set('after', l.parts.after)
  return ydoc
}

export function toYState(l: Loaded): Uint8Array {
  return Y.encodeStateAsUpdate(toYDoc(l))
}

export function loadYState(state: Uint8Array): Loaded {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, state)
  const doc = yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(Y_FRAGMENT), schema)
  const shell = ydoc.getMap<string>('shell')
  return { parts: { before: shell.get('before') ?? '', body: '', after: shell.get('after') ?? '' }, doc }
}
