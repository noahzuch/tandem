// Measurements on before/after texts: the minimal Edit-tool call an agent must emit, token estimate,
// "error-proneness" proxies, and unified-diff size.
import { applyPatch, createTwoFilesPatch, structuredPatch } from 'diff'
import { getEncoding } from 'js-tiktoken'

const enc = getEncoding('cl100k_base') // proxy only — Claude's tokenizer differs, ratios are what matter

export const tokens = (s: string) => enc.encode(s).length

export interface MinimalEdit {
  old: string
  new: string
  /** chars the agent must emit for a str_replace-style edit (old + new) */
  emitChars: number
  emitTokens: number
  /** number of Edit calls (1 = one contiguous replacement) */
  calls?: number
}

/** Cheapest way for an agent to make the change with str_replace edits: one contiguous replacement,
 *  or one replacement per changed hunk (whichever emits fewer chars). */
export function agentEdit(before: string, after: string): MinimalEdit {
  const single = { ...minimalEdit(before, after), calls: 1 }
  const { hunks } = structuredPatch('a', 'b', before, after, '', '', { context: 0 })
  if (hunks.length < 2) return single
  const parts = hunks.map((h) => {
    const only = applyPatch(before, { oldFileName: 'a', newFileName: 'b', oldHeader: '', newHeader: '', hunks: [h] })
    if (only === false) throw new Error('hunk does not apply')
    return minimalEdit(before, only)
  })
  const multi: MinimalEdit = {
    old: parts.map((p) => p.old).join('\n--- next edit ---\n'),
    new: parts.map((p) => p.new).join('\n--- next edit ---\n'),
    emitChars: parts.reduce((s, p) => s + p.emitChars, 0),
    emitTokens: parts.reduce((s, p) => s + p.emitTokens, 0),
    calls: parts.length,
  }
  return multi.emitChars < single.emitChars ? multi : single
}

/** Smallest line-anchored, unique old_string → new_string replacement that turns before into after.
 *  Tries every equivalent position of a pure insertion (repeated lines let it slide, e.g. JSON "}," "{")
 *  and both anchor-growing directions; returns the cheapest. */
export function minimalEdit(before: string, after: string): MinimalEdit {
  const a = before.split('\n')
  const b = after.split('\n')
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const windows = [{ s: pre, eA: a.length - suf, eB: b.length - suf }]
  if (windows[0].eA === pre && windows[0].eB > pre) {
    let { s, eB } = windows[0]
    while (s > 0 && b[s - 1] === b[eB - 1]) {
      s--
      eB--
      windows.push({ s, eA: s, eB })
    }
  }
  const occurrences = (x: string) => before.split(x).length - 1
  let best: MinimalEdit | undefined
  for (const w of windows)
    for (const upFirst of [true, false]) {
      let { s, eA, eB } = w
      const oldOf = () => a.slice(s, eA).join('\n')
      let toggle = upFirst
      while (!oldOf().trim() || occurrences(oldOf()) !== 1) {
        if ((toggle && s > 0) || eA >= a.length) s--
        else {
          eA++
          eB++
        }
        toggle = !toggle
        if (s < 0) throw new Error('cannot anchor edit')
      }
      const o = oldOf()
      const n = b.slice(s, eB).join('\n')
      if (!best || o.length + n.length < best.emitChars)
        best = { old: o, new: n, emitChars: o.length + n.length, emitTokens: 0 }
    }
  best!.emitTokens = tokens(best!.old) + tokens(best!.new)
  return best!
}

export interface Proneness {
  /** {} [] in the text the agent writes */
  brackets: number
  /** deepest bracket nesting inside the snippet, relative to its start */
  depth: number
  /** escapes the agent must get right inside JSON strings (\" \n \\) */
  escapes: number
  /** HTML tags in the snippet (opening + closing) */
  tags: number
}

export function proneness(snippet: string): Proneness {
  let d = 0
  let max = 0
  let min = 0
  let brackets = 0
  let inStr = false
  for (let i = 0; i < snippet.length; i++) {
    const c = snippet[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '"') inStr = !inStr
    if (inStr) continue
    if (c === '{' || c === '[') {
      brackets++
      d++
      max = Math.max(max, d)
    } else if (c === '}' || c === ']') {
      brackets++
      d--
      min = Math.min(min, d)
    }
  }
  return {
    brackets,
    depth: max - min,
    escapes: (snippet.match(/\\["n\\]/g) ?? []).length,
    tags: (snippet.match(/<\/?[a-zA-Z][^>]*>/g) ?? []).length,
  }
}

export interface DiffStats {
  patch: string
  added: number
  removed: number
  /** size of the unified diff (3 lines context), chars */
  chars: number
}

export function unifiedDiff(name: string, before: string, after: string): DiffStats {
  const patch = createTwoFilesPatch(`a/${name}`, `b/${name}`, before, after, '', '', { context: 3 })
  const lines = patch.split('\n').slice(2)
  return {
    patch,
    added: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
    removed: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
    chars: patch.length,
  }
}

/** visible text chars / file chars: how much of the file is the document's prose */
export function signalRatio(fileText: string, plainText: string): number {
  return plainText.replace(/\s+/g, ' ').trim().length / fileText.length
}

export function median(xs: number[]): number {
  const s = [...xs].sort((p, q) => p - q)
  return s[Math.floor(s.length / 2)]
}

export async function timeIt(n: number, fn: () => unknown | Promise<unknown>): Promise<number> {
  const runs: number[] = []
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    await fn()
    runs.push(performance.now() - t)
  }
  return median(runs)
}
