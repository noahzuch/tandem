// HTML -> Tiptap (ProseMirror JSON) -> HTML, with spike 04's pipeline:
//   prepareForEditor (byte-exact islands) → parse → serialize (getHTML, placeholders) → expandIslands
// and, for the "before" column, spike 02's schema without any of that (baseline).
import { JSDOM } from 'jsdom'
import { getSchema, type Extensions } from '@tiptap/core'
import { DOMParser as PMDOMParser, DOMSerializer, Node as PMNode } from '@tiptap/pm/model'
import { generateHTML, generateJSON } from '@tiptap/html/server'
import type { Page } from 'playwright'
import { buildExtensions } from '../src/extensions.ts'
import { buildExtensions as buildBaseline } from './baselineExtensions.ts'
import { prepareForEditor } from '../src/islands/source.ts'
import { expandIslands } from '../src/islands/raw.ts'

export interface RoundTrip {
  json: unknown
  /** final HTML (islands expanded) — what lands on disk with --no-pretty */
  html: string
  /** editor HTML with island placeholders — what the server pretty-prints before expanding */
  raw: string
}
export type Converter = (html: string) => Promise<RoundTrip>

const extensions = buildExtensions()

function jsdomWith(exts: Extensions, prepare: boolean): Converter {
  const schema = getSchema(exts)
  return async (input) => {
    const html = prepare ? prepareForEditor(input).html : input
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`)
    const doc = dom.window.document
    const node = PMDOMParser.fromSchema(schema).parse(doc.body as unknown as globalThis.Node)
    const json = node.toJSON()
    const wrap = doc.createElement('div')
    DOMSerializer.fromSchema(schema).serializeFragment(
      PMNode.fromJSON(schema, json).content,
      { document: doc as unknown as Document },
      wrap as unknown as HTMLElement,
    )
    const raw = wrap.innerHTML
    dom.window.close()
    return { json, raw, html: prepare ? expandIslands(raw) : raw }
  }
}

/** spike 04 schema + prepare/expand, ProseMirror on jsdom */
export const jsdom: Converter = jsdomWith(extensions, true)
/** spike 02 schema, no islands (the "before" numbers) */
export const baseline: Converter = jsdomWith(buildBaseline(), false)

/** @tiptap/html/server — the official Node helper, uses happy-dom. */
export const happyDom: Converter = async (input) => {
  const json = generateJSON(prepareForEditor(input).html, extensions)
  const raw = generateHTML(json, extensions)
  return { json, raw, html: expandIslands(raw) }
}

/** The real editor in headless Chromium: exactly what the app does on load / save. */
export function browser(page: Page): Converter {
  return async (html) =>
    page.evaluate((h) => {
      const w = window as any
      const ed = w.__editor
      ed.commands.setContent(w.__islands.prepareForEditor(h).html, { emitUpdate: false })
      const raw = ed.getHTML() as string
      return { json: ed.getJSON(), raw, html: w.__islands.expandIslands(raw) as string }
    }, html)
}
