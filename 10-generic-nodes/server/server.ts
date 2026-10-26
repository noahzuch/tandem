// Spike 07 server: one Node process per document.
//   WS   /collab        Hocuspocus (self-hosted, MIT) — one document = one Y.Doc, persisted by lib/collabDoc.ts
//   GET  /doc           { path, name, head, mtimeMs }   head = raw shell before <body> (title/CSS for the editor)
//   GET  /doc/state     the live document as text + top-level blocks (assertions, agent "list")
//   POST /doc/flush     store the live document to disk now (⌘S in the browser)
//   POST /agent/op      apply an agent op through a Hocuspocus *direct connection* (the "edit the server's
//                       Y.Doc directly" variant of the agent — see README for the trade-off vs. the WS client)
//   GET  /health        stats: loadedFrom, stores, externalMerges, echoesIgnored, connections, log
//   /*                  the Vue/Tiptap app (Vite in middleware mode, so `npm start` is one process)
//
// Usage: tsx server/server.ts [doc.html] [--port 5110] [--no-pretty] [--no-hmr] [--debounce 800]
//   Without a doc argument the shared sample ../samples/spec.html is copied to .work/spec.html (fresh on
//   every start) and that copy is edited. Vite HMR uses port+100 (5210) unless --no-hmr.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createVite } from 'vite'
import crossws from 'crossws/adapters/node'
import { Hocuspocus, type Document } from '@hocuspocus/server'
import { splitDocument, joinDocument } from '../lib/htmlDoc.ts'
import { CollabDoc } from '../lib/collabDoc.ts'
import { applyOp, listBlocks, type Op } from '../lib/agentOps.ts'
import { docText, yToDoc, bodyToDoc, docToBody } from '../lib/pipeline.ts'
import { setPolicyPreset, policy } from '../src/generic/policy.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const VALUE_FLAGS = ['--port', '--debounce', '--mode', '--svg', '--shape']
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(args[i - 1])))
const port = Number(opt('--port') ?? process.env.PORT ?? 5110)
const pretty = !flag('--no-pretty')
const hmr = flag('--no-hmr') ? false : { port: port + 100 }
const debounce = Number(opt('--debounce') ?? 800)
// spike 10: which unknown elements become generic nodes (round 2 default: everything free; --mode locked|islands|rules
// for comparison), the SVG experiment, and round 2's Enter variant (a) (--shape block)
const mode = opt('--mode') ?? 'free'
const svg = (opt('--svg') ?? 'island') as 'island' | 'nodes'
const shape = (opt('--shape') ?? 'inline') as 'inline' | 'block'
setPolicyPreset(mode)
policy.svg = svg
policy.textblocks = shape

let docPath: string
if (positional[0]) {
  docPath = path.resolve(process.cwd(), positional[0])
} else {
  const sample = path.resolve(root, 'samples/battle.html')
  docPath = path.resolve(root, '.work/battle.html')
  fs.mkdirSync(path.dirname(docPath), { recursive: true })
  fs.copyFileSync(sample, docPath)
  fs.rmSync(path.resolve(root, '.work/.collab'), { recursive: true, force: true }) // fresh copy = fresh sidecar
}
if (!fs.existsSync(docPath)) {
  console.error(`doc not found: ${docPath}`)
  process.exit(1)
}

const log = (msg: string) => console.log(`[collab] ${msg}`)
const collab = new CollabDoc(docPath, { pretty, log })
let liveDocument: Document | null = null

// ---------------------------------------------------------------- Hocuspocus
const hocuspocus = new Hocuspocus({
  quiet: true,
  debounce,
  maxDebounce: Math.max(debounce * 4, 2000),
  async onLoadDocument({ document, documentName }) {
    if (documentName !== collab.name) throw new Error(`unknown document ${documentName} (this server serves ${collab.name})`)
    await collab.load(document)
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
    let out!: T
    await conn.transact(async (document) => {
      out = await fn(document, false)
    })
    return out
  } finally {
    await conn.disconnect()
  }
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/doc' && req.method === 'GET') {
    const html = fs.readFileSync(docPath, 'utf8')
    json(res, 200, { path: docPath, name: collab.name, head: splitDocument(html).before, body: splitDocument(html).body, mtimeMs: fs.statSync(docPath).mtimeMs, mode, svg, shape })
    return true
  }
  if (url.pathname === '/doc' && req.method === 'PUT') {
    // spike 10: non-collab mode (?collab=0) saves the editor's HTML directly (spike 04's path: prettier on
    // placeholders → expandIslands → spliced into the original shell)
    const { html } = JSON.parse(await readBody(req)) as { html: string }
    const current = fs.readFileSync(docPath, 'utf8')
    const body = await docToBody(bodyToDoc(html), pretty)
    const out = joinDocument(splitDocument(current), body)
    fs.writeFileSync(docPath, out)
    json(res, 200, { ok: true, bytes: Buffer.byteLength(out) })
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
  if (url.pathname === '/agent/op' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as { op: Op; user?: { name: string; color: string }; lingerMs?: number }
    const t0 = performance.now()
    try {
      const conn = await hocuspocus.openDirectConnection(collab.name, { from: 'agent-direct' })
      let applied: ReturnType<typeof applyOp> | undefined
      await conn.transact((document) => {
        applied = applyOp(document, body.op, { source: 'local', context: { from: 'agent-direct' } })
        // the server-side awareness instance is broadcast too: a direct connection can show a caret as well
        // (setLocalStateField is a no-op while the local state is null, which Hocuspocus sets in the constructor)
        if (body.user) document.awareness.setLocalState({ user: body.user, cursor: { anchor: applied.anchor, head: applied.head } })
      })
      const linger = body.lingerMs ?? (body.user ? 1500 : 0)
      setTimeout(() => {
        if (body.user) conn.document?.awareness.setLocalState(null)
        void conn.disconnect()
      }, linger)
      json(res, 200, { ok: true, via: 'server', ...applied, anchor: undefined, head: undefined, ms: Math.round(performance.now() - t0) })
    } catch (e) {
      json(res, 400, { ok: false, error: (e as Error).message })
    }
    return true
  }
  if (url.pathname === '/health') {
    json(res, 200, {
      app: 'collab-spike-10',
      mode,
      svg,
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
  console.log(`spike 10 editor: http://127.0.0.1:${actualPort}/`)
  console.log(`editing: ${path.relative(process.cwd(), docPath)}  (pretty-print on save: ${pretty}, store debounce ${debounce} ms, mode ${mode}, svg ${svg}, shape ${shape})`)
  console.log(`try:     ?mode=free|locked|islands|rules  ?svg=nodes  ?isolating=0  ?shape=block  ?collab=0  (URL params override the server flags per tab; collab=0 = plain editor, saves with PUT /doc)`)
  console.log(`agent:   npm run agent -- --server http://127.0.0.1:${actualPort} list`)
})

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down: storing open documents…')
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
