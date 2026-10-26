// collab — the agent-facing CLI of spike 06 (spike 01's loop commands + comment replies + spike 07's edit ops).
// Everything is a thin HTTP call to the running per-document server (`npm start`), default http://127.0.0.1:5108.
//
//   npm run collab -- [--server URL] <command> …
//
//   wait  [--timeout 540] [--consumer agent] [--takeover] [--settle 400]   block until annotation events arrive (JSON line)
//   peek  [--ack]                                                          non-blocking (hooks)
//   threads [--all] [--json]                                               open threads with quote, context and messages
//   reply   <thread> <text…> [--resolve]                                   answer in the thread (live in the sidebar)
//   resolve <thread> [text…]      reopen <thread> [text…]
//   comment <quote> <text…> [--kind question|comment|change]              the agent starts a thread on a quote
//   list | text                                                            the document (blocks with ids / plain text)
//   replace-text <find> <replace> [--all] | insert-after-heading <heading> <html> | append-section <html>
//   set-block <bid|#id> <html> | set-island-text <find> <replace>         edit (spike 07 ops, applied by the server)
//   status                                                                 server health + who is listening
//
// spike 08 (how the agent edits the live document):
//   read [--section <heading>] [--outline] [-n]       the LIVE document as canonical HTML (what the file will contain),
//                                                      one section only, with line numbers, or an outline with block ids
//                                                      and where the user's caret is
//   patch [file] [--dry-run] [--avoid-caret] [--propose [--message "…"]]   search/replace blocks (stdin or file) applied to the live doc:
//        <<<<<<< SEARCH                                  old html (copied from `read`; whitespace-insensitive)
//        =======
//        new html
//        >>>>>>> REPLACE            (or `>>>>>>> REPLACE ALL` to replace every occurrence)
//      also accepts JSON: [{"old": "…", "new": "…", "all": false}]
//   export <scratch.html> / apply <scratch.html>      P4: edit a snapshot copy freely, then 3-way merge it back
//   insert-after <find> <html> | move-section <heading> <before-heading|$end>   extra ops (P2)
//
// Exit codes of `wait` (spike 01): 0 = events, 2 = timeout, 3 = no server / server gone, 4 = another wait is listening.
import http from 'node:http'

const argv = process.argv.slice(2)
const flags = new Map<string, string | true>()
const pos: string[] = []
const BOOL = ['--propose', '--all', '--json', '--resolve', '--takeover', '--ack', '--outline', '-n', '--lines', '--dry-run', '--avoid-caret', '--text']
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--') || a === '-n') {
    if (!BOOL.includes(a) && argv[i + 1] !== undefined) flags.set(a, argv[++i])
    else flags.set(a, true)
  } else pos.push(a)
}
const str = (n: string, d: string) => (typeof flags.get(n) === 'string' ? (flags.get(n) as string) : d)
const server = str('--server', process.env.COLLAB_URL ?? 'http://127.0.0.1:5108').replace(/\/$/, '')
const [cmd, ...rest] = pos

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
function fail(code: number, o: Record<string, unknown>): never {
  out({ status: 'error', ...o })
  process.exit(code)
}

/** node:http with NO client timeout (undici's fetch kills a body-less long-poll after 300 s — spike 01) */
function request(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const req = http.request(`${server}${path}`, { method, agent: false, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('error', reject)
      res.on('end', () => {
        if (!res.complete) return reject(Object.assign(new Error('response incomplete (server died?)'), { code: 'ECONNRESET' }))
        const text = Buffer.concat(chunks).toString('utf8')
        let json: any = null
        try {
          json = text.trim() ? JSON.parse(text) : null
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode ?? 0, json, text })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}
async function call(method: string, path: string, body?: unknown) {
  try {
    const r = await request(method, path, body)
    if (r.status >= 400) fail(1, { code: 'REQUEST_FAILED', http: r.status, detail: r.json ?? r.text })
    return r.json
  } catch (e) {
    fail(3, { code: 'NO_SERVER', server, error: (e as Error).message, hint: 'start it with: npm start' })
  }
}

function printThreads(threads: any[]) {
  if (!threads.length) return console.log('(no threads)')
  for (const t of threads) {
    const where = t.orphaned ? 'ORPHANED (anchored text was deleted)' : `${t.section ? `§ ${t.section} · ` : ''}block ${t.block.id ?? '-'} (${t.block.type})`
    console.log(`${t.thread}  [${t.kind}${t.ask ? ', ask' : ''}] ${t.status}  ${where}`)
    console.log(`  quote: “${t.quote}”${t.leaf ? `  (label ${t.leaf.path})` : ''}`)
    for (const m of t.messages) console.log(`  ${m.agent ? '🤖' : '👤'} ${m.author}: ${m.text}`)
  }
}

const EDIT_OPS = ['replace-text', 'insert-after-heading', 'append-section', 'set-block', 'set-island-text', 'insert-after', 'move-section']

/** parse search/replace blocks (aider-style) or JSON into [{old, new, all}] */
export function parsePatch(input: string): { old: string; new: string; all?: boolean }[] {
  const t = input.trim()
  if (t.startsWith('[') || t.startsWith('{')) {
    const j = JSON.parse(t)
    return Array.isArray(j) ? j : j.edits
  }
  const edits: { old: string; new: string; all?: boolean }[] = []
  const lines = input.split('\n')
  let i = 0
  while (i < lines.length) {
    if (!/^<{5,}\s*SEARCH\s*$/.test(lines[i])) {
      if (lines[i].trim()) throw new Error(`line ${i + 1}: expected "<<<<<<< SEARCH", got ${JSON.stringify(lines[i].slice(0, 60))}`)
      i++
      continue
    }
    const old: string[] = []
    const neu: string[] = []
    i++
    while (i < lines.length && !/^={5,}\s*$/.test(lines[i])) old.push(lines[i++])
    if (i >= lines.length) throw new Error('missing "=======" after SEARCH block')
    i++
    while (i < lines.length && !/^>{5,}\s*REPLACE(\s+ALL)?\s*$/.test(lines[i])) neu.push(lines[i++])
    if (i >= lines.length) throw new Error('missing ">>>>>>> REPLACE" after the replacement')
    const all = /ALL\s*$/.test(lines[i])
    i++
    edits.push({ old: old.join('\n'), new: neu.join('\n'), ...(all ? { all } : {}) })
  }
  if (!edits.length) throw new Error('no SEARCH/REPLACE blocks found')
  return edits
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  switch (cmd) {
    case 'wait': {
      const q = new URLSearchParams({ consumer: str('--consumer', 'agent'), timeout: str('--timeout', '540'), settle: str('--settle', '400') })
      if (flags.has('--takeover')) q.set('takeover', '1')
      let r
      try {
        r = await request('GET', `/api/wait?${q}`)
      } catch (e) {
        fail(3, { code: 'SERVER_GONE', error: (e as Error).message, hint: 'npm start (queued events survive a restart)' })
      }
      const p = r.json ?? { status: 'bad_response', body: r.text }
      if (p.status === 'events') {
        out({ status: 'events', events: p.events })
        await request('POST', '/api/ack', { consumer: str('--consumer', 'agent'), seq: p.ack }) // ack AFTER printing → at-least-once
        process.exit(0)
      }
      if (p.status === 'timeout') {
        out({ status: 'timeout', hint: 'nothing happened; run wait again to keep listening' })
        process.exit(2)
      }
      if (p.status === 'listener_active') fail(4, { code: 'LISTENER_ACTIVE', hint: p.hint })
      if (p.status === 'server_stopped') fail(3, { code: 'SERVER_GONE', detail: p })
      fail(1, { code: 'UNEXPECTED', detail: p })
    }
    case 'peek': {
      const consumer = str('--consumer', 'agent')
      const p = await call('GET', `/api/peek?consumer=${encodeURIComponent(consumer)}`)
      out(p)
      if (flags.has('--ack') && p.ack) await call('POST', '/api/ack', { consumer, seq: p.ack })
      return
    }
    case 'threads': {
      const p = await call('GET', `/api/threads${flags.has('--all') ? '?all=1' : ''}`)
      if (flags.has('--json')) out(p)
      else printThreads(p.threads)
      return
    }
    case 'accept': {
      // (normally the user clicks "Accept change" in the sidebar; this is for tests)
      const p = await call('POST', `/api/threads/${rest[0]}/accept`, { by: str('--by', 'user') })
      out(p)
      return
    }
    case 'reply':
    case 'resolve':
    case 'reopen': {
      const [id, ...words] = rest
      if (!id) fail(1, { code: 'USAGE', hint: `collab ${cmd} <thread> ${cmd === 'reply' ? '<text…>' : '[text…]'}` })
      const text = words.join(' ')
      if (cmd === 'reply' && !text) fail(1, { code: 'USAGE', hint: 'collab reply <thread> <text…>' })
      const p = await call('POST', `/api/threads/${id}/${cmd}`, { text: text || undefined, resolve: flags.has('--resolve') })
      out({ status: 'ok', thread: p.thread.thread, thread_status: p.thread.status, messages: p.thread.messages.length })
      return
    }
    case 'comment': {
      const [quote, ...words] = rest
      const p = await call('POST', '/api/threads', { quote, text: words.join(' '), kind: str('--kind', 'question') })
      out(p)
      return
    }
    case 'list':
    case 'text': {
      const st = await call('GET', '/doc/state')
      if (cmd === 'text') console.log(st.text)
      else for (const b of st.blocks) console.log(`${b.type.padEnd(14)} ${(b.bid ?? '-').padEnd(7)} ${(b.id ? '#' + b.id : '-').padEnd(18)} ${b.text}`)
      return
    }
    case 'read': {
      const q = new URLSearchParams()
      if (flags.has('--outline')) q.set('format', 'outline')
      if (flags.has('--section')) q.set('section', str('--section', ''))
      if (flags.has('-n') || flags.has('--lines')) q.set('lines', '1')
      const r = await request('GET', `/agent/read?${q}`).catch((e) => fail(3, { code: 'NO_SERVER', error: (e as Error).message }))
      if (r.status >= 400) fail(1, r.json ?? { error: r.text })
      const p = r.json
      if (flags.has('--json')) return out(p)
      const who = p.carets.length ? p.carets.map((c: any) => `${c.name} is typing in block ${c.block ?? '?'} (“${c.text}…”)`).join('; ') : 'no user caret in the document'
      if (p.outline) {
        console.log(`# rev ${p.rev} · ${who}`)
        for (const e of p.outline) console.log(`${String(e.line).padStart(4)}  ${e.type.padEnd(12)} ${(e.bid ?? '-').padEnd(7)} ${(e.id ? '#' + e.id : '').padEnd(16)} ${e.text}${e.carets.length ? `   ✎ ${e.carets.join(', ')}` : ''}`)
      } else {
        console.log(`<!-- live document, rev ${p.rev}, lines ${p.from}–${p.to} · ${who} -->`)
        console.log(p.html)
      }
      return
    }
    case 'patch': {
      const input = rest[0] ? (await import('node:fs')).readFileSync(rest[0], 'utf8') : await readStdin()
      let edits
      try {
        edits = parsePatch(input)
      } catch (e) {
        fail(1, { code: 'BAD_PATCH', error: (e as Error).message })
      }
      const r = await request('POST', '/agent/patch', { edits, dryRun: flags.has('--dry-run'), avoidCaret: flags.has('--avoid-caret'), propose: flags.has('--propose'), message: flags.has('--message') ? str('--message', '') : undefined }).catch((e) =>
        fail(3, { code: 'NO_SERVER', error: (e as Error).message }),
      )
      if (r.status >= 400) {
        const e = r.json ?? { error: r.text }
        out({ status: 'error', ...e, closest: undefined })
        if (e.closest) console.log(`--- closest block, line ${e.closest.line} (current html):\n${e.closest.html}`)
        process.exit(e.code === 'USER_IN_BLOCK' ? 5 : 1)
      }
      out(r.json)
      return
    }
    case 'export':
    case 'apply': {
      if (!rest[0]) fail(1, { code: 'USAGE', hint: `collab ${cmd} <scratch.html>` })
      const { resolve } = await import('node:path')
      const r = await request('POST', `/agent/${cmd}`, { path: resolve(rest[0]) }).catch((e) => fail(3, { code: 'NO_SERVER', error: (e as Error).message }))
      if (r.status >= 400) fail(1, r.json ?? { error: r.text })
      out(r.json)
      return
    }
    case 'status': {
      const h = await call('GET', '/health')
      out({ status: 'running', url: server, doc: h.doc, listening: h.queue.listening, lastSeq: h.queue.lastSeq, connections: h.connections, peers: h.peers, comments: h.comments })
      return
    }
    default: {
      if (!EDIT_OPS.includes(cmd)) {
        fail(1, { code: 'USAGE', hint: 'collab <wait|peek|threads|reply|resolve|reopen|comment|list|text|status|replace-text|insert-after-heading|append-section|set-block|set-island-text|insert-after|move-section|read|patch|export|apply> …' })
      }
      const op =
        cmd === 'replace-text'
          ? { op: cmd, find: rest[0], replace: rest[1] ?? '', all: flags.has('--all') }
          : cmd === 'insert-after-heading'
            ? { op: cmd, heading: rest[0], html: rest[1] }
            : cmd === 'append-section'
              ? { op: cmd, html: rest[0] }
              : cmd === 'set-block'
                ? { op: cmd, id: rest[0], html: rest[1] }
                : cmd === 'insert-after'
                  ? { op: cmd, find: rest[0], html: rest[1] }
                  : cmd === 'move-section'
                    ? { op: cmd, heading: rest[0], before: rest[1] }
                    : { op: cmd, find: rest[0], replace: rest[1] ?? '' }
      const p = await call('POST', '/agent/op', { op, user: { name: 'Claude', color: '#7a4fc4' }, lingerMs: Number(str('--linger', '1200')) })
      out(p)
    }
  }
}
if (process.argv[1]?.endsWith('collab.ts')) main().catch((e) => fail(1, { code: 'CRASH', error: String(e?.stack || e) }))
