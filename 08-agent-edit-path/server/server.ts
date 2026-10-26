// Spike 06 server = spike 07's per-document server + comments (lib/comments.ts) + spike 01's durable event queue.
//   GET  /api/wait, POST /api/ack, GET /api/peek, POST /api/event   agent event queue (lib/eventQueue.ts)
//   GET  /api/threads[?all=1]           comment threads as the agent sees them (quote, context, block, messages)
//   POST /api/threads                   {quote, text, kind?}  the agent starts a thread on a quote
//   POST /api/threads/:id/reply         {text, resolve?}      agent reply (lands in the Y.Doc → live in every sidebar)
//   POST /api/threads/:id/resolve|reopen {text?}
//   POST /api/review/submit             {by}  "Send all comments to agent" → one review_submitted event
//   GET  /api/presence                  consumers listening right now ("agent: listening" badge; live via stateless msgs)
//
// (spike 07 header follows)
//   WS   /collab        Hocuspocus (self-hosted, MIT) — one document = one Y.Doc, persisted by lib/collabDoc.ts
//   GET  /doc           { path, name, head, mtimeMs }   head = raw shell before <body> (title/CSS for the editor)
//   GET  /doc/state     the live document as text + top-level blocks (assertions, agent "list")
//   POST /doc/flush     store the live document to disk now (⌘S in the browser)
//   POST /agent/op      apply an agent op through a Hocuspocus *direct connection* (the "edit the server's
//                       Y.Doc directly" variant of the agent — see README for the trade-off vs. the WS client)
//   GET  /health        stats: loadedFrom, stores, externalMerges, echoesIgnored, connections, log
//   /*                  the Vue/Tiptap app (Vite in middleware mode, so `npm start` is one process)
//
// Usage: tsx server/server.ts [doc.html] [--port 5108] [--no-pretty] [--no-hmr] [--debounce 800]
//   Without a doc argument the shared sample ../samples/spec.html is copied to .work/spec.html (fresh on
//   every start) and that copy is edited. Vite HMR uses port+100 (5207) unless --no-hmr.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createVite } from 'vite'
import crossws from 'crossws/adapters/node'
import { Hocuspocus, type Document } from '@hocuspocus/server'
import { splitDocument } from '../lib/htmlDoc.ts'
import { CollabDoc } from '../lib/collabDoc.ts'
import { applyOp, listBlocks, type Op } from '../lib/agentOps.ts'
import { docText, yToDoc, yToDocWithMapping } from '../lib/pipeline.ts'
import { EventQueue } from '../lib/eventQueue.ts'
import { AGENT, CommentsService } from '../lib/comments.ts'
import { applyEdits, caretsIn, caretsAffected, spliceDoc, targetFromHtml, htmlToDoc, humanCarets, mergeInto, numbered, outline, PatchError, render, sectionLines, touchedBlocks, type Edit } from '../lib/livePatch.ts'
import { joinDocument } from '../lib/htmlDoc.ts'
import { addMessage, createThread, findQuote, makeAnchor, setStatus, textAround, blockContext, threadsOf, type Kind } from '../src/comments/model.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const VALUE_FLAGS = ['--port', '--debounce']
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(args[i - 1])))
const port = Number(opt('--port') ?? process.env.PORT ?? 5108)
const pretty = !flag('--no-pretty')
const hmr = flag('--no-hmr') ? false : { port: port + 100 }
const debounce = Number(opt('--debounce') ?? 800)

let docPath: string
if (positional[0]) {
  docPath = path.resolve(process.cwd(), positional[0])
} else {
  const sample = path.resolve(root, '../samples/spec.html')
  docPath = path.resolve(root, '.work/spec.html')
  fs.mkdirSync(path.dirname(docPath), { recursive: true })
  fs.copyFileSync(sample, docPath)
  fs.rmSync(path.resolve(root, '.work/.collab'), { recursive: true, force: true }) // fresh copy = fresh sidecar
}
if (!fs.existsSync(docPath)) {
  console.error(`doc not found: ${docPath}`)
  process.exit(1)
}

const log = (msg: string) => console.log(`[collab] ${msg}`)
const stateDir = path.join(path.dirname(docPath), '.collab')
const queue = new EventQueue(stateDir, path.basename(docPath), log)
const comments = new CommentsService(stateDir, path.basename(docPath), queue, log)
const collab = new CollabDoc(docPath, {
  pretty,
  log,
  afterHtmlSeed: (ydoc) => comments.restore(ydoc),
  beforeStore: (ydoc) => comments.refresh(ydoc),
  afterStore: (ydoc) => comments.writeSidecar(ydoc),
  afterExternalMerge: (ydoc) => comments.rescue(ydoc),
  storeGuard: !flag('--no-store-guard'),
  smartMerge: !flag('--naive-merge'),
  awareness: () => liveDocument?.awareness ?? null,
})
// spike 08: every agent request (what the agent had to send, what came back) → .collab/agent-calls.jsonl
const callLog = path.join(stateDir, 'agent-calls.jsonl')
function logCall(kind: string, sent: number, result: Record<string, unknown>) {
  fs.mkdirSync(stateDir, { recursive: true })
  fs.appendFileSync(callLog, JSON.stringify({ t: new Date().toISOString(), kind, sentChars: sent, ...result }) + '\n')
}
/** P4: base snapshots of `collab export` copies, by absolute path */
const exportsBase = new Map<string, { base: Uint8Array; html: string }>()
const naiveMerge = flag('--naive-merge')
const AGENT_USER = { name: 'Claude', color: '#7a4fc4' }
/** show the agent's caret on the changed range for a moment (direct connection, like /agent/op) */
async function showAgentCaret(anchor: unknown, head: unknown, lingerMs = 1200) {
  if (!anchor || !liveDocument) return
  const conn = await hocuspocus.openDirectConnection(collab.name, { from: 'agent-direct' })
  await conn.transact((document) => document.awareness.setLocalState({ user: AGENT_USER, cursor: { anchor, head } }))
  setTimeout(() => {
    conn.document?.awareness.setLocalState(null)
    void conn.disconnect()
  }, lingerMs)
}
const errOut = (e: unknown) => {
  if (!(e instanceof PatchError)) console.error(e)
  const pe = e instanceof PatchError ? e : new PatchError('BAD_REQUEST', (e as Error).message)
  return { ok: false, code: pe.code, error: pe.message, ...pe.details }
}
let liveDocument: Document | null = null
queue.onPresence = (listening) => liveDocument?.broadcastStateless(JSON.stringify({ type: 'presence', listening }))

// ---------------------------------------------------------------- Hocuspocus
const hocuspocus = new Hocuspocus({
  quiet: true,
  debounce,
  maxDebounce: Math.max(debounce * 4, 2000),
  async onLoadDocument({ document, documentName }) {
    if (documentName !== collab.name) throw new Error(`unknown document ${documentName} (this server serves ${collab.name})`)
    await collab.load(document)
    comments.attach(document)
    liveDocument = document
  },
  async onStoreDocument({ document }) {
    await collab.store(document)
  },
  async afterUnloadDocument({ documentName }) {
    log(`unloaded ${documentName} (no connections left)`)
    collab.unload()
    liveDocument = null
  },
  async onAwarenessUpdate({ states }) {
    peers = states.map((s) => (s as { user?: { name?: string } }).user?.name ?? '?')
  },
})
let peers: string[] = []

const ws = crossws({
  hooks: {
    open: (peer) => {
      // same wiring as Hocuspocus' own Server class, inside our http server
      try {
        const conn = hocuspocus.handleConnection(peer.websocket as never, peer.request as never)
        ;(peer as unknown as { _hocuspocus: typeof conn })._hocuspocus = conn
      } catch (e) {
        console.error('handleConnection failed', e)
        peer.close(1011, 'handleConnection failed')
      }
    },
    message: (peer, message) => (peer as unknown as { _hocuspocus?: { handleMessage: (d: Uint8Array) => void } })._hocuspocus?.handleMessage(message.uint8Array()),
    close: (peer, event) => (peer as unknown as { _hocuspocus?: { handleClose: (e: { code: number; reason: string }) => void } })._hocuspocus?.handleClose({ code: event.code ?? 1000, reason: event.reason ?? '' }),
    error: (_peer, error) => console.error('websocket error', error),
  },
})

// ---------------------------------------------------------------- HTTP
async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** the live Y.Doc, or (nobody connected) a throw-away one loaded the same way a client would get it */
async function withDocument<T>(fn: (doc: Document, live: boolean) => Promise<T> | T): Promise<T> {
  if (liveDocument) return fn(liveDocument, true)
  const conn = await hocuspocus.openDirectConnection(collab.name)
  try {
    // spike 08: DirectConnection.transact does not await an async callback → run fn on the document, then an
    // empty transact so Hocuspocus runs its store hooks for whatever fn changed
    const out = await fn(conn.document as Document, false)
    await conn.transact(() => {})
    return out
  } finally {
    await conn.disconnect()
  }
}


// ---------------------------------------------------------------- spike 08: the patch op (P3) and suggestion mode
interface PatchRequest {
  edits: Edit[]
  dryRun?: boolean
  avoidCaret?: boolean
  /** suggestion mode: don't apply, create a "change" thread carrying the patch; the user accepts it in the sidebar */
  propose?: boolean
  message?: string
}

const strip = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

async function runPatch(document: Document, body: PatchRequest) {
  if (!Array.isArray(body.edits) || !body.edits.length) throw new PatchError('BAD_REQUEST', 'edits: [{old, new, all?}, …] required')
  const r = await render(document) // snapshot + canonical html (async: the user may type meanwhile → 3-way merge below)
  const carets = humanCarets(document, (liveDocument?.awareness ?? null) as never, r.doc, r.mapping)
  const patched = applyEdits(r.html, body.edits)
  // only the top-level blocks whose html changed are re-parsed (see spliceDoc: a full re-parse loses trailing spaces the user just typed)
  const sp = spliceDoc(r.doc, naiveMerge ? '' : r.html, patched.html)
  const touched = touchedBlocks(r.doc, sp.doc)
  if (!touched) throw new PatchError('NO_CHANGE', 'the patch does not change the document (after parsing: maybe only whitespace, or markup the editor normalises away)')
  // which human carets sit in a textblock this patch changes (identity after node reuse = unchanged)
  const inBlock = caretsAffected(carets, targetFromHtml(r.doc, r.html, patched.html, new Set(carets.flatMap((c) => (c.top ? [c.top] : [])))))
  if (inBlock.length && body.avoidCaret && !body.propose)
    throw new PatchError('USER_IN_BLOCK', `${inBlock.map((c) => c.name).join(', ')} is typing in a block this patch changes (“${inBlock[0].text}…”). Retry in a few seconds, make the edit smaller, or propose it (--propose).`, {
      carets: inBlock.map((c) => ({ name: c.name, block: c.bid, text: c.text })),
    })
  const base = { replaced: patched.replaced, fuzzy: patched.fuzzy, touchedBlocks: touched, anchor: null as unknown, head: null as unknown }
  if (body.dryRun) return { dryRun: true, ...base }
  if (body.propose) {
    // anchor the suggestion on the first edit's old text (as plain text), else on the first touched block
    const { doc, meta } = yToDocWithMapping(document)
    const quote = strip(body.edits[0].old).slice(0, 120)
    let hit = quote ? findQuote(doc, quote) : null
    let target: 'text' | 'block' = 'text'
    if (!hit) {
      let pos = 0
      doc.forEach((n, off, i) => {
        if (i === touched[0]) {
          pos = off
          hit = { from: off, to: off + n.nodeSize } as never
        }
      })
      target = 'block'
      void pos
    }
    const h = hit as unknown as { from: number; to: number }
    const ctx = textAround(doc, h.from, h.to)
    const preview = body.edits.map((e) => `− ${strip(e.old).slice(0, 140)}\n+ ${strip(e.new).slice(0, 140)}`).join('\n')
    const id = createThread(document, {
      kind: 'change',
      target,
      anchor: makeAnchor(document, meta.mapping, h.from, h.to),
      ...ctx,
      blockId: blockContext(doc, h.from).blockId,
      author: AGENT,
      text: `${body.message ?? 'Suggested edit'}\n${preview}`,
      delivery: 'none',
    })
    threadsOf(document).get(id)!.set('proposal', { edits: body.edits, preview })
    return { proposed: id, ...base, warnings: [] as string[] }
  }
  // --naive-merge = spike 07's watcher behaviour: re-parse everything, let the reconciler pair nodes by itself
  const m = mergeInto(document, r.base, (bd, prefer) => (naiveMerge ? htmlToDoc(patched.html) : targetFromHtml(bd, r.html, patched.html, prefer)), { source: 'local', context: { from: 'agent-patch' } }, !naiveMerge, (liveDocument?.awareness ?? null) as never)
  const rescued = comments.rescue(document)
  return {
    applied: body.edits.length,
    reparsedBlocks: sp.spliced ? sp.parsedChunks : 'all',
    ...base,
    updateBytes: m.updateBytes,
    rescuedComments: rescued,
    warnings: inBlock.map((c) => `${c.name}'s caret is in a block you changed (“${c.text}…”): their typing is merged, re-read before editing that block again`),
    anchor: m.anchor as unknown,
    head: m.head as unknown,
  }
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/doc' && req.method === 'GET') {
    const html = fs.readFileSync(docPath, 'utf8')
    json(res, 200, { path: docPath, name: collab.name, head: splitDocument(html).before, mtimeMs: fs.statSync(docPath).mtimeMs })
    return true
  }
  if (url.pathname === '/doc/state' && req.method === 'GET') {
    const out = await withDocument((document, live) => {
      const doc = yToDoc(document)
      return { live, text: docText(doc), blocks: listBlocks(doc), clients: document.getConnectionsCount() }
    })
    json(res, 200, out)
    return true
  }
  if (url.pathname === '/doc/flush' && req.method === 'POST') {
    if (liveDocument) await collab.store(liveDocument)
    json(res, 200, { ok: true, stored: !!liveDocument })
    return true
  }
  if (url.pathname === '/doc/settle' && req.method === 'POST') {
    await collab.settle()
    json(res, 200, { ok: true })
    return true
  }
  // ---------------------------------------------------------------- spike 08: read / patch / export / apply
  if (url.pathname === '/agent/read' && req.method === 'GET') {
    const format = url.searchParams.get('format') ?? 'html'
    const section = url.searchParams.get('section')
    const lines = url.searchParams.get('lines') === '1'
    try {
      const out = await withDocument(async (document) => {
        const r = await render(document)
        const carets = humanCarets(document, (liveDocument?.awareness ?? null) as never, r.doc, r.mapping)
        const base = { rev: r.rev, carets: carets.map((c) => ({ name: c.name, block: c.bid, text: c.text })) }
        if (format === 'outline') return { ...base, outline: outline(r.html, r.doc, carets) }
        let from = 1
        let to = Infinity
        if (section) {
          const sec = sectionLines(r.html, r.doc, section)
          if (!sec) throw new PatchError('NOT_FOUND', `no heading contains ${JSON.stringify(section)}`)
          from = sec.from
          to = sec.to
        }
        const all = r.html.split('\n')
        const slice = all.slice(from - 1, Number.isFinite(to) ? to - 1 : undefined).join('\n')
        return { ...base, from, to: Number.isFinite(to) ? to - 1 : all.length, html: lines ? numbered(r.html, from, to) : slice }
      })
      logCall('read', 0, { format, section, bytes: JSON.stringify(out).length })
      json(res, 200, { ok: true, ...out })
    } catch (e) {
      json(res, 400, errOut(e))
    }
    return true
  }
  if (url.pathname === '/agent/patch' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as PatchRequest
    const t0 = performance.now()
    const sent = Array.isArray(body.edits) ? body.edits.reduce((n, e) => n + (e.old?.length ?? 0) + (e.new?.length ?? 0), 0) : 0
    try {
      const result = await withDocument((document) => runPatch(document, body))
      void showAgentCaret(result.anchor, result.head)
      const out = { ok: true, ...result, anchor: undefined, head: undefined, ms: Math.round(performance.now() - t0) }
      logCall(body.propose ? 'patch:propose' : 'patch', sent, { ok: true, edits: body.edits.length, ms: out.ms, fuzzy: result.fuzzy })
      json(res, 200, out)
    } catch (e) {
      const o = errOut(e)
      logCall('patch', sent, { ok: false, code: o.code, error: o.error })
      json(res, 409, o)
    }
    return true
  }
  if ((url.pathname === '/agent/export' || url.pathname === '/agent/apply') && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as { path: string }
    const target = path.resolve(body.path)
    const t0 = performance.now()
    try {
      if (url.pathname === '/agent/export') {
        const out = await withDocument(async (document) => {
          const r = await render(document)
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, joinDocument(splitDocument(fs.readFileSync(docPath, 'utf8')), r.html))
          exportsBase.set(target, { base: r.base, html: r.html })
          return { exported: target, rev: r.rev, bytes: fs.statSync(target).size }
        })
        logCall('export', 0, { ok: true })
        json(res, 200, { ok: true, ...out })
      } else {
        const exp = exportsBase.get(target)
        if (!exp) throw new PatchError('NOT_FOUND', `no export base for ${target}: run "collab export ${body.path}" first (one apply per export; exports do not survive a server restart)`)
        const file = fs.readFileSync(target, 'utf8')
        const out = await withDocument((document) => {
          const body = splitDocument(file).body
          const m = mergeInto(document, exp.base, (bd, prefer) => (naiveMerge ? htmlToDoc(body) : targetFromHtml(bd, exp.html, body, prefer)), { source: 'local', context: { from: 'agent-apply' } }, !naiveMerge, (liveDocument?.awareness ?? null) as never)
          return { updateBytes: m.updateBytes, touchedBlocks: m.touched, rescuedComments: comments.rescue(document), anchor: m.anchor as unknown, head: m.head as unknown }
        })
        exportsBase.delete(target)
        void showAgentCaret(out.anchor, out.head)
        logCall('apply', 0, { ok: true, updateBytes: out.updateBytes })
        json(res, 200, { ok: true, ...out, anchor: undefined, head: undefined, hint: 'export again before the next round of edits', ms: Math.round(performance.now() - t0) })
      }
    } catch (e) {
      json(res, 409, errOut(e))
    }
    return true
  }
  if (url.pathname === '/agent/op' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as { op: Op; user?: { name: string; color: string }; lingerMs?: number }
    const t0 = performance.now()
    const sent = Object.entries(body.op).reduce((n, [k, v]) => n + (k === 'op' || typeof v !== 'string' ? 0 : v.length), 0)
    try {
      const conn = await hocuspocus.openDirectConnection(collab.name, { from: 'agent-direct' })
      let applied: ReturnType<typeof applyOp> | undefined
      let rescued: string[] = []
      let warnings: string[] = []
      await conn.transact((document) => {
        // spike 08: is a human caret in a block this op touches?
        const { doc: before, meta } = yToDocWithMapping(document)
        const carets = humanCarets(document, (liveDocument?.awareness ?? null) as never, before, meta.mapping as never)
        applied = applyOp(document, body.op, { source: 'local', context: { from: 'agent-direct' } })
        warnings = caretsIn(carets, touchedBlocks(before, yToDoc(document))).map((c) => `${c.name}'s caret is in a block you changed (“${c.text}…”)`)
        rescued = comments.rescue(document) // a block rewrite can kill an anchor whose quote is unchanged
        // the server-side awareness instance is broadcast too: a direct connection can show a caret as well
        // (setLocalStateField is a no-op while the local state is null, which Hocuspocus sets in the constructor)
        if (body.user) document.awareness.setLocalState({ user: body.user, cursor: { anchor: applied.anchor, head: applied.head } })
      })
      const linger = body.lingerMs ?? (body.user ? 1500 : 0)
      setTimeout(() => {
        if (body.user) conn.document?.awareness.setLocalState(null)
        void conn.disconnect()
      }, linger)
      json(res, 200, { ok: true, via: 'server', ...applied, anchor: undefined, head: undefined, rescuedComments: rescued, warnings, ms: Math.round(performance.now() - t0) })
      logCall(`op:${body.op.op}`, sent, { ok: true, ms: Math.round(performance.now() - t0) })
    } catch (e) {
      logCall(`op:${body.op.op}`, sent, { ok: false, error: (e as Error).message })
      json(res, 400, { ok: false, error: (e as Error).message })
    }
    return true
  }
  if (await queue.handle(req, res, url, () => readBody(req))) return true
  if (url.pathname.startsWith('/api/')) return handleComments(req, res, url)
  if (url.pathname === '/health') {
    json(res, 200, {
      app: 'collab-spike-08',
      queue: { lastSeq: queue.lastSeq, listening: queue.listening() },
      comments: comments.stats,
      doc: docPath,
      name: collab.name,
      port: actualPort,
      live: !!liveDocument,
      connections: hocuspocus.getConnectionsCount(),
      peers,
      awareness: liveDocument ? Array.from(liveDocument.awareness.getStates().entries()).map(([id, st]) => ({ id, user: (st as { user?: unknown }).user, cursor: !!(st as { cursor?: unknown }).cursor })) : [],
      pretty,
      debounce,
      ...collab.stats,
    })
    return true
  }
  return false
}

// ---------------------------------------------------------------- comments API (agent side; the browser writes the Y.Doc directly)
async function handleComments(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const m = /^\/api\/threads\/([\w-]+)\/(reply|resolve|reopen|accept)$/.exec(url.pathname)
  try {
    if (url.pathname === '/api/presence' && req.method === 'GET') {
      json(res, 200, { listening: queue.listening() })
      return true
    }
    if (url.pathname === '/api/threads' && req.method === 'GET') {
      const all = url.searchParams.get('all') === '1'
      const threads = await withDocument((document) => comments.describeAll(document, (t) => all || t.status === 'open'))
      json(res, 200, { threads })
      return true
    }
    if (url.pathname === '/api/threads' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { quote: string; text: string; kind?: Kind }
      const id = await withDocument((document) => {
        const { doc, meta } = yToDocWithMapping(document)
        const r = findQuote(doc, body.quote)
        if (!r) throw new Error(`quote not found: ${JSON.stringify(body.quote)}`)
        const ctx = textAround(doc, r.from, r.to)
        return createThread(document, {
          kind: body.kind ?? 'question',
          target: 'text',
          anchor: makeAnchor(document, meta.mapping, r.from, r.to),
          ...ctx,
          blockId: blockContext(doc, r.from).blockId,
          author: AGENT,
          text: body.text,
          delivery: 'none',
        })
      })
      json(res, 200, { ok: true, thread: id })
      return true
    }
    if (m && m[2] === 'accept' && req.method === 'POST') {
      // spike 08 suggestion mode: the user accepts the agent's proposed patch (re-matched against the live doc NOW)
      const id = m[1]
      const body = JSON.parse((await readBody(req)) || '{}') as { by?: string }
      const by = { name: body.by ?? 'user', kind: 'user' as const }
      const out = await withDocument(async (document) => {
        const t = threadsOf(document).get(id)
        const proposal = t?.get('proposal') as { edits: Edit[] } | undefined
        if (!t || !proposal) throw new PatchError('NOT_FOUND', `thread ${id} has no proposal`)
        try {
          const r = await runPatch(document, { edits: proposal.edits })
          addMessage(document, id, by, 'Accepted.', 'user-comments')
          setStatus(document, id, 'resolved', by.name, 'user-comments')
          return { accepted: true, updateBytes: (r as { updateBytes?: number }).updateBytes }
        } catch (e) {
          // the text changed since the proposal: tell both sides, keep the thread open for the agent to re-propose
          addMessage(document, id, by, `Could not apply: ${(e as Error).message.slice(0, 160)}`, 'user-comments')
          throw e
        }
      })
      json(res, 200, { ok: true, ...out })
      return true
    }
    if (m && req.method === 'POST') {
      const [, id, action] = m
      const body = JSON.parse((await readBody(req)) || '{}') as { text?: string; resolve?: boolean }
      const out = await withDocument((document) => {
        if (!threadsOf(document).has(id)) throw new Error(`no thread ${id}`)
        if (body.text) addMessage(document, id, AGENT, body.text, 'agent')
        if (action === 'resolve' || body.resolve) setStatus(document, id, 'resolved', AGENT.name, 'agent')
        if (action === 'reopen') setStatus(document, id, 'open', AGENT.name, 'agent')
        return comments.describeAll(document, (t) => t.id === id)[0]
      })
      json(res, 200, { ok: true, thread: out })
      return true
    }
    if (url.pathname === '/api/review/submit' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as { by?: string }
      const out = await withDocument((document) => comments.submitReview(document, body.by ?? 'user'))
      json(res, 200, { ok: true, ...out })
      return true
    }
  } catch (e) {
    json(res, 400, { ok: false, error: (e as Error).message })
    return true
  }
  json(res, 404, { ok: false, error: 'not found' })
  return true
}

const vite = await createVite({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  // --no-hmr: also no Vite client websocket, otherwise the client reloads the page when the server restarts
  // (verify tests the provider's own reconnect across a server restart)
  server: { middlewareMode: true, hmr, ws: hmr ? undefined : false },
  appType: 'spa',
  logLevel: 'warn',
})

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  handleApi(req, res, url)
    .then((handled) => {
      if (!handled) vite.middlewares(req, res)
    })
    .catch((e) => {
      console.error(e)
      if (!res.headersSent) res.writeHead(500)
      res.end(String(e))
    })
})
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/collab') ws.handleUpgrade(req, socket, head)
  else if (!hmr) socket.destroy()
  // (with HMR on, Vite's own ws server listens on its own port, nothing else upgrades here)
})

let actualPort = port
server.listen(port, '127.0.0.1', () => {
  actualPort = (server.address() as { port: number }).port // --port 0 = ephemeral (used by verify)
  console.log(`spike 08 editor: http://127.0.0.1:${actualPort}/`)
  console.log(`editing: ${path.relative(process.cwd(), docPath)}  (pretty-print on save: ${pretty}, store debounce ${debounce} ms)`)
  const srv = actualPort === 5108 ? '' : ` --server http://127.0.0.1:${actualPort}`
  console.log(`agent:   npm run collab --${srv} wait      (then: npm run collab --${srv} reply <thread> "…" / threads / replace-text …)`)
})

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down: storing open documents…')
  queue.close('server stopping')
  collab.close()
  server.close()
  try {
    for (const document of hocuspocus.documents.values()) await collab.store(document)
  } catch (e) {
    console.error(e)
  }
  hocuspocus.closeConnections()
  await vite.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
