// Structural comparison of an input HTML body vs. the HTML that comes out of Tiptap.
// Everything is parsed with jsdom, independent of the converter being measured.
// Spike 04: four outcomes per construct —
//   kept        same element, attributes and text (islands: same source bytes)
//   normalised  markup differs, rendering + meaning identical, documented as harmless (e.g. <b>→<strong>,
//               <li>text → <li><p>text, thead flattened, Tiptap's own <colgroup>), or removed BY POLICY
//               (javascript: links)
//   altered     content survives in a lossy form (attributes/structure lost)
//   dropped     element gone
import { JSDOM } from 'jsdom'
import { prepareForEditor } from '../src/islands/source.ts'
import { unescapeAttr } from '../src/islands/raw.ts'

export type Status = 'kept' | 'normalised' | 'altered' | 'dropped' | 'n/a'
export interface ProbeResult {
  construct: string
  status: Status
  how: string
}

export const parse = (html: string): Document =>
  new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document as unknown as Document

const norm = (s: string | null | undefined) => (s ?? '').replace(/[\s ]+/g, ' ').trim()
// elements inside <label> are Tiptap's own task-item checkbox UI, not content
const all = (d: Document, sel: string) =>
  Array.from(d.body.querySelectorAll(sel)).filter((e) => !e.closest('li[data-type="taskItem"] > label'))
const texts = (d: Document, sel: string) => all(d, sel).map((e) => spacedTextOf(e))
const BLOCKS =
  'p,h1,h2,h3,h4,h5,h6,li,div,td,th,tr,pre,blockquote,dt,dd,caption,figcaption,summary,section,article,header,br,svg text,label,button,script,noscript,style,iframe,video,form,dl,figure,svg,x-agent-note'
/** text of the body with a space at every block boundary (so </h1><h2> does not glue words together) */
function spacedTextOf(el: Element): string {
  const c = el.cloneNode(true) as Element
  for (const e of Array.from(c.querySelectorAll(BLOCKS))) {
    e.before(el.ownerDocument.createTextNode(' '))
    e.after(el.ownerDocument.createTextNode(' '))
  }
  return norm(c.textContent)
}
const bodyText = (d: Document) => spacedTextOf(d.body)

// ---------------------------------------------------------------- probes
interface Ctx {
  inp: Document
  out: Document
  inHtml: string
  outHtml: string
}
type Probe = {
  construct: string
  /** selector that must match in the input for the probe to apply */
  when: string
  run: (c: Ctx) => [Status, string]
}

/** generic: same elements (by selector) with the same text in output? (renamed = normalised) */
function sameElements(construct: string, sel: string, outSel = sel): Probe {
  return {
    construct,
    when: sel,
    run: ({ inp, out }) => {
      const a = texts(inp, sel)
      const b = texts(out, outSel)
      const renamed = sel !== outSel
      const pool = [...b]
      const found = a.filter((t) => {
        const i = pool.indexOf(t)
        if (i >= 0) pool.splice(i, 1)
        return i >= 0
      }).length
      if (found === a.length)
        return renamed ? ['normalised', `<${sel}> → <${outSel}> (${a.length}×, same rendering)`] : ['kept', `${a.length}× identical`]
      const ot = bodyText(out)
      const survived = a.filter((t) => t && ot.includes(t)).length
      if (b.length > 0) return ['altered', `${a.length} in → ${b.length} out; text survives ${survived}/${a.length}`]
      return ['dropped', survived === a.length ? `element gone, text kept (${a.length}×)` : `element gone, text kept ${survived}/${a.length}`]
    },
  }
}

const withAttr = (sel: string, name: string) =>
  sel
    .split(',')
    .map((s) => `${s.trim()}[${name}]`)
    .join(',')

/** an attribute on elements matched by sel: kept if same values on the same kind of element */
function attr(construct: string, sel: string, name: string, outSel = sel): Probe {
  return {
    construct,
    when: withAttr(sel, name),
    run: ({ inp, out }) => {
      const a = all(inp, withAttr(sel, name)).map((e) => e.getAttribute(name))
      const b = all(out, withAttr(outSel, name)).map((e) => e.getAttribute(name))
      if (b.length === 0) return ['dropped', `${a.length}× ${name}=… gone`]
      const same = a.filter((v) => b.includes(v)).length
      if (same === a.length) return ['kept', `${a.length}×`]
      return ['altered', `${a.length} in → ${b.length} out, ${same} with same value; e.g. "${a[0]}" → "${b[0]}"`]
    },
  }
}

/** the element's exact source (from the input string) appears verbatim in the output string */
function verbatim(construct: string, sel: string): Probe {
  return {
    construct,
    when: sel,
    run: ({ inp, out, inHtml, outHtml }) => {
      const sources = islandSources(inHtml)
      const els = all(inp, sel)
      // the source of each element = the island source that contains an element of this kind
      const want = sources.filter((s) => parse(s).body.querySelector(sel))
      const exact = want.filter((s) => outHtml.includes(s)).length
      if (want.length && exact === want.length && want.length >= els.filter((e) => !e.parentElement?.closest(sel)).length)
        return ['kept', `${exact}× byte-identical source (raw HTML island)`]
      if (all(out, sel).length >= els.length) return ['altered', `element present, source not byte-identical (${exact}/${want.length})`]
      const t = norm(els.map((e) => e.textContent).join(' '))
      return ['dropped', t && bodyText(out).includes(t.slice(0, 30)) ? 'element gone, text flattened into paragraphs' : 'gone completely']
    },
  }
}

/** island sources per prepareForEditor (exact input slices) */
export function islandSources(inHtml: string): string[] {
  const { html } = prepareForEditor(inHtml)
  return Array.from(html.matchAll(/data-raw-island="([^"]*)"/g)).map((m) => unescapeAttr(m[1]))
}

const styleDecls = (s: string | null) =>
  (s ?? '')
    .split(';')
    .map((d) => d.trim().replace(/\s*:\s*/, ':').toLowerCase())
    .filter(Boolean)

const probes: Probe[] = [
  // --- text structure
  sameElements('h1', 'h1'),
  sameElements('h2', 'h2'),
  sameElements('h3', 'h3'),
  sameElements('h4–h6', 'h4,h5,h6'),
  attr('heading ids', 'h1,h2,h3', 'id'),
  {
    construct: 'paragraphs',
    when: 'p',
    run: ({ inp, out }) => {
      const a = texts(inp, 'p')
      const b = texts(out, 'p')
      if (a.length === b.length) return ['kept', `${a.length}`]
      const allThere = a.every((t) => b.includes(t))
      return allThere
        ? ['normalised', `${a.length} <p> in → ${b.length} out: loose inline content (in li/td/callout/div/blockquote) gets wrapped in <p>`]
        : ['altered', `${a.length} <p> in → ${b.length} out, some paragraph texts changed`]
    },
  },
  {
    construct: 'empty paragraph',
    when: 'p:empty',
    run: ({ out }) => (all(out, 'p:empty').length ? ['kept', ''] : ['dropped', '']),
  },
  // --- inline marks
  sameElements('<strong>', 'strong'),
  sameElements('<b>', 'b', 'strong'),
  sameElements('<em>', 'em'),
  sameElements('<i>', 'i', 'em'),
  sameElements('<u>', 'u'),
  sameElements('<s>', 's'),
  sameElements('<del>', 'del', 's'),
  sameElements('<ins>', 'ins'),
  sameElements('<code> inline', ':not(pre) > code'),
  sameElements('<mark>', 'mark'),
  attr('<mark> color', 'mark', 'data-color'),
  sameElements('<sub>/<sup>', 'sub,sup'),
  sameElements('<small>', 'small'),
  sameElements('<abbr>', 'abbr'),
  attr('<abbr title>', 'abbr', 'title'),
  sameElements('<kbd>', 'kbd'),
  sameElements('<span>', 'span'),
  {
    construct: 'text colour (span style=color)',
    when: 'span[style*="color"]',
    run: ({ inp, out }) => {
      const a = all(inp, 'span[style*="color"]').length
      const b = all(out, 'span[style*="color"]').length
      return b >= a ? ['normalised', `${a}× kept via TextStyle/Color/BackgroundColor; colour value may be normalised (#c00 → rgb(204, 0, 0))`] : ['dropped', '']
    },
  },
  sameElements('<font>', 'font'),
  {
    construct: 'nested marks (code inside bold/italic)',
    when: 'strong em code, strong code, em code',
    run: ({ out }) =>
      all(out, 'strong em code, strong code, em code').length
        ? ['kept', '']
        : ['altered', 'code mark excludes all other marks: bold/italic removed from the code span'],
  },
  sameElements('<br>', 'br'),
  {
    construct: 'whitespace runs in text (outside <pre>)',
    when: '*',
    run: ({ inp, out }) => {
      const runs = (d: Document) => {
        const c = d.body.cloneNode(true) as HTMLElement
        c.querySelectorAll('pre').forEach((e) => e.remove())
        return (Array.from(c.querySelectorAll('p,li,h1,h2,h3,td,th')).map((e) => e.textContent ?? '').join('\n').match(/\S[ \t\n]{2,}\S/g) ?? []).length
      }
      const a = runs(inp)
      if (!a) return ['n/a', '']
      const b = runs(out)
      return b === a ? ['kept', ''] : ['normalised', `${a} runs of 2+ spaces/newlines inside text collapsed to 1 space (${b} left; renders the same)`]
    },
  },
  {
    construct: 'Typography on load (-- ... (c) "quotes")',
    when: '*',
    run: ({ inp, out }) => {
      const c = inp.body.cloneNode(true) as HTMLElement
      c.querySelectorAll('script,noscript,style,iframe,video,pre,form').forEach((e) => e.remove())
      const t = norm(c.textContent)
      if (!/--|\.\.\.|\(c\)|"/.test(t)) return ['n/a', '']
      const oc = out.body.cloneNode(true) as HTMLElement
      oc.querySelectorAll('script,noscript,style,iframe,video,pre,form').forEach((e) => e.remove())
      const o = norm(oc.textContent)
      const same = ['--', '...', '(c)'].every((x) => t.split(x).length === o.split(x).length)
      return same ? ['kept', 'not converted — Typography only acts on typed input (input rules)'] : ['altered', 'converted on load']
    },
  },
  {
    construct: '&nbsp;',
    when: '*',
    run: ({ inp, out }) => {
      const a = (inp.body.textContent ?? '').split(' ').length - 1
      const b = (out.body.textContent ?? '').split(' ').length - 1
      if (a === 0) return ['n/a', '']
      return a === b ? ['kept', `${a}×`] : ['altered', `${a} → ${b}`]
    },
  },
  // --- links
  attr('link href (except javascript:)', 'a:not([href^="javascript:"])', 'href'),
  attr('link title', 'a', 'title'),
  {
    construct: 'link target/rel',
    when: 'a[href]',
    run: ({ inp, out }) => {
      const sig = (d: Document) => all(d, 'a[href]').map((e) => `${e.getAttribute('target') ?? '-'}|${e.getAttribute('rel') ?? '-'}`).sort().join(',')
      const added = all(out, 'a[target="_blank"]').length - all(inp, 'a[target="_blank"]').length
      if (added > 0) return ['altered', `target="_blank" rel="noopener noreferrer nofollow" added to ${added} link(s), incl. #anchors`]
      return sig(inp) === sig(out) || all(out, 'a[href]').length < all(inp, 'a[href]').length ? ['kept', 'as in the source (none added)'] : ['altered', `${sig(inp)} → ${sig(out)}`]
    },
  },
  {
    construct: 'javascript: link',
    when: 'a[href^="javascript:"]',
    run: ({ out }) =>
      all(out, 'a[href^="javascript:"]').length ? ['altered', 'kept — unsafe!'] : ['normalised', 'removed by policy (XSS), text kept'],
  },
  // --- lists
  sameElements('bullet list items', 'ul:not([data-type]) > li', 'ul:not([data-type]) > li'),
  sameElements('nested bullet list', 'ul ul:not([data-type]) > li'),
  sameElements('numbered list items', 'ol > li'),
  sameElements('nested numbered list', 'ol ol > li, li ol > li'),
  attr('<ol type>', 'ol', 'type'),
  attr('<ol start>', 'ol', 'start'),
  attr('<ol reversed>', 'ol', 'reversed'),
  {
    construct: 'list item markup',
    when: 'li',
    run: ({ out }) => {
      const wrapped = all(out, 'ul:not([data-type]) > li > p:first-child, ol > li > p:first-child').length
      return wrapped ? ['normalised', '<li>text</li> → <li><p>text</p></li> (same rendering with li > p { margin: 0 })'] : ['kept', '']
    },
  },
  {
    construct: 'task list (checked state)',
    when: 'li[data-type="taskItem"]',
    run: ({ inp, out }) => {
      const a = all(inp, 'li[data-type="taskItem"]').map((e) => e.getAttribute('data-checked'))
      const b = all(out, 'li[data-type="taskItem"]').map((e) => e.getAttribute('data-checked'))
      if (!b.length) return ['dropped', '']
      return a.join() === b.join()
        ? ['normalised', `states kept (${a.join(',')}); markup expanded to <label><input type=checkbox><span></span></label><div><p>…</p></div>`]
        : ['altered', `states ${a.join(',')} → ${b.join(',')}`]
    },
  },
  {
    construct: 'GitHub-style <li><input type=checkbox>',
    when: 'li > input[type="checkbox"]',
    run: ({ inp, out }) => {
      const a = all(inp, 'li > input[type="checkbox"]').map((e) => e.hasAttribute('checked'))
      const b = all(out, 'li input[type="checkbox"]').filter((e) => !e.closest('li[data-type="taskItem"]')).map((e) => e.hasAttribute('checked'))
      if (b.length === a.length && a.join() === b.join()) return ['normalised', 'checkbox kept as inline island; now inside <li><p> (renders the same)']
      return ['dropped', 'checkbox gone, becomes a plain bullet']
    },
  },
  sameElements('<dl>/<dt>/<dd>', 'dt,dd'),
  // --- table
  sameElements('table', 'table', 'table'),
  sameElements('table header cells <th>', 'th'),
  {
    construct: '<thead>/<tbody>/<tfoot>',
    when: 'thead,tfoot',
    run: ({ inp, out }) =>
      all(out, 'thead,tfoot').length === all(inp, 'thead,tfoot').length
        ? ['kept', '']
        : ['normalised', 'sections flattened: all rows in one <tbody>, header row = row of <th> (renders the same)'],
  },
  attr('cell rowspan', 'td,th', 'rowspan'),
  attr('cell colspan', 'td,th', 'colspan'),
  attr('cell scope', 'td,th', 'scope'),
  {
    construct: 'table cell content',
    when: 'td,th',
    run: ({ inp, out }) =>
      all(out, 'td > p, th > p').length > all(inp, 'td > p, th > p').length ? ['normalised', 'cell text wrapped in <p>'] : ['kept', ''],
  },
  {
    construct: '<colgroup>/<col> widths',
    when: 'table',
    run: ({ inp, out }) => {
      const a = all(inp, 'col').map((e) => e.getAttribute('style') ?? '')
      const b = all(out, 'col').map((e) => e.getAttribute('style') ?? '')
      const authored = a.filter(Boolean)
      if (authored.length && !authored.every((s) => b.includes(s))) return ['altered', `authored <col> widths lost (${authored.join(', ')})`]
      return b.length > a.length
        ? ['normalised', `${a.length} <col> in → ${b.length} out; Tiptap adds its own <colgroup> + min-width styles (renders the same)`]
        : ['kept', '']
    },
  },
  {
    construct: '<caption>',
    when: 'caption',
    run: ({ inp, out }) =>
      all(out, 'caption').length
        ? ['kept', 'table with caption is kept as a raw HTML island']
        : bodyText(out).includes(norm(inp.querySelector('caption')!.textContent))
          ? ['altered', 'caption text becomes an extra first table ROW (corrupts the table)']
          : ['dropped', ''],
  },
  // --- blocks
  {
    construct: 'code block + language',
    when: 'pre',
    run: ({ inp, out }) => {
      const a = all(inp, 'pre').map((e) => e.textContent)
      const b = all(out, 'pre').map((e) => e.textContent)
      const sameText = a.length === b.length && a.every((t, i) => t === b[i])
      const sig = (d: Document) =>
        all(d, 'pre code')
          .map((e) => `${e.className}|${e.getAttribute('data-language') ?? ''}`)
          .filter((s) => s !== '|')
          .join(',')
      const notes = [sameText ? 'code text byte-identical' : 'code text changed']
      const attrsSame = sig(inp) === sig(out)
      notes.push(attrsSame ? 'code classes/data-language kept' : `code attrs ${sig(inp)} → ${sig(out)}`)
      const added = all(inp, 'pre').some((e) => !e.querySelector('code'))
      if (added) notes.push('<pre> w/o <code> gets <code> added')
      if (!sameText) return ['altered', notes.join('; ')]
      return [!attrsSame ? 'altered' : added ? 'normalised' : 'kept', notes.join('; ')]
    },
  },
  sameElements('blockquote', 'blockquote'),
  attr('blockquote cite', 'blockquote', 'cite'),
  sameElements('<hr>', 'hr'),
  {
    construct: 'text-align (inline style)',
    when: 'p[style*="text-align"],td[style*="text-align"]',
    run: ({ inp, out }) => {
      const a = all(inp, '[style*="text-align"]').length
      const b = all(out, '[style*="text-align"]').length
      return b >= a ? ['normalised', `${b}× kept, written as style="text-align: center;" (TextAlign / cell align attr)`] : ['dropped', '']
    },
  },
  {
    construct: 'img',
    when: 'img',
    run: ({ inp, out }) => {
      const a = all(inp, 'img')
      const b = all(out, 'img')
      if (!b.length) return ['dropped', `${a.length}× gone (base64 src not allowed by default / inline img not supported)`]
      const lost = a.flatMap((e) => Array.from(e.attributes).filter((x) => !b.some((o) => o.getAttribute(x.name) === x.value)).map((x) => x.name))
      if (b.length < a.length || lost.length) return ['altered', `${b.length}/${a.length} kept; dropped attrs: ${[...new Set(lost)].join(', ') || '–'}`]
      const wrapped = b.filter((e) => e.parentElement?.localName === 'p').length > a.filter((e) => e.parentElement?.localName === 'p').length
      return wrapped ? ['normalised', `${b.length}× all attributes kept; a top-level <img> is wrapped in <p> (Image is inline now)`] : ['kept', `${b.length}× all attributes kept`]
    },
  },
  {
    construct: 'callout <div class="callout warning">',
    when: 'div.callout',
    run: ({ inp, out }) => {
      const a = inp.querySelector('div.callout')!
      const b = out.querySelector('div.callout')
      if (!b) return [bodyText(out).includes(norm(a.textContent)) ? 'altered' : 'dropped', 'div + class + data-kind + id gone → plain <p>']
      const attrsSame = Array.from(a.attributes).every((x) => b.getAttribute(x.name) === x.value)
      if (!attrsSame || norm(a.textContent) !== norm(b.textContent)) return ['altered', 'callout present but attributes/text differ']
      return b.querySelector(':scope > p') && !a.querySelector(':scope > p')
        ? ['normalised', 'editable callout node, all attributes kept; its loose inline content is wrapped in <p>']
        : ['kept', 'editable callout node, all attributes kept']
    },
  },
  verbatim('inline <svg>', 'svg'),
  verbatim('<figure>/<figcaption>', 'figure'),
  {
    construct: 'two-column grid <div style="display:grid">',
    when: 'div[style*="grid"]',
    run: ({ inp, out }) => {
      const a = inp.querySelector('div[style*="grid"]')!
      const b = out.querySelector('div[style*="grid"]')
      if (!b) return ['dropped', 'layout gone, columns stacked; inner headings/paragraphs kept']
      const same = styleDecls(a.getAttribute('style')).join(';') === styleDecls(b.getAttribute('style')).join(';') && a.className === b.className
      return same
        ? [b.children.length === a.children.length ? 'kept' : 'altered', `editable container (div > div > h3,p), style + class kept${a.getAttribute('style') !== b.getAttribute('style') ? ' (style re-serialised: "display:grid" → "display: grid")' : ''}`]
        : ['altered', 'style/class differ']
    },
  },
  {
    construct: '<details>/<summary>',
    when: 'details',
    run: ({ inp, out }) => {
      const a = all(inp, 'details').map((e) => `${e.hasAttribute('open')}|${norm(e.querySelector('summary')?.textContent)}`)
      const b = all(out, 'details').map((e) => `${e.hasAttribute('open')}|${norm(e.querySelector('summary')?.textContent)}`)
      return a.join() === b.join() ? ['kept', `${a.length}× editable details node, open state + summary kept`] : b.length ? ['altered', `${a.join()} → ${b.join()}`] : ['dropped', 'element gone, text kept as <p>s']
    },
  },
  sameElements('<header>/<section>/<article>', 'header,section,article'),
  verbatim('custom element <x-agent-note>', 'x-agent-note'),
  verbatim('<iframe>/<video>', 'iframe,video'),
  verbatim('<form>/<input>/<button>', 'form'),
  verbatim('<dl>', 'dl'),
  verbatim('<script> in body', 'script'),
  verbatim('<noscript>', 'noscript'),
  {
    construct: 'HTML comments in body',
    when: '*',
    run: ({ inHtml, outHtml }) => {
      const a = (inHtml.match(/<!--[\s\S]*?-->/g) ?? [])
      if (!a.length) return ['n/a', '']
      const kept = a.filter((c) => outHtml.includes(c)).length
      return kept === a.length ? ['kept', `${a.length}× byte-identical (comment islands)`] : kept ? ['altered', `${kept}/${a.length} kept`] : ['dropped', `${a.length}× gone`]
    },
  },
  // --- global attributes
  {
    construct: 'class attributes',
    when: '[class]',
    run: ({ inp, out }) => {
      const a = all(inp, '[class]').map((e) => e.getAttribute('class'))
      const b = all(out, '[class]').map((e) => e.getAttribute('class'))
      const kept = a.filter((v) => b.includes(v)).length
      return kept === a.length ? ['kept', `${a.length} → ${b.length}`] : [b.length ? 'altered' : 'dropped', `${a.length} → ${b.length}, ${kept} identical`]
    },
  },
  {
    construct: 'id attributes',
    when: '[id]',
    run: ({ inp, out }) => {
      const a = all(inp, '[id]').map((e) => e.id)
      const b = new Set(all(out, '[id]').map((e) => e.id))
      const missing = a.filter((x) => !b.has(x))
      return missing.length === 0 ? ['kept', `${a.length} → ${b.size} (#anchor links keep working)`] : [b.size ? 'altered' : 'dropped', `${a.length} → ${b.size}; missing: ${missing.join(', ')}`]
    },
  },
  {
    construct: 'data-* attributes (non-Tiptap)',
    when: '*',
    run: ({ inp, out }) => {
      const list = (d: Document) =>
        all(d, '*').flatMap((e) =>
          Array.from(e.attributes)
            .filter((x) => x.name.startsWith('data-') && !['data-type', 'data-checked', 'data-color', 'data-raw-island'].includes(x.name))
            .map((x) => `${x.name}=${x.value}`),
        )
      const a = list(inp)
      if (!a.length) return ['n/a', '']
      const b = list(out)
      const kept = a.filter((x) => b.includes(x)).length
      return kept === a.length ? ['kept', `${a.length} → ${b.length}`] : [b.length ? 'altered' : 'dropped', `${a.length} → ${b.length}, ${kept} identical`]
    },
  },
  {
    construct: 'inline style attributes',
    when: '[style]',
    run: ({ inp, out }) => {
      const a = all(inp, '[style]').flatMap((e) => styleDecls(e.getAttribute('style')))
      const b = all(out, '[style]').flatMap((e) => styleDecls(e.getAttribute('style')))
      const missing = a.filter((d) => !b.includes(d) && !/color/.test(d))
      if (missing.length) return ['altered', `${a.length} declarations in, ${missing.length} lost: ${missing.slice(0, 4).join('; ')}`]
      return ['normalised', `all ${a.length} declarations kept (spacing/colour format normalised); Tiptap adds min-width on tables/cols`]
    },
  },
  {
    construct: 'other attrs (title/dir/lang on blocks)',
    when: 'p[title],p[dir],p[lang]',
    run: ({ out }) => (all(out, 'p[title][dir][lang]').length ? ['kept', ''] : ['dropped', '']),
  },
]

export function probe(inputBody: string, outputBody: string): ProbeResult[] {
  const inp = parse(inputBody)
  const out = parse(outputBody)
  const ctx: Ctx = { inp, out, inHtml: inputBody, outHtml: outputBody }
  const res: ProbeResult[] = []
  for (const p of probes) {
    if (!inp.body.querySelector(p.when)) continue
    const [status, how] = p.run(ctx)
    if (status === 'n/a') continue
    res.push({ construct: p.construct, status, how })
  }
  return res
}

// ---------------------------------------------------------------- comments, text, census
export function countComments(html: string): number {
  return (html.match(/<!--[\s\S]*?-->/g) ?? []).length
}

/** words of the input text that are missing in the output (multiset difference) */
export function lostWords(inputBody: string, outputBody: string): { total: number; lost: string[] } {
  const words = (h: string) => bodyText(parse(h)).split(' ').filter(Boolean)
  const a = words(inputBody)
  const bag = new Map<string, number>()
  for (const w of words(outputBody)) bag.set(w, (bag.get(w) ?? 0) + 1)
  const lost: string[] = []
  for (const w of a) {
    const n = bag.get(w) ?? 0
    if (n > 0) bag.set(w, n - 1)
    else lost.push(w)
  }
  return { total: a.length, lost }
}

/** per tag: count in input vs output */
export function tagCensus(inputBody: string, outputBody: string): { tag: string; inp: number; out: number }[] {
  const count = (h: string) => {
    const m = new Map<string, number>()
    for (const e of all(parse(h), '*')) m.set(e.localName, (m.get(e.localName) ?? 0) + 1)
    return m
  }
  const a = count(inputBody)
  const b = count(outputBody)
  const tags = [...new Set([...a.keys(), ...b.keys()])].sort()
  return tags.map((tag) => ({ tag, inp: a.get(tag) ?? 0, out: b.get(tag) ?? 0 }))
}

export function attrCensus(html: string): number {
  return all(parse(html), '*').reduce((n, e) => n + e.attributes.length, 0)
}
