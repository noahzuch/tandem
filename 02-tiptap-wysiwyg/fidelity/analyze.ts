// Structural comparison of an input HTML body vs. the HTML that comes out of Tiptap.
// Everything is parsed with jsdom, independent of the converter being measured.
import { JSDOM } from 'jsdom'

export type Status = 'kept' | 'altered' | 'dropped' | 'n/a'
export interface ProbeResult {
  construct: string
  status: Status
  how: string
}

export const parse = (html: string): Document =>
  new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document as unknown as Document

const norm = (s: string | null | undefined) => (s ?? '').replace(/[\s ]+/g, ' ').trim()
// elements inside <label> are Tiptap's own task-item checkbox UI, not content
const all = (d: Document, sel: string) => Array.from(d.body.querySelectorAll(sel)).filter((e) => !e.closest('label'))
const texts = (d: Document, sel: string) => all(d, sel).map((e) => spacedTextOf(e))
const BLOCKS =
  'p,h1,h2,h3,h4,h5,h6,li,div,td,th,tr,pre,blockquote,dt,dd,caption,figcaption,summary,section,article,header,br,svg text,label,button'
/** text of the body with a space at every block boundary (so </h1><h2> does not glue words together) */
function spacedTextOf(el: Element): string {
  const c = el.cloneNode(true) as Element
  for (const e of Array.from(c.querySelectorAll(BLOCKS))) {
    e.before(el.ownerDocument.createTextNode(' '))
    e.after(el.ownerDocument.createTextNode(' '))
  }
  return norm(c.textContent)
}
const spacedText = (d: Document) => spacedTextOf(d.body)
const bodyText = (d: Document) => spacedText(d)

// ---------------------------------------------------------------- probes
type Probe = {
  construct: string
  /** selector that must match in the input for the probe to apply */
  when: string
  run: (inp: Document, out: Document) => [Status, string]
}

/** generic: same elements (by selector) with the same text in output? else: is the text still somewhere? */
function sameElements(construct: string, sel: string, outSel = sel): Probe {
  return {
    construct,
    when: sel,
    run: (inp, out) => {
      const a = texts(inp, sel)
      const b = texts(out, outSel)
      const renamed = sel !== outSel
      if (a.length === b.length && a.every((t, i) => t === b[i]))
        return renamed ? ['altered', `<${sel}> → <${outSel}> (${a.length}×)`] : ['kept', `${a.length}× identical`]
      // multiset subset: every input element's text is found on some output element of that kind
      const pool = [...b]
      const found = a.filter((t) => {
        const i = pool.indexOf(t)
        if (i >= 0) pool.splice(i, 1)
        return i >= 0
      }).length
      if (found === a.length)
        return renamed ? ['altered', `<${sel}> → <${outSel}> (${a.length}×)`] : ['kept', `${a.length}× identical`]
      const ot = bodyText(out)
      const survived = a.filter((t) => t && ot.includes(t)).length
      if (b.length > 0) return ['altered', `${a.length} in → ${b.length} out; text survives ${survived}/${a.length}`]
      return [
        'dropped',
        survived === a.length ? `element gone, text kept (${a.length}×)` : `element gone, text kept ${survived}/${a.length}`,
      ]
    },
  }
}

const withAttr = (sel: string, name: string) =>
  sel
    .split(',')
    .map((s) => `${s.trim()}[${name}]`)
    .join(',')

/** an attribute on elements matched by sel: kept if same value on the same kind of element */
function attr(construct: string, sel: string, name: string, outSel = sel): Probe {
  return {
    construct,
    when: withAttr(sel, name),
    run: (inp, out) => {
      const a = all(inp, withAttr(sel, name)).map((e) => e.getAttribute(name))
      const b = all(out, withAttr(outSel, name)).map((e) => e.getAttribute(name))
      if (b.length === 0) return ['dropped', `${a.length}× ${name}=… gone`]
      const same = a.filter((v) => b.includes(v)).length
      if (same === a.length && a.length === b.length) return ['kept', `${a.length}×`]
      return ['altered', `${a.length} in → ${b.length} out, ${same} with same value; e.g. "${a[0]}" → "${b[0]}"`]
    },
  }
}

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
    run: (inp, out) => {
      const a = all(inp, 'p').length
      const b = all(out, 'p').length
      return a === b ? ['kept', `${a}`] : ['altered', `${a} <p> in → ${b} out (wrappers/divs/li content become <p>)`]
    },
  },
  {
    construct: 'empty paragraph',
    when: 'p:empty',
    run: (inp, out) => (all(out, 'p:empty').length ? ['kept', ''] : ['dropped', '']),
  },
  // --- inline marks
  sameElements('<strong>', 'strong'),
  sameElements('<b>', 'b', 'strong'),
  sameElements('<em>', 'em'),
  sameElements('<i>', 'i', 'em'),
  sameElements('<u>', 'u'),
  sameElements('<s>', 's'),
  sameElements('<del>', 'del', 's'),
  sameElements('<ins>', 'ins', 'u'),
  sameElements('<code> inline', ':not(pre) > code'),
  sameElements('<mark>', 'mark'),
  attr('<mark> color', 'mark', 'data-color'),
  sameElements('<sub>/<sup>', 'sub,sup'),
  sameElements('<small>', 'small'),
  sameElements('<abbr>', 'abbr'),
  sameElements('<kbd>', 'kbd'),
  sameElements('<span>', 'span'),
  sameElements('<font>', 'font'),
  {
    construct: 'nested marks (code inside bold/italic)',
    when: 'strong em code, strong code, em code',
    run: (inp, out) =>
      all(out, 'strong em code, strong code, em code').length
        ? ['kept', '']
        : ['altered', 'code mark excludes all other marks: bold/italic removed from the code span'],
  },
  sameElements('<br>', 'br'),
  {
    construct: 'whitespace runs in text (outside <pre>)',
    when: '*',
    run: (inp, out) => {
      const runs = (d: Document) => {
        const c = d.body.cloneNode(true) as HTMLElement
        c.querySelectorAll('pre').forEach((e) => e.remove())
        return (Array.from(c.querySelectorAll('p,li,h1,h2,h3,td,th')).map((e) => e.textContent ?? '').join('\n').match(/\S[ \t\n]{2,}\S/g) ?? []).length
      }
      const a = runs(inp)
      if (!a) return ['n/a', '']
      const b = runs(out)
      return b === a ? ['kept', ''] : ['altered', `${a} runs of 2+ spaces/newlines inside text collapsed to 1 space (${b} left; renders the same)`]
    },
  },
  {
    construct: 'Typography on load (-- ... (c) "quotes")',
    when: '*',
    run: (inp, out) => {
      const c = inp.body.cloneNode(true) as HTMLElement
      c.querySelectorAll('script,noscript,style,iframe,video,pre').forEach((e) => e.remove())
      const t = norm(c.textContent)
      if (!/--|\.\.\.|\(c\)|"/.test(t)) return ['n/a', '']
      const oc = out.body.cloneNode(true) as HTMLElement
      oc.querySelectorAll('pre').forEach((e) => e.remove())
      const o = norm(oc.textContent)
      const same = ['--', '...', '(c)', '"'].every((x) => t.split(x).length === o.split(x).length)
      return same ? ['kept', 'not converted — Typography only acts on typed input (input rules)'] : ['altered', 'converted on load']
    },
  },
  {
    construct: '&nbsp;',
    when: '*',
    run: (inp, out) => {
      const a = (inp.body.textContent ?? '').split(' ').length - 1
      const b = (out.body.textContent ?? '').split(' ').length - 1
      if (a === 0) return ['n/a', '']
      return a === b ? ['kept', `${a}×`] : ['altered', `${a} → ${b}`]
    },
  },
  // --- links
  attr('link href', 'a', 'href'),
  attr('link title', 'a', 'title'),
  {
    construct: 'link target/rel',
    when: 'a[href]',
    run: (inp, out) => {
      const added = all(out, 'a[target="_blank"]').length - all(inp, 'a[target="_blank"]').length
      return added > 0
        ? ['altered', `target="_blank" rel="noopener noreferrer nofollow" added to ${added} link(s), incl. #anchors`]
        : ['kept', '']
    },
  },
  {
    construct: 'javascript: link',
    when: 'a[href^="javascript:"]',
    run: (inp, out) =>
      all(out, 'a[href^="javascript:"]').length ? ['kept', 'unsafe!'] : ['dropped', 'link removed, text kept (XSS filter)'],
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
    run: (inp, out) => {
      const wrapped = all(out, 'ul:not([data-type]) > li > p:first-child, ol > li > p:first-child').length
      return wrapped ? ['altered', '<li>text</li> → <li><p>text</p></li>'] : ['kept', '']
    },
  },
  {
    construct: 'task list (checked state)',
    when: 'li[data-type="taskItem"]',
    run: (inp, out) => {
      const a = all(inp, 'li[data-type="taskItem"]').map((e) => e.getAttribute('data-checked'))
      const b = all(out, 'li[data-type="taskItem"]').map((e) => e.getAttribute('data-checked'))
      if (!b.length) return ['dropped', '']
      return a.join() === b.join()
        ? ['altered', `states kept (${a.join(',')}); markup expanded to <label><input type=checkbox><span></span></label><div><p>…</p></div>`]
        : ['altered', `states ${a.join(',')} → ${b.join(',')}`]
    },
  },
  {
    construct: 'GitHub-style <li><input type=checkbox>',
    when: 'li > input[type="checkbox"]',
    run: (inp, out) =>
      all(out, 'li[data-type="taskItem"]').length > all(inp, 'li[data-type="taskItem"]').length
        ? ['altered', 'became a task item']
        : ['dropped', 'checkbox gone, becomes a plain bullet'],
  },
  sameElements('<dl>/<dt>/<dd>', 'dt,dd'),
  // --- table
  sameElements('table', 'table', 'table'),
  sameElements('table header cells <th>', 'th'),
  {
    construct: '<thead>/<tbody>/<tfoot>',
    when: 'thead,tfoot',
    run: (inp, out) =>
      all(out, 'thead,tfoot').length
        ? ['kept', '']
        : ['altered', 'sections flattened: all rows in one <tbody>, header row = row of <th>'],
  },
  attr('cell rowspan', 'td,th', 'rowspan'),
  attr('cell colspan', 'td,th', 'colspan'),
  {
    construct: 'table cell content',
    when: 'td,th',
    run: (inp, out) =>
      all(out, 'td > p, th > p').length ? ['altered', 'cell text wrapped in <p>'] : ['kept', ''],
  },
  {
    construct: '<colgroup>/<col> widths',
    when: 'table',
    run: (inp, out) => {
      const a = all(inp, 'col').length
      const b = all(out, 'col').length
      return ['altered', `${a} <col> in → ${b} out; Tiptap emits its own <colgroup> + style="min-width:…" on <table>`]
    },
  },
  {
    construct: '<caption>',
    when: 'caption',
    run: (inp, out) =>
      all(out, 'caption').length
        ? ['kept', '']
        : bodyText(out).includes(norm(inp.querySelector('caption')!.textContent))
          ? ['altered', 'caption text becomes an extra first table ROW (corrupts the table)']
          : ['dropped', ''],
  },
  // --- blocks
  {
    construct: 'code block + language',
    when: 'pre',
    run: (inp, out) => {
      const a = all(inp, 'pre').map((e) => e.textContent)
      const b = all(out, 'pre').map((e) => e.textContent)
      const sameText = a.length === b.length && a.every((t, i) => t === b[i])
      const langIn = all(inp, 'pre code[class]').map((e) => e.className)
      const langOut = all(out, 'pre code[class]').map((e) => e.className)
      const notes = [sameText ? 'code text byte-identical' : 'code text changed']
      if (langIn.length) notes.push(`classes ${langIn.join(' ')} → ${langOut.join(' ') || '(none)'}`)
      if (all(inp, 'pre').some((e) => !e.querySelector('code'))) notes.push('<pre> w/o <code> gets <code> added')
      if (all(inp, 'code[data-language]').length) notes.push('data-language ignored')
      const ok = sameText && langIn.join() === langOut.join() && notes.length <= 2
      return [ok ? 'kept' : 'altered', notes.join('; ')]
    },
  },
  sameElements('blockquote', 'blockquote'),
  sameElements('<hr>', 'hr'),
  {
    construct: 'text-align (inline style)',
    when: 'p[style*="text-align"],td[style*="text-align"]',
    run: (inp, out) => {
      const b = all(out, '[style*="text-align"]').length
      return b ? ['kept', `normalized to style="text-align: center;" (${b}×; via TextAlign / table cell attr)`] : ['dropped', '']
    },
  },
  {
    construct: 'img',
    when: 'img',
    run: (inp, out) => {
      const a = all(inp, 'img')
      const b = all(out, 'img')
      if (!b.length) return ['dropped', `${a.length}× gone (base64 src not allowed by default / inline img not supported)`]
      const lost = ['class', 'data-figure', 'height'].filter((n) => a.some((e) => e.hasAttribute(n)))
      return [
        b.length === a.length && lost.length === 0 ? 'kept' : 'altered',
        `${b.length}/${a.length} kept with src/alt/width/title; dropped attrs: ${lost.join(', ') || '–'}`,
      ]
    },
  },
  {
    construct: 'callout <div class="callout warning">',
    when: 'div.callout',
    run: (inp, out) => {
      const t = norm(inp.querySelector('div.callout')!.textContent)
      return [bodyText(out).includes(t) ? 'altered' : 'dropped', 'div + class + data-kind + id gone → plain <p> (text and inline marks kept)']
    },
  },
  {
    construct: 'inline <svg> diagram',
    when: 'svg',
    run: (inp, out) => {
      if (all(out, 'svg').length) return ['kept', '']
      const labels = all(inp, 'svg text').map((e) => norm(e.textContent))
      return [
        'dropped',
        labels.length
          ? `graphics gone; ${labels.length} <text> labels flattened into a paragraph "${labels.join(' ').slice(0, 40)}…"`
          : 'gone completely',
      ]
    },
  },
  sameElements('<figure>/<figcaption>', 'figcaption'),
  {
    construct: 'two-column grid <div style="display:grid">',
    when: 'div[style*="grid"]',
    run: (inp, out) =>
      all(out, '[style*="grid"]').length
        ? ['kept', '']
        : ['dropped', 'layout gone, columns stacked; inner headings/paragraphs kept'],
  },
  sameElements('<details>/<summary>', 'summary'),
  sameElements('<header>/<section>/<article>', 'header,section,article'),
  sameElements('custom element <x-agent-note>', 'x-agent-note'),
  sameElements('<iframe>/<video>', 'iframe,video'),
  sameElements('<form>/<input>/<button>', 'form'),
  // --- global attributes
  {
    construct: 'class attributes',
    when: '[class]',
    run: (inp, out) => {
      const a = all(inp, '[class]').length
      const b = all(out, '[class]').length
      return [b === 0 ? 'dropped' : 'altered', `${a} → ${b} (only code-block language-* survive)`]
    },
  },
  {
    construct: 'id attributes',
    when: '[id]',
    run: (inp, out) => [all(out, '[id]').length ? 'altered' : 'dropped', `${all(inp, '[id]').length} → ${all(out, '[id]').length} (in-doc #anchor links now dangle)`],
  },
  {
    construct: 'data-* attributes (non-Tiptap)',
    when: '*',
    run: (inp, out) => {
      const count = (d: Document) =>
        all(d, '*').reduce(
          (n, e) =>
            n + Array.from(e.attributes).filter((x) => x.name.startsWith('data-') && !['data-type', 'data-checked', 'data-color'].includes(x.name)).length,
          0,
        )
      const a = count(inp)
      if (!a) return ['n/a', '']
      return [count(out) ? 'altered' : 'dropped', `${a} → ${count(out)}`]
    },
  },
  {
    construct: 'inline style attributes',
    when: '[style]',
    run: (inp, out) => {
      const a = all(inp, '[style]').map((e) => e.getAttribute('style'))
      const b = all(out, '[style]').map((e) => e.getAttribute('style'))
      return ['altered', `${a.length} → ${b.length}; only text-align / mark color survive, Tiptap adds min-width styles on tables`]
    },
  },
  {
    construct: 'other attrs (title/dir/lang on blocks)',
    when: 'p[title],p[dir],p[lang]',
    run: (inp, out) => (all(out, 'p[title],p[dir],p[lang]').length ? ['kept', ''] : ['dropped', '']),
  },
]

export function probe(inputBody: string, outputBody: string): ProbeResult[] {
  const inp = parse(inputBody)
  const out = parse(outputBody)
  const res: ProbeResult[] = []
  for (const p of probes) {
    if (!inp.body.querySelector(p.when)) continue
    const [status, how] = p.run(inp, out)
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
  const words = (h: string) => spacedText(parse(h)).split(' ').filter(Boolean)
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
