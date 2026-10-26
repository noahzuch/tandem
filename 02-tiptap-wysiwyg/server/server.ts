// Spike 02 server: one Node process per document (same shape as spike 01).
//   GET  /doc  -> { path, body, head, mtimeMs }   body = inner HTML of <body>, head = raw shell before it
//   PUT  /doc  -> body: editor HTML (text/html). Spliced back into the original shell
//                 (<head>/<style> untouched) and optionally pretty-printed.
//   /*        -> the Vue/Tiptap app (Vite in middleware mode, so `npm start` is one process)
//
// Usage: tsx server/server.ts [doc.html] [--port 5102] [--no-pretty] [--no-hmr]
//   (Vite HMR websocket uses port+100, i.e. 5202, unless --no-hmr)
//   Without a doc argument the shared sample ../samples/spec.html is copied to .work/spec.html
//   (fresh on every start) and that copy is edited, so the sample itself never changes.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createVite } from 'vite'
import { splitDocument, joinDocument, formatBody } from '../lib/htmlDoc.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--port'))
const port = Number(opt('--port') ?? process.env.PORT ?? 5102)
const pretty = !flag('--no-pretty')
const hmr = flag('--no-hmr') ? false : { port: port + 100 }

let docPath: string
if (positional[0]) {
  docPath = path.resolve(process.cwd(), positional[0])
} else {
  const sample = path.resolve(root, '../samples/spec.html')
  docPath = path.resolve(root, '.work/spec.html')
  fs.mkdirSync(path.dirname(docPath), { recursive: true })
  fs.copyFileSync(sample, docPath)
}
if (!fs.existsSync(docPath)) {
  console.error(`doc not found: ${docPath}`)
  process.exit(1)
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function handleDoc(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method === 'GET') {
    const html = fs.readFileSync(docPath, 'utf8')
    const parts = splitDocument(html)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        path: docPath,
        head: parts.before,
        body: parts.body,
        mtimeMs: fs.statSync(docPath).mtimeMs,
      }),
    )
    return
  }
  if (req.method === 'PUT') {
    const editorHtml = await readBody(req)
    const current = fs.readFileSync(docPath, 'utf8')
    const parts = splitDocument(current)
    let body = editorHtml
    if (pretty) {
      try {
        body = await formatBody(editorHtml)
      } catch (e) {
        console.error('prettier failed, saving unformatted:', (e as Error).message)
      }
    }
    const out = joinDocument(parts, body)
    fs.writeFileSync(docPath, out)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, bytes: Buffer.byteLength(out), pretty }))
    return
  }
  res.writeHead(405).end()
}

const vite = await createVite({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  server: { middlewareMode: true, hmr },
  appType: 'spa',
  logLevel: 'warn',
})

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/doc') {
    handleDoc(req, res).catch((e) => {
      console.error(e)
      res.writeHead(500).end(String(e))
    })
    return
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ app: 'collab-spike-02', doc: docPath }))
    return
  }
  vite.middlewares(req, res)
})

server.listen(port, '127.0.0.1', () => {
  const actual = (server.address() as { port: number }).port // --port 0 = ephemeral (used by verify)
  console.log(`spike 02 editor: http://127.0.0.1:${actual}/`)
  console.log(`editing: ${path.relative(process.cwd(), docPath)}  (pretty-print on save: ${pretty})`)
})

const shutdown = async () => {
  server.close()
  await vite.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
