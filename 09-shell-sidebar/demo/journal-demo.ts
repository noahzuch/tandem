// Plays the brainstorming agent: appends the next journal entry to the Decision Journal, the way the brainstorm skill
// does (Edit/append on decisions.md — the shell picks it up from disk, nothing goes through the server).
//
//   npm run journal-demo                        append the next entry to .work/decisions.md
//   npm run journal-demo -- --all [--every 4]   append all remaining entries, one every 4 s
//   npm run journal-demo -- path/to/decisions.md
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJournal } from '../src/shell/journal.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const file = path.resolve(args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? path.join(root, '.work/decisions.md'))
const every = Number(args[args.indexOf('--every') + 1]) || 4

export const SCRIPT: { id: string; text: string }[] = [
  {
    id: 'F-8',
    text: 'F-8: [verified] Batches larger than 50 ops hit the API gateway\'s 256 KB body limit for notes with long checklists. (Source: gateway config `max_body_size`, checked 2026-10-24)',
  },
  {
    id: 'D-6',
    text: `D-6: [accepted] **Batch size is adaptive: 50 ops or 200 KB, whichever comes first.**
     - Evaluated: fixed 50 ops; fixed 20 ops; adaptive by size.
     - Rejected fixed 20: triples the round-trips and breaks the F-3 replay time.
     - Chosen because: F-8 sets the hard limit; typical days still replay in about 3 s (F-3).`,
  },
  {
    id: 'Q-4',
    text: `Q-4: [assumption] Should the conflict banner block editing until the user reviews it?
    - Current assumption: no; it is informational, because D-5 keeps both texts.
    - Impact if wrong: technicians keep editing a note with unresolved markers, and the markers pile up.`,
  },
]

function appendNext(): string | null {
  const text = fs.readFileSync(file, 'utf8')
  const have = new Set(parseJournal(text).entries.map((e) => e.id))
  const next = SCRIPT.find((s) => !have.has(s.id))
  if (!next) return null
  // insert before "## Rejected Approaches" (entries live in the chronological "## Journal" section)
  const at = text.search(/^## Rejected Approaches/m)
  const out = at >= 0 ? `${text.slice(0, at).trimEnd()}\n\n${next.text}\n\n${text.slice(at)}` : `${text.trimEnd()}\n\n${next.text}\n`
  fs.writeFileSync(file, out)
  return next.id
}

if (process.argv[1]?.endsWith('journal-demo.ts')) {
  if (!fs.existsSync(file)) {
    console.error(`no journal at ${file} (npm start creates .work/decisions.md)`)
    process.exit(1)
  }
  const loop = async () => {
    for (;;) {
      const id = appendNext()
      if (!id) return console.log('journal-demo: all demo entries are in the journal')
      console.log(`journal-demo: appended ${id} to ${path.relative(process.cwd(), file)}`)
      if (!args.includes('--all')) return
      await new Promise((r) => setTimeout(r, every * 1000))
    }
  }
  void loop()
}
