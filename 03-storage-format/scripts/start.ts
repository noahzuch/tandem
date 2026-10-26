// npm start: run the comparison, print the summary, serve out/report.html (+ the before/after files) on :5103.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { normalize, join, extname } from 'node:path'
import { runCompare, printSummary } from './compare.ts'

const PORT = Number(process.env.PORT ?? 5103)
const s = await runCompare()
printSummary(s)

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.patch': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ystate': 'application/octet-stream',
}
const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  const rel = url === '/' ? 'report.html' : normalize(url).replace(/^([/\\])+/, '')
  if (rel.startsWith('..')) return res.writeHead(400).end()
  try {
    const body = await readFile(join('out', rel))
    // show the "after" HTML files as source, not rendered, unless ?render
    const type = rel.startsWith('edits/') && extname(rel) === '.html' ? 'text/plain; charset=utf-8' : (TYPES[extname(rel)] ?? 'text/plain; charset=utf-8')
    res.writeHead(200, { 'content-type': type }).end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nReport: http://127.0.0.1:${PORT}/   (files: http://127.0.0.1:${PORT}/edits/<edit>/after.html …)  Ctrl-C to stop`)
})
const stop = () => server.close(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
