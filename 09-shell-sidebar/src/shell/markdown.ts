import MarkdownIt from 'markdown-it'
import { REF } from './journal'

// html: false → raw HTML in a markdown file is escaped, so a file panel cannot inject markup into the shell
const md = new MarkdownIt({ html: false, linkify: true, typographer: false })
// links in a side panel open in a new tab (never navigate the editor away)
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') ?? ''
  if (!href.startsWith('#')) {
    tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noopener noreferrer')
  }
  return defaultLink(tokens, idx, options, env, self)
}

export const renderMarkdown = (src: string) => md.render(src.replace(/<!--[\s\S]*?-->/g, ''))
export const renderInline = (src: string) => md.renderInline(src)

/** wrap known journal ids (D-3, F-12 …) in clickable references; skips code and existing links */
export function linkRefs(html: string, known: Map<string, { summary: string }>): string {
  if (!known.size) return html
  const t = document.createElement('template')
  t.innerHTML = html
  const walker = document.createTreeWalker(t.content, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!(n.parentElement?.closest('code, a, pre'))) texts.push(n as Text)
  for (const node of texts) {
    const s = node.data
    REF.lastIndex = 0
    if (!REF.test(s)) continue
    REF.lastIndex = 0
    const frag = document.createDocumentFragment()
    let last = 0
    for (const m of s.matchAll(REF)) {
      const id = `${m[1]}-${Number(m[2])}`
      if (!known.has(id)) continue
      frag.append(s.slice(last, m.index))
      const a = document.createElement('a')
      a.href = `#${id}`
      a.className = 'jref'
      a.dataset.ref = id
      a.title = `${id}: ${known.get(id)!.summary}`
      a.textContent = m[0]
      frag.append(a)
      last = m.index! + m[0].length
    }
    frag.append(s.slice(last))
    node.replaceWith(frag)
  }
  return t.innerHTML
}

/** scroll `el` into view inside `scroller` only (scrollIntoView would also scroll the window = the document) */
export function scrollWithin(scroller: HTMLElement | null, el: HTMLElement | null, smooth = true) {
  if (!scroller || !el) return
  const sr = scroller.getBoundingClientRect()
  const er = el.getBoundingClientRect()
  const top = scroller.scrollTop + (er.top - sr.top) - Math.min(80, scroller.clientHeight / 4)
  scroller.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' })
}
