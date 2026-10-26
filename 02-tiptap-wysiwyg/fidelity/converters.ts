// Three ways to run HTML -> Tiptap (ProseMirror JSON) -> HTML with the app's exact extension list.
import { JSDOM } from 'jsdom'
import { getSchema } from '@tiptap/core'
import { DOMParser as PMDOMParser, DOMSerializer, Node as PMNode } from '@tiptap/pm/model'
import { generateHTML, generateJSON } from '@tiptap/html/server'
import type { Page } from 'playwright'
import { buildExtensions } from '../src/extensions.ts'

export interface RoundTrip {
  json: unknown
  html: string
}
export type Converter = (html: string) => Promise<RoundTrip>

const extensions = buildExtensions()
const schema = getSchema(extensions)

/** @tiptap/html/server — the official Node helper, uses happy-dom. */
export const happyDom: Converter = async (html) => {
  const json = generateJSON(html, extensions)
  return { json, html: generateHTML(json, extensions) }
}

/** Same pipeline by hand with jsdom (mirrors generateJSON: wraps the input in <body>). */
export const jsdom: Converter = async (html) => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`)
  const doc = dom.window.document
  const node = PMDOMParser.fromSchema(schema).parse(doc.body as unknown as globalThis.Node)
  const json = node.toJSON()
  const wrap = doc.createElement('div')
  DOMSerializer.fromSchema(schema).serializeFragment(PMNode.fromJSON(schema, json).content, {
    document: doc as unknown as Document,
  }, wrap as unknown as HTMLElement)
  const out = wrap.innerHTML
  dom.window.close()
  return { json, html: out }
}

/** The real editor in headless Chromium: editor.commands.setContent(html) + editor.getHTML(). */
export function browser(page: Page): Converter {
  return async (html) =>
    page.evaluate((h) => {
      const ed = (window as any).__editor
      ed.commands.setContent(h, { emitUpdate: false })
      return { json: ed.getJSON(), html: ed.getHTML() as string }
    }, html)
}
