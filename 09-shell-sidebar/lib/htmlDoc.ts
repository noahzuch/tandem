// Split an HTML file into "shell" (doctype, <head>, <body ...> tag, trailing </body></html>) and the
// body content. The editor only ever owns the body content; the shell is preserved byte-for-byte.
import * as prettier from 'prettier'

export interface DocParts {
  /** everything up to and including the opening <body ...> tag ('' if the file has no <body>) */
  before: string
  /** inner HTML of <body> */
  body: string
  /** everything from </body> to the end ('' if none) */
  after: string
}

const BODY_OPEN = /<body\b[^>]*>/i
const BODY_CLOSE = /<\/body\s*>/i

export function splitDocument(html: string): DocParts {
  const open = BODY_OPEN.exec(html)
  if (!open) return { before: '', body: html, after: '' }
  const start = open.index + open[0].length
  const rest = html.slice(start)
  const close = BODY_CLOSE.exec(rest)
  const end = close ? start + close.index : html.length
  return { before: html.slice(0, start), body: html.slice(start, end), after: html.slice(end) }
}

export function joinDocument(parts: DocParts, newBody: string): string {
  if (!parts.before) return newBody
  return `${parts.before}\n${newBody.trim()}\n${parts.after}`
}

/** Pretty-print an HTML body fragment so that line-based diffs stay small. */
export async function formatBody(body: string): Promise<string> {
  return prettier.format(body, { parser: 'html', printWidth: 100 })
}
