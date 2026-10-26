// After an experiment run: was any of the user's typing lost? Are comments still anchored?
//   npm run check-loss -- [--url http://127.0.0.1:5108] [--log .work/user-sim.jsonl] [--doc .work/spec.html]
// Compares every sentence the simulator logged with the live document (server) and the file on disk (after a flush).
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (n: string, d: string) => {
  const i = args.indexOf(n)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d
}
const url = opt('--url', 'http://127.0.0.1:5108').replace(/\/$/, '')
const logPath = path.resolve(opt('--log', '.work/user-sim.jsonl'))
const docPath = path.resolve(opt('--doc', '.work/spec.html'))

const entries = fs
  .readFileSync(logPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
await fetch(`${url}/doc/flush`, { method: 'POST' })
await new Promise((r) => setTimeout(r, 300))
const live = ((await (await fetch(`${url}/doc/state`)).json()) as { text: string }).text
const fileText = fs
  .readFileSync(docPath, 'utf8')
  .replace(/<[^>]+>/g, '')
  .replace(/\s+/g, ' ')
const norm = (s: string) => s.replace(/\s+/g, ' ')
const typed = entries.filter((e) => e.event === 'typed')
const missing: string[] = []
const partial: string[] = []
for (const e of typed) {
  const s = (e.typed as string).trim()
  if (norm(live).includes(norm(s))) continue
  if (live.includes(`(${e.marker})`)) partial.push(`${e.marker}: ${s}`)
  else missing.push(`${e.marker} (typed at "${e.anchor}"): ${s}`)
}
const notInFile = typed.filter((e) => !fileText.includes(norm((e.typed as string).trim()))).map((e) => e.marker)
const threads = ((await (await fetch(`${url}/api/threads?all=1`)).json()) as { threads: any[] }).threads
console.log(
  JSON.stringify(
    {
      typedSentences: typed.length,
      intactInLiveDoc: typed.length - missing.length - partial.length,
      missing,
      partial,
      notInFileAfterFlush: notInFile,
      threads: threads.map((t) => ({ id: t.thread, status: t.status, orphaned: t.orphaned, quote: t.quote, messages: t.messages.length })),
      health: await (await fetch(`${url}/health`)).json().then((h: any) => ({ externalMerges: h.externalMerges, storesDeferredForExternalEdit: h.storesDeferredForExternalEdit, stores: h.stores, echoesIgnored: h.echoesIgnored })),
    },
    null,
    2,
  ),
)
