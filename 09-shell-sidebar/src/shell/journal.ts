// Parser for the brainstorm skill's Decision Journal (decisions.md). Shared by the browser (entry list, spec refs)
// and the server (activity log: "decisions.md: +D-9 …").
//
// The format (brainstorm plugin, templates/decisions-template.md, and real journals in docs/brainstorm/*/decisions.md):
//
//   # Decision Journal — <topic>
//   ## Journal                       (real journals: one chronological section; the template has one section per type)
//   F-1: [verified] <fact> (Source: …)
//        Erratum: …                  (indented continuation lines belong to the entry)
//   D-1: [accepted] **<summary>**
//        - Evaluated: … / - Rejected (b): … / - Chosen because: …
//   Q-1: [assumption] <question>
//       - Current assumption: … / - Impact if wrong: … / - Resolved: …
//   ## Rejected Approaches
//   - **<name>**: <why rejected, what would have to change>      (no ids → synthesized R-1, R-2, …)
//
// HTML comments (the template's instructions) are ignored.

export type EntryType = 'fact' | 'decision' | 'question' | 'rejected'
export interface JournalEntry {
  id: string // "D-3"
  type: EntryType
  num: number
  /** normalised: verified | assumed | refuted | accepted | superseded | assumption | resolved | rejected | … */
  status: string
  /** raw status text, e.g. "superseded-by D-7" */
  statusText: string
  /** one line for lists / tooltips (the bold part of a decision, else the first sentence) */
  summary: string
  /** the entry as markdown (first line without the "D-3: [status]" prefix + continuation lines, dedented) */
  body: string
  /** 1-based line in the file */
  line: number
  /** ids this entry mentions (F-2, D-1 …), excluding itself */
  refs: string[]
}

export const TYPE_OF: Record<string, EntryType> = { F: 'fact', D: 'decision', Q: 'question', R: 'rejected' }
export const TYPE_LABEL: Record<EntryType, string> = { fact: 'Facts', decision: 'Decisions', rejected: 'Rejected', question: 'Open questions' }

const ENTRY = /^\s{0,3}(?:[-*]\s+)?\**([FDQ])-(\d+)\**\s*:\s*(?:\[([^\]]+)\])?\s*(.*)$/
const HEADING = /^#{1,6}\s+(.*)$/
/** an id mention in prose: D-3, F-12, Q-2, R-1 (also "D3" is NOT matched: too many false positives like "H2", "P3") */
export const REF = /\b([FDQR])-(\d{1,4})\b/g

/** blank out HTML comments but keep the line structure (line numbers stay right) */
function stripComments(md: string) {
  return md.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''))
}

function normStatus(type: EntryType, raw: string, body: string): string {
  const s = raw.trim().toLowerCase()
  if (type === 'question' && /^\s*-\s*resolved\b/im.test(body)) return 'resolved'
  if (s.startsWith('superseded')) return 'superseded'
  if (s.startsWith('refuted')) return 'refuted'
  if (/^(resolved|closed|moot)/.test(s)) return 'resolved'
  if (s.startsWith('accepted')) return 'accepted' // "accepted, partially superseded-by D-61" (statusText keeps the rest)
  return s || (type === 'rejected' ? 'rejected' : '')
}

function summarize(type: EntryType, first: string): string {
  const bold = /\*\*(.+?)\*\*/.exec(first)
  if (bold && (type === 'decision' || type === 'rejected' || first.trim().startsWith('**'))) return bold[1].replace(/[.:]$/, '')
  const plain = first.replace(/\*\*|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
  const m = /^(.{20,}?[.?!])(\s|$)/.exec(plain)
  const s = m ? m[1] : plain
  return s.length > 160 ? s.slice(0, 157) + '…' : s
}

function dedent(lines: string[]): string {
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length), 99)
  return lines.map((l) => l.slice(Math.min(ind, /^\s*/.exec(l)![0].length))).join('\n')
}

export function parseJournal(markdown: string): { title: string; entries: JournalEntry[] } {
  const lines = stripComments(markdown).split('\n')
  const entries: JournalEntry[] = []
  let title = ''
  let section = ''
  let cur: { e: JournalEntry; first: string; rest: string[] } | null = null
  let rejectedN = 0
  let blank = false

  const close = () => {
    if (!cur) return
    while (cur.rest.length && !cur.rest.at(-1)!.trim()) cur.rest.pop()
    const rest = cur.rest.length ? dedent(cur.rest) : ''
    const e = cur.e
    e.body = [cur.first, rest].filter(Boolean).join('\n')
    e.status = normStatus(e.type, e.statusText, e.body)
    // a wrapped first paragraph continues on the next lines until a bullet or a blank line
    const para = [cur.first]
    for (const l of cur.rest) {
      if (!l.trim() || /^\s*[-*]\s/.test(l)) break
      para.push(l.trim())
    }
    e.summary = summarize(e.type, para.join(' '))
    e.refs = [...new Set([...e.body.matchAll(REF)].map((m) => `${m[1]}-${m[2]}`))].filter((r) => r !== e.id)
    entries.push(e)
    cur = null
  }

  lines.forEach((line, i) => {
    const h = HEADING.exec(line)
    if (h) {
      close()
      if (/^#\s/.test(line) && !title) title = h[1].trim()
      section = h[1].trim().toLowerCase()
      blank = false
      return
    }
    const m = ENTRY.exec(line)
    if (m) {
      close()
      const type = TYPE_OF[m[1]]
      cur = { e: { id: `${m[1]}-${Number(m[2])}`, type, num: Number(m[2]), status: '', statusText: m[3] ?? '', summary: '', body: '', line: i + 1, refs: [] }, first: m[4], rest: [] }
      blank = false
      return
    }
    // "## Rejected Approaches": every top-level bullet is an entry
    const rej = /rejected/.test(section) ? /^[-*]\s+(.*)$/.exec(line) : null
    if (rej) {
      close()
      rejectedN++
      cur = { e: { id: `R-${rejectedN}`, type: 'rejected', num: rejectedN, status: 'rejected', statusText: 'rejected', summary: '', body: '', line: i + 1, refs: [] }, first: rej[1], rest: [] }
      blank = false
      return
    }
    if (!cur) return
    if (!line.trim()) {
      blank = true
      cur.rest.push('')
      return
    }
    // after a blank line, only an indented line continues the entry
    if (blank && !/^\s/.test(line)) return close()
    blank = false
    cur.rest.push(line)
  })
  close()
  return { title, entries }
}

/** journal file changed: which entries are new, which changed (for the activity log and the "fresh" highlight) */
export function diffEntries(before: JournalEntry[], after: JournalEntry[]) {
  const old = new Map(before.map((e) => [e.id, e]))
  const added = after.filter((e) => !old.has(e.id))
  const changed = after.filter((e) => old.has(e.id) && (old.get(e.id)!.body !== e.body || old.get(e.id)!.statusText !== e.statusText))
  return { added, changed }
}
