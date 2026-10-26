// npm run check-json: typical agent mistakes, written once as ProseMirror JSON (format B) and once as HTML
// (format A). Shows what feedback each validator gives the agent. Also: npm run check-json -- <file.json>
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { canonicalHtml, loadHtml, toJsonFile } from '../lib/pipeline.ts'
import { checkJsonText, type JsonVerdict } from '../lib/checkJson.ts'
import { checkHtml, type Finding } from '../lib/check.ts'

type J = any
interface Mistake {
  id: string
  what: string
  /** mutate the parsed JSON file (or return replacement text) */
  json: (f: J, text: string) => J | string
  /** the same intent written as HTML, inserted before "5. Open tasks" */
  html: string
}

const find = (n: J, pred: (n: J) => boolean): J | undefined => {
  if (pred(n)) return n
  for (const c of n.content ?? []) {
    const r = find(c, pred)
    if (r) return r
  }
}
const top = (f: J) => f.doc.content as J[]
const insertTop = (f: J, node: J) => {
  const i = top(f).findIndex((n: J) => n.type === 'heading' && n.attrs?.htmlAttrs?.id === 'tasks')
  top(f).splice(i, 0, node)
  return f
}
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })

export const MISTAKES: Mistake[] = [
  {
    id: 'syntax-trailing-comma',
    what: 'trailing comma after the last array element',
    json: (_f, t) => t.replace(/("text": "Never lose a note written offline\.")/, '$1,'),
    html: '<p>Unclosed <strong>bold paragraph</p>',
  },
  {
    id: 'syntax-missing-brace',
    what: 'one closing } missing in a nested node',
    json: (_f, t) => t.replace(/("text": "Never lose a note written offline\."\n\s*)\}/, '$1'),
    html: '<ul><li><p>item without closing tags</ul>',
  },
  {
    id: 'marks-as-strings',
    what: 'marks written as ["bold"] instead of [{"type":"bold"}]',
    json: (f) => {
      find(f.doc, (n) => n.type === 'text' && n.marks?.[0]?.type === 'bold').marks = ['bold']
      return f
    },
    html: '<p>Some <b>bold</b> text.</p>',
  },
  {
    id: 'text-directly-in-listItem',
    what: 'listItem content = text (paragraph wrapper forgotten)',
    json: (f) => {
      find(f.doc, (n) => n.type === 'listItem').content = [{ type: 'text', text: 'Never lose a note.' }]
      return f
    },
    html: '<ul><li>Item without a paragraph.</li></ul>',
  },
  {
    id: 'heading-in-listItem',
    what: 'listItem starts with a heading (schema: paragraph block*)',
    json: (f) => {
      find(f.doc, (n) => n.type === 'listItem').content.unshift({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Step' }] })
      return f
    },
    html: '<ul><li><h3>Step</h3><p>Body of the step.</p></li></ul>',
  },
  {
    id: 'unknown-node-type',
    what: 'uses a node type the schema lacks ("figure")',
    json: (f) => insertTop(f, { type: 'figure', content: [para('caption')] }),
    html: '<figure><svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg><figcaption>caption</figcaption></figure>',
  },
  {
    id: 'attr-typo',
    what: 'heading attrs {"lvl": 2} instead of {"level": 2}',
    json: (f) => insertTop(f, { type: 'heading', attrs: { lvl: 2 }, content: [{ type: 'text', text: 'New section' }] }),
    html: '<h2 lvl="2">New section</h2>',
  },
  {
    id: 'empty-text-node',
    what: 'text node with ""',
    json: (f) => insertTop(f, { type: 'paragraph', content: [{ type: 'text', text: '' }] }),
    html: '<p><strong></strong></p>',
  },
  {
    id: 'paragraph-in-paragraph',
    what: 'paragraph nested in a paragraph',
    json: (f) => insertTop(f, { type: 'paragraph', content: [para('inner')] }),
    html: '<p>outer <p>inner</p></p>',
  },
  {
    id: 'ragged-table-row',
    what: 'table row with 2 cells in a 3-column table',
    json: (f) => {
      const tbl = find(f.doc, (n) => n.type === 'table')
      tbl.content.push({ type: 'tableRow', content: [{ type: 'tableCell', content: [para('429')] }, { type: 'tableCell', content: [para('Rate limited')] }] })
      return f
    },
    html: '<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>429</td><td>Rate limited</td></tr></table>',
  },
  {
    id: 'island-with-prose',
    what: 'prose put into a raw HTML island (only leaf-editable)',
    json: (f) => insertTop(f, { type: 'htmlIsland', attrs: { html: '<x-card><h2>Summary</h2><p>Prose users cannot format.</p></x-card>' } }),
    html: '<x-card><h2>Summary</h2><p>Prose users cannot format.</p></x-card>',
  },
  {
    id: 'island-broken-html',
    what: 'island html with an unclosed SVG element',
    json: (f) => insertTop(f, { type: 'htmlIsland', attrs: { html: '<svg viewBox="0 0 10 10"><text x="1" y="5">label</svg>' } }),
    html: '<svg viewBox="0 0 10 10"><text x="1" y="5">label</svg>',
  },
]

export interface MistakeResult {
  id: string
  what: string
  json: JsonVerdict
  html: { worst: string; finding?: Finding }
}

export async function runMistakes(sample = 'samples/spec.html'): Promise<MistakeResult[]> {
  const canon = await canonicalHtml(readFileSync(sample, 'utf8'))
  const jsonText = toJsonFile(loadHtml(canon), true)
  const order = { error: 0, warn: 1, info: 2 } as const
  return MISTAKES.map((m) => {
    const mutated = m.json(JSON.parse(jsonText), jsonText)
    const json = checkJsonText(typeof mutated === 'string' ? mutated : JSON.stringify(mutated, null, 2))
    const html = canon.replace('<h2 id="tasks">', `${m.html}\n<h2 id="tasks">`)
    const fs = checkHtml(html, 'x.html').findings.sort((a, b) => order[a.severity] - order[b.severity])
    // findings that already exist for the unmodified sample don't count
    const baseline = checkHtml(canon, 'x.html').findings.map((f) => f.rule + f.message)
    const fresh = fs.filter((f) => {
      const i = baseline.indexOf(f.rule + f.message)
      if (i >= 0) baseline.splice(i, 1)
      return i < 0
    })
    const f = fresh[0]
    return { id: m.id, what: m.what, json, html: { worst: f ? `${f.severity} ${f.rule}: ${f.message}` : '✓ no findings (parser/schema normalise it silently)', finding: f } }
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2]
  if (file) {
    const v = checkJsonText(readFileSync(file, 'utf8'))
    console.log(`parse:       ${v.parse}\njson schema: ${v.jsonSchema}\nprosemirror: ${v.prosemirror}`)
    process.exit(v.parse.startsWith('✓') && v.jsonSchema.startsWith('✓') && v.prosemirror.startsWith('✓') ? 0 : 1)
  }
  for (const r of await runMistakes()) {
    console.log(`\n## ${r.id}: ${r.what}`)
    console.log(`  JSON  parse:       ${r.json.parse}`)
    console.log(`        json schema: ${r.json.jsonSchema}`)
    console.log(`        prosemirror: ${r.json.prosemirror}`)
    console.log(`  HTML  collab check: ${r.html.worst}`)
  }
}
