// Placeholder encoding for raw HTML islands.
//
// The island's verbatim source travels through the editor as ONE attribute:
//   block:  <div data-raw-island="&lt;svg …&gt;…"></div>
//   inline: <span data-raw-island="…"></span>
// getHTML() emits these placeholders; expandIslands() swaps them back for the verbatim source.
// Why not let renderHTML emit the real element? Because getHTML() goes through the browser's HTML
// serializer, which normalises markup (<path/> → <path></path>, entity forms, attribute quoting) —
// the island would no longer be byte-identical. Placeholders also survive prettier untouched
// (prettier never rewrites an attribute value), so the server formats first and expands after.

export const ISLAND_ATTR = 'data-raw-island'

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** inverse of the serializer's attribute escaping (browser, jsdom, happy-dom, prettier output) */
export function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** text content → HTML text (for editing leaf text inside an island) */
export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;')
}

export function placeholder(html: string, inline: boolean): string {
  const tag = inline ? 'span' : 'div'
  return `<${tag} ${ISLAND_ATTR}="${escapeAttr(html)}"></${tag}>`
}

// tolerant of prettier's output: line wrapping (<div\n  data-raw-island="…"\n></div\n>) and its
// quote switching (a value with many " becomes single-quoted with &quot; decoded)
const PLACEHOLDER_RE = /<(div|span)\s+data-raw-island=(?:"([^"]*)"|'([^']*)')\s*>\s*<\/\1\s*>/g

export function expandIslands(html: string): string {
  return html.replace(PLACEHOLDER_RE, (_m, _tag, dq: string | undefined, sq: string | undefined) => unescapeAttr(dq ?? sq ?? ''))
}

export function countPlaceholders(html: string): number {
  return (html.match(PLACEHOLDER_RE) ?? []).length
}
