// `collab check <file.html>`: tell the agent, right after it wrote HTML, what the editor will do with it.
//
// Two layers:
//   1. Lint rules on the source (parse5 + source locations): which elements become raw HTML islands,
//      known lossy/odd shapes with a concrete fix ("use <section> instead of <x-card> for prose").
//   2. Ground truth: run the real editor schema headlessly (same pipeline as the editor's load/save),
//      then compare input vs. output element-by-element (text, tags, attributes, island bytes,
//      idempotence). Anything the lint rules didn't predict still shows up here.
import { parseFragment, type DefaultTreeAdapterTypes as T } from 'parse5'
import { JSDOM } from 'jsdom'
import { splitDocument } from './htmlDoc.ts'
import { bodyToDoc, docToRawBody } from './pipeline.ts'
import { classify, placeableUnder, KNOWN_TAGS, PHRASING_PARENTS } from '../src/islands/classify.ts'
import { prepareForEditor } from '../src/islands/source.ts'
import { ISLAND_ATTR, unescapeAttr } from '../src/islands/raw.ts'

export type Severity = 'error' | 'warn' | 'info'
export interface Finding {
  severity: Severity
  rule: string
  line: number
  message: string
}
export interface CheckResult {
  file: string
  findings: Finding[]
  stats: { nodes: number; blockIslands: number; inlineIslands: number; comments: number; stable: boolean }
}

const BLOCK_PROSE = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'table', 'pre', 'section', 'article', 'div'])
const BLOCK_TAGS = new Set([...BLOCK_PROSE, 'li', 'hr', 'header', 'footer', 'aside', 'nav', 'main', 'details', 'figure', 'dl'])
const INLINE = new Set(['a', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'strike', 'ins', 'mark', 'code', 'sub', 'sup', 'span', 'small', 'abbr', 'kbd', 'cite', 'q', 'dfn', 'var', 'samp', 'time', 'bdi', 'bdo', 'data', 'font', 'big', 'tt'])
const VOID = new Set(['br', 'hr', 'img', 'input', 'col', 'wbr'])
/** elements whose end tag may legally be omitted */
const OPTIONAL_END = new Set(['p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'caption', 'option', 'optgroup', 'rb', 'rt', 'rp', 'html', 'head', 'body'])
const RENAMES: Record<string, string> = { b: 'strong', i: 'em', del: 's', strike: 's' }
/** tags Tiptap drops/adds by design without content loss */
const STRUCTURAL = new Set(['thead', 'tbody', 'tfoot', 'colgroup', 'col', 'label', 'input'])
const NO_PLACEHOLDER = new Set(['ul', 'ol', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup'])

type P5 = T.ChildNode
const isEl = (n: P5): n is T.Element => 'tagName' in n
const isText = (n: P5): n is T.TextNode => n.nodeName === '#text'

export function checkHtml(file: string, name = 'input.html'): CheckResult {
  const parts = splitDocument(file)
  const base = parts.before.length
  const lineAt = (off: number) => file.slice(0, base + off).split('\n').length
  const findings: Finding[] = []
  const add = (severity: Severity, rule: string, off: number, message: string) => {
    const line = lineAt(off)
    if (!findings.some((f) => f.rule === rule && f.line === line && f.message === message)) findings.push({ severity, rule, line, message })
  }
  const body = parts.body

  // ------------------------------------------------------------ 1. lint rules (source level)
  const frag = parseFragment(body, { sourceCodeLocationInfo: true })
  const walk = (parent: T.ParentNode, parentTag: string, inPre: boolean, inInline: string | null) => {
    for (const n of parent.childNodes) {
      const off = n.sourceCodeLocation?.startOffset ?? 0
      if (n.nodeName === '#comment') {
        if (!placeableUnder(parentTag) && !inPre)
          add('warn', 'comment-dropped', off, `HTML comment directly inside <${parentTag}> is dropped (comments can only sit between blocks or in text). Move it before the <${parentTag}>.`)
        continue
      }
      if (isText(n)) {
        if (/\S/.test(n.value) && NO_PLACEHOLDER.has(parentTag))
          add('warn', 'stray-text', off, `Text "${n.value.trim().slice(0, 30)}" directly inside <${parentTag}> gets moved (into its own item/paragraph). Wrap it in <li>/<td> or put it outside.`)
        continue
      }
      if (!isEl(n)) continue
      const tag = n.tagName.toLowerCase()
      const attrs = n.attrs
      const loc = n.sourceCodeLocation
      if (loc && !loc.endTag && !VOID.has(tag) && !OPTIONAL_END.has(tag) && !body.slice(loc.startTag?.startOffset ?? 0, loc.startTag?.endOffset ?? 0).endsWith('/>'))
        add('warn', 'unclosed-tag', off, `<${tag}> is never closed: the browser closes it where it guesses (formatting may leak into following blocks). Add </${tag}>.`)
      for (const a of attrs) {
        if (/^on/i.test(a.name)) add('warn', 'event-handler-removed', off, `<${tag} ${a.name}=…>: event handlers are removed from editable elements (security policy).`)
        if (a.name === 'href' && /^\s*javascript:/i.test(a.value)) add('warn', 'js-link-removed', off, `<a href="javascript:…">: link is removed, text kept.`)
      }
      if (inPre && !(tag === 'code' && parentTag === 'pre')) {
        add('error', 'markup-in-code', off, `<${tag}> inside <pre> is dropped: code blocks hold plain text only (no syntax-highlight spans, links or bold).`)
        continue
      }
      if (inPre) {
        walk(n, tag, true, inInline)
        continue
      }
      if (RENAMES[tag]) add('info', 'renamed', off, `<${tag}> is saved as <${RENAMES[tag]}> (same rendering).`)
      if (inInline && BLOCK_TAGS.has(tag) && !findings.some((f) => f.rule === 'block-in-inline' && f.line === lineAt(off)))
        add('warn', 'block-in-inline', off, `Block <${tag}> inside inline <${inInline}> gets restructured (the inline element is split or moved inside). Put the inline element inside the block.`)
      const insideTaskLabel = false
      const kind = classify({
        tag,
        parentTag,
        hasChild: (t) => n.childNodes.some((c) => isEl(c) && c.tagName.toLowerCase() === t),
        hasTextSibling: parent.childNodes.some((s) => isText(s) && /\S/.test(s.value)),
        insideTaskLabel,
      })
      if (kind) {
        if (!placeableUnder(parentTag)) {
          add('error', 'island-unplaceable', off, `<${tag}> can't be kept inside <${parentTag}> (no room for a raw HTML island there) and will be lost. Move it out of the <${parentTag}>.`)
          continue
        }
        for (const d of descendants(n)) {
          const dl = d.sourceCodeLocation
          const dt = d.tagName.toLowerCase()
          if (dl && !dl.endTag && !VOID.has(dt) && !OPTIONAL_END.has(dt) && !body.slice(dl.startTag?.startOffset ?? 0, dl.startTag?.endOffset ?? 0).endsWith('/>'))
            add('warn', 'unclosed-tag', dl.startOffset, `<${dt}> inside the <${tag}> island is never closed: the browser closes it where it guesses. Add </${dt}>.`)
        }
        const prose = descendants(n).filter((d) => BLOCK_PROSE.has(d.tagName.toLowerCase()))
        const label = tag === 'table' ? '<table> with <caption>' : `<${tag}>`
        add('info', 'island', off, `${label} becomes a raw HTML island (${kind}): kept byte-for-byte and rendered as-is; users can only edit text-only leaves inside it.`)
        if (tag === 'table')
          add('warn', 'table-caption', off, `Because of <caption>, this table is not an editable table (no add row/column, no formatting in cells). Put the caption in a <p> above the table instead.`)
        else if (prose.length)
          add('warn', 'prose-in-island', off, `${label} contains ${prose.length} prose block(s) (${[...new Set(prose.map((p) => '<' + p.tagName + '>'))].join(', ')}): users can't format, split or extend this text. Use an editable container (<section>, <div>, <aside>, <article>) for prose; keep islands for diagrams/embeds.`)
        continue
      }
      const nextInline = PHRASING_PARENTS.has(tag) && tag !== 'p' && !/^h\d$/.test(tag) && tag !== 'summary' ? tag : inInline
      walk(n, tag, inPre || tag === 'pre', nextInline)
    }
  }
  walk(frag, '#root', false, null)

  // ------------------------------------------------------------ 2. ground truth: the real schema
  const prepared = prepareForEditor(body)
  const doc1 = bodyToDoc(body)
  const out1 = docToRawBody(doc1)
  // compare HTML, not JSON: stored style strings differ between pass 1 and 2 while the HTML doesn't (spike 04)
  const stable = docToRawBody(bodyToDoc(out1)) === out1
  if (!stable) add('warn', 'unstable', 0, 'The document changes again on a second load/save (location unknown): some construct is not a fixed point, e.g. nested marks that swap order.')

  const inp = dom(prepared.html)
  const out = dom(out1)
  // islands: every island source must survive byte-for-byte
  const islandsIn = Array.from(inp.querySelectorAll(`[${ISLAND_ATTR}]`)).map((e) => e.getAttribute(ISLAND_ATTR)!)
  const islandsOut = new Set(Array.from(out.querySelectorAll(`[${ISLAND_ATTR}]`)).map((e) => e.getAttribute(ISLAND_ATTR)!))
  for (const src of islandsIn)
    if (!islandsOut.has(src)) add('error', 'island-lost', locate(body, src.slice(0, 40)), `Raw HTML island ${src.slice(0, 40).replace(/\s+/g, ' ')}… did not survive.`)

  // text: words outside islands
  const wordsOut = bag(words(out))
  const lost: string[] = []
  for (const w of words(inp)) if (!take(wordsOut, w)) lost.push(w)
  if (lost.length) add('error', 'text-lost', locate(body, lost[0]), `${lost.length} word(s) are lost: ${lost.slice(0, 8).map((w) => JSON.stringify(w)).join(' ')}${lost.length > 8 ? ' …' : ''}`)

  // structure: every word must stay inside the same containers (li, td, blockquote, details, section…)
  const placedOut = bag(placedWords(out))
  const moved = new Map<string, string[]>() // "path|block text" → missing words
  const snippets: string[] = []
  // bag semantics: earlier occurrences match first, so the leftovers are the later (= changed) ones
  for (const [i, k] of placedWords(inp, snippets).entries())
    if (!take(placedOut, k)) {
      const key = `${k.split('|')[0]}|${snippets[i]}`
      moved.set(key, [...(moved.get(key) ?? []), k.split('|')[1]])
    }
  for (const [key, ws] of moved) {
    const [path, text] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)]
    const leaf = path.split('>').at(-1)!
    const sample = text.length > 40 ? text.slice(0, 40) + '…' : text
    const outPath = [...placedOut.keys()].find((k) => k.endsWith(`|${ws[0]}`) && (placedOut.get(k) ?? 0) > 0)?.split('|')[0]
    const line = lineAt(locate(body, ws[0]))
    const predicted = findings.some((f) => f.severity !== 'info' && f.rule !== 'structure-changed' && Math.abs(f.line - line) <= 1)
    add(predicted ? 'warn' : 'error', 'structure-changed', locate(body, ws[0]), `"${sample}" is moved out of ${path === '#root' ? 'the top level' : '<' + leaf + '> (' + path + ')'}${outPath !== undefined ? ' to ' + (outPath === '#root' ? 'the top level' : outPath) : ''}${predicted ? ' (predicted above)' : " — the schema doesn't allow this content there"}.`)
  }

  // elements: per (renamed) tag, count in vs. out
  const tagsOut = bag(elements(out).map((e) => normTag(e.localName)))
  const missingTags = new Map<string, number>()
  for (const e of elements(inp)) {
    const t = normTag(e.localName)
    if (STRUCTURAL.has(t)) continue
    if (!e.hasChildNodes() && !e.attributes.length && !VOID.has(t)) continue // empty <strong></strong>: nothing lost
    if (!take(tagsOut, t)) missingTags.set(t, (missingTags.get(t) ?? 0) + 1)
  }
  // attributes: per (tag, name, value)
  const attrsOut = bag(elements(out).flatMap(attrKeys))
  const missingAttrs = new Map<string, number>()
  for (const e of elements(inp))
    for (const k of attrKeys(e)) {
      if (/@on/.test(k) || /@href=\s*javascript:/i.test(k)) continue // reported by policy rules
      if (!take(attrsOut, k)) missingAttrs.set(k, (missingAttrs.get(k) ?? 0) + 1)
    }
  for (const [t, n] of missingTags) {
    const withAttrs = [...missingAttrs.keys()].filter((k) => k.startsWith(`${t}@`))
    withAttrs.forEach((k) => missingAttrs.delete(k))
    const attrNote = withAttrs.length ? ` with attributes ${withAttrs.map((k) => k.split('@')[1]).join(', ')}` : ''
    const predicted = findings.some((f) => f.message.includes(`<${t}>`) || f.message.includes(`<${t} `))
    add(predicted ? 'warn' : 'error', 'element-dropped', locate(body, `<${t}`), `${n}× <${t}>${attrNote} ${n > 1 ? 'are' : 'is'} not in the saved HTML${predicted ? ' (predicted above)' : ''}.`)
  }
  for (const [k, n] of missingAttrs) {
    const [tag, rest] = k.split('@')
    const name = rest.split(/[=:]/)[0]
    add('error', 'attribute-dropped', locateAttr(body, tag, name), `<${tag}> attribute ${rest} is lost${n > 1 ? ` (${n}×)` : ''}.`)
  }

  let nodes = 0
  doc1.descendants(() => {
    nodes++
  })
  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 }
  findings.sort((a, b) => a.line - b.line || order[a.severity] - order[b.severity])
  return {
    file: name,
    findings,
    stats: { nodes, blockIslands: prepared.stats.blockIslands, inlineIslands: prepared.stats.inlineIslands, comments: prepared.stats.comments, stable },
  }
}

// ---------------------------------------------------------------- helpers
function descendants(el: T.Element): T.Element[] {
  const out: T.Element[] = []
  const rec = (n: T.ParentNode) => {
    for (const c of n.childNodes) if (isEl(c)) (out.push(c), rec(c))
  }
  rec(el)
  return out
}
const dom = (html: string) => new JSDOM(`<!DOCTYPE html><body>${html}</body>`).window.document.body
const elements = (root: Element) => Array.from(root.querySelectorAll('*')).filter((e) => !e.closest(`[${ISLAND_ATTR}]`) || e.hasAttribute(ISLAND_ATTR))
const normTag = (t: string) => RENAMES[t] ?? t
function words(root: Element): string[] {
  const c = root.cloneNode(true) as Element
  c.querySelectorAll(`[${ISLAND_ATTR}]`).forEach((e) => e.remove())
  // block boundaries are word boundaries
  c.querySelectorAll('*').forEach((e) => {
    if (!INLINE.has(e.localName)) (e.before(' '), e.append(' '))
  })
  return (c.textContent ?? '').split(/[\s ]+/).filter(Boolean)
}
/** one key per CSS declaration, normalised by the CSSOM (#eee == rgb(238, 238, 238)) */
const styleHost = dom('').ownerDocument.createElement('div')
/** declarations the schema turns into marks (<span style="font-weight:bold"> → <strong>) */
const BECOMES_MARK = /^(font-weight:(bold|[6-9]00)|font-style:italic|text-decoration:(underline|line-through))$/
function styleDecls(v: string): string[] {
  styleHost.setAttribute('style', v)
  const st = styleHost.style
  const out: string[] = []
  for (let i = 0; i < st.length; i++) {
    const d = `${st[i]}:${st.getPropertyValue(st[i])}`
    if (!BECOMES_MARK.test(d)) out.push(d)
  }
  return out
}
function attrKeys(e: Element): string[] {
  if (e.hasAttribute(ISLAND_ATTR)) return []
  const t = normTag(e.localName)
  if (STRUCTURAL.has(t)) return []
  return Array.from(e.attributes)
    .filter((a) => !(t === 'table' && a.name === 'style')) // Tiptap writes its own min-width
    .flatMap((a) => (a.name === 'style' ? styleDecls(a.value).map((d) => `${t}@style:${d}`) : [`${t}@${a.name}=${a.value}`]))
}
const CONTAINERS = new Set(['ul', 'ol', 'li', 'table', 'td', 'th', 'blockquote', 'details', 'summary', 'section', 'article', 'header', 'footer', 'aside', 'nav', 'main', 'div'])
/** "ul>li|word" for every word outside islands; text is joined per block first, so inline markup
 *  changes (<a>fake button</a>. → fake button.) don't split or merge words */
function placedWords(root: Element, snippets?: string[]): string[] {
  const out: string[] = []
  let buf = ''
  let cur: { block: Element | null; path: string } = { block: null, path: '' }
  const flush = () => {
    for (const w of buf.split(/[\s\u00a0]+/).filter(Boolean)) {
      out.push(`${cur.path}|${w}`)
      snippets?.push(buf.replace(/\s+/g, ' ').trim())
    }
    buf = ''
  }
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement!
    if (el.closest(`[${ISLAND_ATTR}]`)) continue
    let block: Element = el
    while (block !== root && INLINE.has(block.localName)) block = block.parentElement!
    const path: string[] = []
    for (let a: Element | null = el; a && a !== root; a = a.parentElement) {
      const t = a.localName
      if (!CONTAINERS.has(t)) continue
      if (t === 'div' && a.parentElement?.matches('li[data-type="taskItem"]')) continue // Tiptap's task item wrapper
      path.unshift(t)
    }
    const p = path.join('>') || '#root'
    if (block !== cur.block || p !== cur.path) {
      flush()
      cur = { block, path: p }
    }
    buf += n.textContent ?? ''
  }
  flush()
  return out
}
function bag(xs: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return m
}
function take(m: Map<string, number>, k: string): boolean {
  const n = m.get(k) ?? 0
  if (!n) return false
  m.set(k, n - 1)
  return true
}
function locateAttr(body: string, tag: string, name: string): number {
  const tags = [tag, ...Object.keys(RENAMES).filter((k) => RENAMES[k] === tag)]
  for (const t of tags) {
    const m = new RegExp(`<${t}\\b[^>]*\\s${name}\\s*=`, 'i').exec(body)
    if (m) return m.index
  }
  return locate(body, `${name}=`)
}
function locate(body: string, needle: string): number {
  const i = body.indexOf(needle)
  if (i >= 0) return i
  const j = body.indexOf(unescapeAttr(needle))
  return j >= 0 ? j : 0
}

export function formatResult(r: CheckResult): string {
  const c = (s: Severity) => r.findings.filter((f) => f.severity === s).length
  const lines = [
    `${r.file}: ${c('error')} error(s), ${c('warn')} warning(s), ${c('info')} info — ${r.stats.nodes} editor nodes, ` +
      `${r.stats.blockIslands} block + ${r.stats.inlineIslands} inline island(s), ${r.stats.comments} comment(s), stable after 1 save: ${r.stats.stable}`,
  ]
  for (const f of r.findings) lines.push(`  L${String(f.line).padEnd(4)} ${f.severity.padEnd(5)} ${f.rule.padEnd(22)} ${f.message}`)
  return lines.join('\n')
}

export { KNOWN_TAGS }
