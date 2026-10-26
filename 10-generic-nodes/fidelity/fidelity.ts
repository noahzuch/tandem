// npm run fidelity — HTML round-trip fidelity with generic nodes vs islands, headless (jsdom pipeline = what the
// collaboration server writes to disk). For every ../samples/*.html and samples/*.html and each policy preset:
//   * which unknown elements became islands / generic nodes
//   * byte-exactness of every unknown element: source slice == output slice (islands: by construction;
//     generic nodes: re-serialised by the DOM → attribute order / quoting / whitespace / self-closing changes)
//   * attribute census (name=value pairs in → out), words kept, idempotence (pass1 → pass2 → pass3)
//   * the prettier path (what the server actually writes)
// Writes fidelity/report.md.
import fs from 'node:fs'
import path from 'node:path'
import { parseFragment, type DefaultTreeAdapterTypes as T } from 'parse5'
import { root } from '../lib/serverProc.ts'
import { loadHtml, saveHtml } from '../lib/pipeline.ts'
import { splitDocument } from '../lib/htmlDoc.ts'
import { setPolicyPreset, policy } from '../src/generic/policy.ts'
import { KNOWN_TAGS, INLINE_ELEMENTS } from '../src/islands/classify.ts'
import { prepareForEditor } from '../src/islands/source.ts'

// round 2: `free` is the default; `free+block` is Enter variant (a) (every text-bearing element gets block+ content);
// `rules` = round 1's default (islands unless a rule says otherwise), `locked` = round 1's lock, `islands` = spike 04
const PRESETS = ['islands', 'rules', 'free', 'free+block', 'locked'] as const
const samples = [
  ...fs.readdirSync(path.resolve(root, '../samples')).filter((f) => f.endsWith('.html')).map((f) => path.resolve(root, '../samples', f)),
  ...fs.readdirSync(path.resolve(root, 'samples')).filter((f) => f.endsWith('.html')).map((f) => path.resolve(root, 'samples', f)),
]

interface Unknown {
  tag: string
  source: string
  /** opening tag (to find the element again in the output) */
  open: string
}

/** every element with a tag the schema doesn't model, with its exact source slice (outermost only) */
function unknownElements(body: string): Unknown[] {
  const frag = parseFragment(body, { sourceCodeLocationInfo: true })
  const out: Unknown[] = []
  const walk = (n: T.ParentNode) => {
    for (const c of n.childNodes) {
      if (!('tagName' in c)) continue
      const tag = c.tagName.toLowerCase()
      const loc = c.sourceCodeLocation!
      if (!KNOWN_TAGS.has(tag) || (tag === 'table' && c.childNodes.some((x) => 'tagName' in x && x.tagName === 'caption'))) {
        out.push({ tag, source: body.slice(loc.startOffset, loc.endOffset), open: body.slice(loc.startTag!.startOffset, loc.startTag!.endOffset) })
        continue
      }
      walk(c)
    }
  }
  walk(frag)
  return out
}

/** CSS as the browser re-serialises it: `display:grid` → `display: grid`, `#c00` → rgb(204, 0, 0) (spike 02/04 finding) */
function cssNorm(v: string): string {
  const hex = (h: string) => {
    const x = h.length === 4 ? h.slice(1).split('').map((c) => c + c).join('') : h.slice(1)
    return `rgb(${parseInt(x.slice(0, 2), 16)}, ${parseInt(x.slice(2, 4), 16)}, ${parseInt(x.slice(4, 6), 16)})`
  }
  return v
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(':')
      return `${d.slice(0, i).trim().toLowerCase()}: ${d.slice(i + 1).trim().replace(/#[0-9a-f]{3}\b|#[0-9a-f]{6}\b/gi, hex)}`
    })
    .join('; ')
}
function attrCensus(body: string): Set<string> {
  const set = new Set<string>()
  const frag = parseFragment(body)
  const walk = (n: T.ParentNode) => {
    for (const c of n.childNodes) {
      if (!('tagName' in c)) continue
      for (const a of c.attrs) if (!['data-bid', 'data-raw-island', 'colwidth'].includes(a.name)) set.add(`${c.tagName}@${a.name}=${a.name === 'style' ? cssNorm(a.value) : a.value.replace(/\s+/g, ' ').trim()}`)
      walk(c)
    }
  }
  walk(frag)
  return set
}
const words = (html: string) => html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length
/**
 * block-level elements whose direct text got wrapped: `<tag …><p>` in the output where the input had `<tag …>text`.
 * Inline elements and list items / table cells are left out: Tiptap always puts a <p> inside <li>/<td>/<th>
 * (same in every preset — the baseline, not a policy cost).
 */
const ALWAYS_WRAPPED = new Set(['li', 'td', 'th', 'p', 'pre', 'svg', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary'])
function wrappedElements(body: string, out: string): string[] {
  const label = (c: T.Element) => {
    const cls = c.attrs.find((a) => a.name === 'class')?.value.split(/\s+/)[0]
    const id = c.attrs.find((a) => a.name === 'id')?.value
    return `<${c.tagName}${id ? '#' + id : cls ? '.' + cls : ''}>`
  }
  const textOnly = (frag: T.ParentNode): string[] => {
    const res: string[] = []
    const walk = (n: T.ParentNode) => {
      for (const c of n.childNodes) {
        if (!('tagName' in c)) continue
        if (ALWAYS_WRAPPED.has(c.tagName) || INLINE_ELEMENTS.has(c.tagName)) {
          walk(c)
          continue
        }
        const kids = c.childNodes
        const hasText = kids.some((k) => k.nodeName === '#text' && /\S/.test((k as T.TextNode).value))
        const hasP = kids.some((k) => 'tagName' in k && k.tagName === 'p')
        if (hasText && !hasP) res.push(label(c))
        walk(c)
      }
    }
    walk(frag)
    return res
  }
  const before = textOnly(parseFragment(body))
  const after = new Set(textOnly(parseFragment(out)))
  return before.filter((l) => !after.has(l))
}
const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/> </g, '><').trim()

interface Row {
  sample: string
  preset: string
  islands: number
  generic: number
  unknown: number
  byteExact: number
  normalisedOnly: number
  changed: string[]
  attrsIn: number
  attrsKept: number
  attrsLost: string[]
  wordsIn: number
  wordsOut: number
  stableAfter: number
  prettyStable: boolean
  bytesOut: number
  /** <p> elements the round trip ADDED: text that got wrapped in a paragraph (known wrappers, callouts, loose text, block+ textblocks) */
  pAdded: number
  /** which elements got a <p> wrapped around their text (tag + first class/id), for the report */
  wrapped: string[]
}

const rows: Row[] = []
for (const file of samples) {
  const html = fs.readFileSync(file, 'utf8')
  const body = splitDocument(html).body
  for (const preset of PRESETS) {
    setPolicyPreset(preset.replace('+block', ''))
    policy.svg = 'island'
    policy.textblocks = preset.endsWith('+block') ? 'block' : 'inline'
    const stats = prepareForEditor(body).stats
    const pass1 = await saveHtml(loadHtml(html), false)
    const pass2 = await saveHtml(loadHtml(pass1), false)
    const pass3 = await saveHtml(loadHtml(pass2), false)
    const stableAfter = pass1 === pass2 ? 1 : pass2 === pass3 ? 2 : 99
    const pretty1 = await saveHtml(loadHtml(html), true)
    const pretty2 = await saveHtml(loadHtml(pretty1), true)
    const out = splitDocument(pass1).body
    const unknown = unknownElements(body)
    let byteExact = 0
    let normalisedOnly = 0
    const changed: string[] = []
    for (const u of unknown) {
      if (out.includes(u.source)) byteExact++
      else {
        // find the element in the output by its tag + first attribute, compare normalised
        const outUnknown = unknownElements(out).find((o) => o.tag === u.tag && norm(o.source).includes(norm(u.source).slice(0, 25)))
        const outNorm = outUnknown ? norm(outUnknown.source) : null
        if (outNorm && outNorm === norm(u.source)) normalisedOnly++
        else {
          const any = outUnknown ?? unknownElements(out).find((o) => o.tag === u.tag)
          changed.push(`<${u.tag}> ${outNorm ? 'changed: ' + firstDiff(norm(u.source), outNorm) : `restructured: ${norm(u.source).slice(0, 90)} → ${any ? norm(any.source).slice(0, 110) : '(no such element in the output)'}`}`)
        }
      }
    }
    const ain = attrCensus(body)
    const aout = attrCensus(out)
    const lost = Array.from(ain).filter((a) => !aout.has(a))
    rows.push({
      sample: path.basename(file),
      preset,
      islands: stats.blockIslands + stats.inlineIslands,
      generic: stats.generic,
      unknown: unknown.length,
      byteExact,
      normalisedOnly,
      changed,
      attrsIn: ain.size,
      attrsKept: ain.size - lost.length,
      attrsLost: lost,
      wordsIn: words(body),
      wordsOut: words(out),
      stableAfter,
      prettyStable: pretty1 === pretty2,
      bytesOut: Buffer.byteLength(out),
      wrapped: wrappedElements(body, out),
      pAdded: wrappedElements(body, out).length,
    })
  }
}

function firstDiff(a: string, b: string): string {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  const s = Math.max(0, i - 25)
  return `…${a.slice(s, i + 40)}… → …${b.slice(s, i + 40)}…`
}

const md: string[] = []
md.push('# Fidelity: generic nodes vs islands (headless pipeline, what the server writes)', '')
md.push('| sample | preset | unknown elements | islands | generic | byte-exact | normalised only | changed | `<p>` added | attrs kept | words | stable after | prettier fixed point | bytes |')
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) md.push(`| ${r.sample} | ${r.preset} | ${r.unknown} | ${r.islands} | ${r.generic} | ${r.byteExact} | ${r.normalisedOnly} | ${r.changed.length} | ${r.pAdded ? `**${r.pAdded}**` : 0} | ${r.attrsKept}/${r.attrsIn} | ${r.wordsOut}/${r.wordsIn} | ${r.stableAfter === 99 ? 'unstable' : r.stableAfter} | ${r.prettyStable ? 'yes' : 'no'} | ${r.bytesOut} |`)
md.push('', '"normalised only" = same after collapsing whitespace (indentation inside the element lost; attribute order/quoting kept). "`<p>` added" = block-level elements (whole body, known wrappers such as `<div>` included; list items / table cells excluded, Tiptap always wraps those) whose direct text got a `<p>` around it in the round trip — the fidelity cost of block+ content models; the elements are listed below.', '')
md.push('## What changed per element', '')
for (const r of rows) {
  if (!r.changed.length && !r.attrsLost.length && !r.wrapped.length) continue
  md.push(`### ${r.sample} · ${r.preset}`, '')
  for (const c of r.changed) md.push(`- ${c.replace(/</g, '&lt;').replace(/>/g, '&gt;')}`)
  if (r.wrapped.length) md.push(`- text wrapped in \`<p>\`: ${r.wrapped.map((w) => '`' + w + '`').join(', ')}`)
  if (r.attrsLost.length) md.push(`- attributes lost/changed: ${r.attrsLost.map((a) => '`' + a + '`').join(', ')}`)
  md.push('')
}
fs.writeFileSync(path.join(root, 'fidelity/report.md'), md.join('\n') + '\n')
console.log(md.join('\n'))
