// The agent as a collaborator: a Node CLI that joins the document as a second Hocuspocus client
// (awareness name "Claude", own colour → caret + selection visible in every browser) and performs its
// edits as CRDT ops through the same reconciler the editor uses (lib/agentOps.ts).
//
//   npm run agent -- [--server http://127.0.0.1:5106] [--via ws|server] [--name Claude] [--color #7a4fc4]
//                    [--linger 1500] [--wait 0] [--json] <command> [args…]
//
//   list                                    top-level blocks: type · block id (data-bid) · #id · text
//   text                                    the whole document as plain text
//   replace-text <find> <replace> [--all]   character-level replacement inside a text block
//   insert-after-heading <heading> <html>   insert blocks after the heading whose text contains <heading>
//   append-section <html>                   append blocks at the end
//   set-block <bid|#id> <html>              replace one block (keeps its block id when 1 block → 1 block)
//   set-island-text <find> <replace>        rewrite text inside a raw-HTML island (one attribute!)
//   type <find> <text> [--type-delay 40]    "type" text after <find>, one character at a time (live demo)
//
//   --via ws       (default) connect over WebSocket like a browser: awareness/caret, offline-safe
//   --via server   POST /agent/op: the server applies the op on its own Y.Doc via a direct connection
//   --wait ms      delay between "connected" and the edit (tests use it to overlap with the user's typing)
//   --linger ms    keep the connection (and the caret) open after the edit so people can see it
//   --lock-timeout ms   set-island-text: how long to wait while a user is editing inside that island
//                       (awareness soft lock) before giving up with exit 5; --force ignores the lock
import process from 'node:process'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { applyOp, findIslandHtml, listBlocks, locate, type Op } from '../lib/agentOps.ts'
import { docText, yToDoc, yToDocWithMapping } from '../lib/pipeline.ts'
import { rescueOrphans } from '../src/comments/model.ts'
import { islandKey } from '../src/islands/env.ts'

const argv = process.argv.slice(2)
const flags = new Map<string, string | true>()
const positional: string[] = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--') && !['--all', '--json', '--force'].includes(a)) {
      flags.set(a, next)
      i++
    } else flags.set(a, true)
  } else positional.push(a)
}
const str = (name: string, dflt: string) => (typeof flags.get(name) === 'string' ? (flags.get(name) as string) : dflt)
const num = (name: string, dflt: number) => Number(str(name, String(dflt)))

const server = str('--server', 'http://127.0.0.1:5106').replace(/\/$/, '')
const via = str('--via', 'ws') as 'ws' | 'server'
const user = { name: str('--name', 'Claude'), color: str('--color', '#7a4fc4') }
const linger = num('--linger', 1500)
const wait = num('--wait', 0)
const asJson = flags.has('--json')
const [command, ...rest] = positional

if (!command) {
  console.error('usage: agent [--server URL] [--via ws|server] <list|text|replace-text|insert-after-heading|append-section|set-block|set-island-text|type> …')
  process.exit(2)
}

const out = (o: Record<string, unknown>) => console.log(asJson ? JSON.stringify(o) : Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n'))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function parseOp(): Op | null {
  switch (command) {
    case 'replace-text':
      return { op: 'replace-text', find: rest[0], replace: rest[1] ?? '', all: flags.has('--all') }
    case 'insert-after-heading':
      return { op: 'insert-after-heading', heading: rest[0], html: rest[1] }
    case 'append-section':
      return { op: 'append-section', html: rest[0] }
    case 'set-block':
      return { op: 'set-block', id: rest[0], html: rest[1] }
    case 'set-island-text':
      return { op: 'set-island-text', find: rest[0], replace: rest[1] ?? '' }
    default:
      return null
  }
}

// ---------------------------------------------------------------- via server (direct connection)
if (via === 'server') {
  const op = parseOp()
  if (!op) {
    console.error(`--via server supports the edit commands only (got ${command})`)
    process.exit(2)
  }
  if (wait) await sleep(wait)
  const res = await fetch(`${server}/agent/op`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, user, lingerMs: linger }) })
  const body = (await res.json()) as Record<string, unknown>
  out(body)
  process.exit(res.ok ? 0 : 1)
}

// ---------------------------------------------------------------- via ws (Hocuspocus client)
const info = (await (await fetch(`${server}/doc`)).json()) as { name: string }
const wsUrl = `${server.replace(/^http/, 'ws')}/collab`
const ydoc = new Y.Doc()
const t0 = performance.now()
const provider = new HocuspocusProvider({
  websocketProvider: new HocuspocusProviderWebsocket({ url: wsUrl, WebSocketPolyfill: WebSocket }),
  name: info.name,
  document: ydoc,
  // send each op immediately (the default batches outgoing updates for a few ms; fine either way)
  flushDelay: false,
})
provider.attach() // with an explicit websocketProvider the provider does not attach itself
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no sync from ${wsUrl} within 10 s`)), 10000)
  provider.on('synced', () => {
    clearTimeout(t)
    resolve()
  })
})
const awareness = provider.awareness!
const connectedMs = Math.round(performance.now() - t0)
console.log(`connected to ${wsUrl} as "${user.name}" in ${connectedMs} ms (${ydoc.getXmlFragment('default').length} blocks)`)

async function finish(code: number) {
  awareness.setLocalState(null)
  await sleep(50)
  provider.destroy()
  process.exit(code)
}

try {
  if (command === 'list') {
    for (const b of listBlocks(yToDoc(ydoc))) console.log(`${b.type.padEnd(14)} ${(b.bid ?? '-').padEnd(7)} ${(b.id ? '#' + b.id : '-').padEnd(18)} ${b.text}`)
    await finish(0)
  }
  if (command === 'text') {
    console.log(docText(yToDoc(ydoc)))
    await finish(0)
  }

  awareness.setLocalStateField('user', user)
  if (wait) await sleep(wait)

  if (command === 'type') {
    // live demo / "agent types while the user types": one character per op, each a tiny Yjs update
    const [find, text] = rest
    const delay = num('--type-delay', 40)
    let anchor = find
    let bytes = 0
    for (const ch of text) {
      const applied = applyOp(ydoc, { op: 'insert-after-text', find: anchor, text: ch }, 'agent')
      if (!flags.has('--no-caret')) awareness.setLocalStateField('cursor', { anchor: applied.head, head: applied.head })
      bytes += applied.updateBytes
      anchor += ch
      await sleep(delay)
    }
    out({ via: 'ws', op: 'type', typed: text.length, updateBytes: bytes })
  } else {
    const op = parseOp()
    if (!op) {
      console.error(`unknown command: ${command}`)
      await finish(2)
    }
    // 0. islands are one attribute (last writer wins): honour the browser's "user is editing inside" soft lock
    if (op!.op === 'set-island-text' && !flags.has('--force')) {
      const html = findIslandHtml(yToDoc(ydoc), op!.find)
      const key = html ? islandKey(html) : null
      const lockedBy = () => {
        for (const [id, st] of awareness.getStates()) {
          if (id === ydoc.clientID) continue
          const s = st as { user?: { name?: string }; island?: string | null }
          if (key && s.island === key) return s.user?.name ?? `client ${id}`
        }
        return null
      }
      await sleep(150) // awareness states arrive right after sync
      const lockTimeout = num('--lock-timeout', 2000)
      const t = Date.now()
      let who = lockedBy()
      while (who && Date.now() - t < lockTimeout) {
        await sleep(100)
        who = lockedBy()
      }
      if (who) {
        out({ via: 'ws', op: op!.op, locked: true, lockedBy: who, island: key, waitedMs: Date.now() - t })
        await finish(5)
      }
    }
    // 1. point the caret/selection at the target so people see where the agent is about to edit
    const target = locate(ydoc, op!)
    if (target) {
      awareness.setLocalStateField('cursor', target)
      await sleep(Math.min(400, linger))
    }
    // 2. edit (the provider sends the update right away)
    const applied = applyOp(ydoc, op!, 'agent')
    { // spike 06: a block rewrite can kill a comment anchor whose quote is unchanged → re-anchor it by quote
      const { doc, meta } = yToDocWithMapping(ydoc)
      rescueOrphans(ydoc, doc, meta.mapping, 'agent')
    }
    awareness.setLocalStateField('cursor', { anchor: applied.anchor, head: applied.head })
    out({ via: 'ws', op: op!.op, summary: applied.summary, updateBytes: applied.updateBytes, connectedMs })
  }
  // 3. wait until the server acknowledged our changes, then linger so the caret stays visible for a moment
  const t1 = Date.now()
  while (provider.hasUnsyncedChanges && Date.now() - t1 < 5000) await sleep(20)
  if (provider.hasUnsyncedChanges) console.error('warning: changes not acknowledged by the server within 5 s')
  await sleep(linger)
  await finish(0)
} catch (e) {
  console.error(`error: ${(e as Error).message}`)
  await finish(1)
}
