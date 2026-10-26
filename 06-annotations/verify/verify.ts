// npm run verify — headless proof of spike 06's claims. Exits 0 when every PASS/FAIL check passes.
//
// Starts its own server (free port, no HMR) on a temp copy of samples/spec.html, drives a real browser (Playwright) as
// "the user" and the agent CLI (`bin/collab.ts`, `agent/agent.ts`) as child processes as "Claude".
// Also runs the anchoring experiment (experiments/anchoring.ts) and requires it to hold.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { root, startServer, freePort, type ServerHandle } from '../lib/serverProc.ts'

const sample = path.resolve(root, '../samples/spec.html')
let failures = 0
let passes = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (ok) passes++
  else failures++
}
const observed = (what: string) => console.log(`OBSERVED  ${what}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(fn: () => Promise<T> | T, pred: (v: T) => boolean, timeoutMs = 8000, every = 50): Promise<T> {
  const t0 = Date.now()
  let v = await fn()
  while (!pred(v) && Date.now() - t0 < timeoutMs) {
    await sleep(every)
    v = await fn()
  }
  return v
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike06-'))
const doc = path.join(tmp, 'spec.html')
fs.copyFileSync(sample, doc)
const original = fs.readFileSync(doc, 'utf8')
const readDoc = () => fs.readFileSync(doc, 'utf8')
const shot = (name: string) => path.join(root, name)

// ---------------------------------------------------------------- child processes
interface Run {
  code: number | null
  stdout: string
  stderr: string
  json: any
  ms: number
}
function run(script: string, args: string[]): { done: Promise<Run>; started: number } {
  const started = Date.now()
  const proc = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
  proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  const done = new Promise<Run>((resolve) =>
    proc.on('exit', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith('{'))
      let json: any = null
      try {
        json = line ? JSON.parse(line) : null
      } catch {
        /* not json */
      }
      resolve({ code, stdout, stderr, json, ms: Date.now() - started })
    }),
  )
  return { done, started }
}
let url = ''
const collab = (...args: string[]) => run('bin/collab.ts', ['--server', url, ...args]).done
const waitBg = (timeout = 40) => run('bin/collab.ts', ['--server', url, 'wait', '--timeout', String(timeout)])

// ---------------------------------------------------------------- page helpers
async function selectText(page: Page, text: string) {
  const ok = await page.evaluate((s) => {
    const ed = (window as any).__editor
    let from = -1
    ed.state.doc.descendants((n: any, p: number) => {
      if (from >= 0 || !n.isText) return
      const i = n.text.indexOf(s)
      if (i >= 0) from = p + i
    })
    if (from < 0) return false
    ed.commands.setTextSelection({ from, to: from + s.length })
    ed.view.focus()
    const dom = ed.view.domAtPos(from).node
    ;(dom.nodeType === 1 ? dom : dom.parentElement).scrollIntoView({ block: 'center' })
    return true
  }, text)
  if (!ok) throw new Error(`selectText: not found: ${text}`)
  await page.getByTestId('bubble-comment').waitFor({ state: 'visible', timeout: 3000 })
}
async function placeCaret(page: Page, after: string) {
  const ok = await page.evaluate((s) => {
    const ed = (window as any).__editor
    let pos = -1
    ed.state.doc.descendants((n: any, p: number) => {
      if (pos >= 0 || !n.isText) return
      const i = n.text.indexOf(s)
      if (i >= 0) pos = p + i + s.length
    })
    if (pos < 0) return false
    ed.commands.setTextSelection(pos)
    ed.view.focus()
    return true
  }, after)
  if (!ok) throw new Error(`placeCaret: not found: ${after}`)
  await sleep(30)
}
async function composeAndSubmit(page: Page, text: string, kind?: string, shotName?: string) {
  await page.getByTestId('composer').waitFor({ timeout: 3000 })
  if (kind) await page.getByTestId(`kind-${kind}`).click()
  await page.getByTestId('composer-text').fill(text)
  if (shotName) {
    await sleep(250)
    await page.screenshot({ path: shot(shotName), clip: { x: 300, y: 0, width: 1200, height: 520 } })
  }
  await page.getByTestId('composer-submit').click()
  await page.getByTestId('composer').waitFor({ state: 'detached', timeout: 3000 })
  return page.evaluate(() => (window as any).__comments.store.active as string)
}
const highlight = (page: Page, id: string) => page.evaluate((t) => Array.from(document.querySelectorAll(`.tiptap [data-thread="${t}"]`)).map((e) => (e as HTMLElement).innerText).join(''), id)
const storeThread = (page: Page, id: string) => page.evaluate((t) => JSON.parse(JSON.stringify((window as any).__comments.store.threads.find((x: any) => x.id === t) ?? null)), id)
const pageText = (page: Page) => page.evaluate(() => (window as any).__editor.state.doc.textBetween(0, (window as any).__editor.state.doc.content.size, '\n', '￼') as string)
const badge = (page: Page) => page.getByTestId('agent-listening').innerText()
async function threadsCli(all = true) {
  const r = await collab('threads', '--json', ...(all ? ['--all'] : []))
  return (r.json?.threads ?? []) as any[]
}
async function converged(page: Page) {
  const t = await waitFor(
    async () => ({ b: await pageText(page), s: ((await (await fetch(`${url}/doc/state`)).json()) as { text: string }).text }),
    (v) => v.b === v.s,
    6000,
  )
  return t.b === t.s
}
const bidOf = (page: Page, startsWith: string): Promise<string | null> =>
  page.evaluate((s) => {
    let id: string | null = null
    ;(window as any).__editor.state.doc.descendants((n: any) => {
      if (id === null && n.isTextblock && n.textContent.startsWith(s)) id = n.attrs.bid
    })
    return id
  }, startsWith)

// ---------------------------------------------------------------- run
let server: ServerHandle | undefined
let browser: Browser | undefined
const port = await freePort()
try {
  // ============================================================ 0. experiments: anchoring (headless) + caret race A/B (browser)
  {
    const race = await run('experiments/typing-race.ts', []).done
    check('typing race: with the caret fix the user\'s word survives remote typing before the caret (3/3)', race.code === 0, race.stdout.trim().split('\n').slice(-3).join(' | '))
    const r = await run('experiments/anchoring.ts', []).done
    const ok = r.code === 0
    check('anchoring experiment: all expectations hold (mark vs relpos, see experiments/anchoring.ts)', ok, ok ? `${(r.stdout.match(/EXPECT ok/g) ?? []).length} expectations` : r.stdout.split('\n').filter((l) => l.includes('FAIL')).join(' | ') + r.stderr.slice(0, 300))
  }

  server = await startServer(doc, port)
  url = server.url
  console.log(`server: ${url}  doc: ${doc}`)
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
  const consoleErrors: string[] = []
  const viteNoise = /WebSocket|\[vite\]|Vite server/
  page.on('console', (m) => m.type() === 'error' && !viteNoise.test(m.text()) && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => !viteNoise.test(String(e)) && consoleErrors.push(String(e)))
  await page.goto(`${url}/?user=Noah&color=%232a7de1`)
  await page.locator('.tiptap h1').waitFor({ timeout: 15000 })
  await page.getByTestId('comments-panel').waitFor()
  await sleep(500)
  check('load: comments panel shown, agent badge says "not listening"', (await badge(page)).includes('not listening'))

  // ============================================================ 1. immediate mode: select → Comment → `wait` returns the event
  await page.getByTestId('mode-now').click()
  let w = waitBg()
  let b = await waitFor(() => badge(page), (t) => !t.includes('not'), 8000)
  check('presence: a running `collab wait` flips the badge to "agent: listening" (stateless message, live)', !b.includes('not'), b)
  await selectText(page, 'client-side queue')
  await page.getByTestId('bubble-comment').click()
  const t1 = await composeAndSubmit(page, 'Is this the same thing as the outbox? Please make the naming consistent.', 'change', 'screenshot-composer.png')
  let r = await w.done
  const waitExit = Date.now()
  const ev1 = r.json?.events?.[0]
  const introBid = await bidOf(page, 'Field technicians')
  check('wait: exits 0 with an annotation_created event', r.code === 0 && ev1?.type === 'annotation_created', `exit ${r.code}, ${ev1?.type}`)
  check('event: correct quote + thread id + kind + body', ev1?.quote === 'client-side queue' && ev1?.thread === t1 && ev1?.kind === 'change' && ev1?.body.startsWith('Is this the same'), JSON.stringify({ quote: ev1?.quote, kind: ev1?.kind }))
  check('event: surrounding context + block id + section', ev1?.prefix?.endsWith('This spec covers the ') && ev1?.suffix?.startsWith(', the /sync endpoint') && ev1?.block?.id === introBid && ev1?.block?.text.startsWith('Field technicians') && ev1?.section === 'Spec: Offline sync for field notes', JSON.stringify({ block: ev1?.block?.id, section: ev1?.section }))
  {
    const created = (await storeThread(page, t1)).createdAt as number
    observed(`latency: comment created → event queued ${new Date(ev1.ts).getTime() - created} ms → \`wait\` printed + acked + exited ${waitExit - new Date(ev1.ts).getTime()} ms (400 ms of it = settle window)`)
  }
  check('highlight: decoration covers exactly the quote', (await highlight(page, t1)) === 'client-side queue')
  b = await waitFor(() => badge(page), (t) => t.includes('not'), 4000)
  check('presence: badge back to "not listening" after wait returned', b.includes('not'), b)

  // ============================================================ 2. agent replies → reply visible in the sidebar (Yjs, no push)
  {
    const rr = await collab('reply', t1, 'Yes — the client-side queue is the outbox. I will rename it once the paragraph settles.')
    const exited = Date.now()
    const card = page.getByTestId(`thread-${t1}`)
    await card.getByTestId('agent-msg').waitFor({ timeout: 5000 })
    const seen = Date.now()
    check('agent reply (CLI) → appears live in the thread card', rr.code === 0 && (await card.getByTestId('agent-msg').innerText()).includes('is the outbox'))
    observed(`latency: \`collab reply\` process ${rr.ms} ms (tsx start + HTTP), reply visible in the card ≤ ${seen - exited} ms after the CLI exited`)
    check('agent reply does NOT emit an event back to the agent', ((await (await fetch(`${url}/api/peek`)).json()) as any).events.length === 0)
  }

  // ============================================================ 3. concurrent edits before/inside the anchor (user) and before/after it (agent)
  {
    // the agent types char by char (ws client) BEFORE the anchor in the same paragraph and applies a coarse op (server)
    // AFTER it, while the user types inside the anchor and before it. (This scenario found the y-tiptap caret bug that
    // src/editor/caretFix.ts works around — A/B in experiments/typing-race.ts.)
    const agentTyping = run('agent/agent.ts', ['--server', url, '--json', '--linger', '300', 'type', 'Field technicians', ' and auditors', '--type-delay', '60']).done
    const agentOps = (async () => {
      await sleep(300)
      return [await collab('replace-text', 'conflict handling', 'conflict resolution')]
    })()
    await sleep(150)
    await placeCaret(page, 'client-side')
    await page.keyboard.type(' durable', { delay: 70 }) // inside the anchor
    await placeCaret(page, 'Notes taken offline must')
    await page.keyboard.type(' always', { delay: 50 }) // before the anchor, same paragraph
    const ag = await agentTyping
    const ops = await agentOps
    check('concurrent: agent typing (ws, char by char, same paragraph) + agent op (server) succeeded', ag.code === 0 && ops.every((o) => o.code === 0), `${ag.code}/${ops.map((o) => o.code)}`)
    await sleep(600)
    const h = await highlight(page, t1)
    check('concurrent: highlight still covers exactly the (edited) quote', h === 'client-side durable queue', JSON.stringify(h))
    const srv = (await threadsCli()).find((t) => t.thread === t1)
    check('concurrent: server resolves the same anchor (quote via CLI)', srv?.quote === 'client-side durable queue' && !srv?.orphaned, srv?.quote)
    const txt = await pageText(page)
    check('concurrent: all four edits present, the user\'s words intact', txt.includes('Field technicians and auditors') && txt.includes('always sync') && txt.includes('conflict resolution') && txt.includes('client-side durable queue'))
    check('concurrent: browser and server converged', await converged(page))
  }

  // ============================================================ 4. agent fixes the change request: replace the quote, reply + resolve
  {
    await collab('replace-text', 'client-side durable queue', 'outbox')
    const h = await waitFor(() => highlight(page, t1), (x) => x === 'outbox', 4000)
    check('agent replaced the whole quoted text → anchor moves onto the replacement ("inclusive" edges)', h === 'outbox', JSON.stringify(h))
    const rr = await collab('reply', t1, 'Renamed to "outbox".', '--resolve')
    const st = await waitFor(() => storeThread(page, t1), (t) => t?.status === 'resolved', 4000)
    check('resolve via CLI → thread resolved in the browser', rr.code === 0 && st?.status === 'resolved' && st?.resolvedBy === 'Claude')
    check('resolved thread: highlight hidden, card hidden by default', (await highlight(page, t1)) === '' && (await page.getByTestId(`thread-${t1}`).count()) === 0)
    await page.getByTestId('toggle-resolved').click()
    const card = page.getByTestId(`thread-${t1}`)
    await card.waitFor({ timeout: 3000 })
    check('"show resolved" → card visible with "resolved by Claude"', (await card.getByTestId('resolved-tag').innerText()).includes('Claude'))
    await card.click()
    await card.getByTestId('thread-reopen').click()
    const st2 = await waitFor(() => threadsCli(), (ts) => ts.find((t) => t.thread === t1)?.status === 'open', 4000)
    check('re-open in the UI → CLI sees it open again', st2.find((t) => t.thread === t1)?.status === 'open')
    await card.getByTestId('thread-resolve').click()
    await page.getByTestId('toggle-resolved').click()
  }

  // ============================================================ 5. review round: drafts → "Send all to agent" → ONE event
  let tDraft1 = ''
  let tDraft2 = ''
  {
    await page.getByTestId('mode-review').click()
    // real mouse: double-click a word
    const word = page.locator('.tiptap p', { hasText: 'so retries are idempotent' })
    await word.scrollIntoViewIfNeeded()
    const box = await page.evaluate(() => {
      const p = Array.from(document.querySelectorAll('.tiptap p')).find((e) => e.textContent!.includes('idempotent'))!
      const tn = Array.from(p.childNodes).find((n) => n.nodeType === 3 && n.textContent!.includes('idempotent'))!
      const range = document.createRange()
      const i = tn.textContent!.indexOf('idempotent')
      range.setStart(tn, i)
      range.setEnd(tn, i + 'idempotent'.length)
      const r = range.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await page.mouse.dblclick(box.x, box.y)
    await page.getByTestId('bubble-comment').waitFor({ state: 'visible', timeout: 3000 })
    await page.getByTestId('bubble-comment').click()
    tDraft1 = await composeAndSubmit(page, 'Idempotent across devices too, or per device?', 'question')
    await selectText(page, 'Never lose a note written offline')
    await page.keyboard.press('Meta+Alt+KeyM') // ⌘⌥M = comment on selection
    tDraft2 = await composeAndSubmit(page, 'Too absolute — what about a wiped device?', 'comment')
    const peek = (await (await fetch(`${url}/api/peek`)).json()) as any
    check('review mode: new comments are drafts, no event yet', peek.events.length === 0 && (await page.getByTestId(`thread-${tDraft1}`).getByTestId('draft-tag').count()) === 1)
    check('review mode: "Send 2 to agent" button', (await page.getByTestId('send-review').innerText()).includes('2'))
    await page.screenshot({ path: shot('screenshot-review-drafts.png'), clip: { x: 300, y: 0, width: 1200, height: 1100 } })
    w = waitBg()
    await waitFor(() => badge(page), (t) => !t.includes('not'), 8000)
    await page.getByTestId('send-review').click()
    r = await w.done
    const evs = r.json?.events ?? []
    const rev = evs[0]
    check('review: ONE review_submitted event with both annotations', r.code === 0 && evs.length === 1 && rev?.type === 'review_submitted' && rev?.count === 2, `${evs.length} events, ${rev?.type}`)
    const quotes = (rev?.annotations ?? []).map((a: any) => a.quote).sort()
    check('review: quotes correct (double-click word + selection)', JSON.stringify(quotes) === JSON.stringify(['Never lose a note written offline', 'idempotent']), JSON.stringify(quotes))
    check('review: drafts now marked sent, button gone', (await page.getByTestId('send-review').count()) === 0 && (await storeThread(page, tDraft1))?.sentSeq === rev?.seq)
  }

  // ============================================================ 6. Ask agent (always immediate) + a user reply in a delivered thread
  {
    w = waitBg()
    await waitFor(() => badge(page), (t) => !t.includes('not'), 8000)
    await selectText(page, 'of reconnecting')
    await page.getByTestId('bubble-ask').click()
    const tAsk = await composeAndSubmit(page, 'Is 10 s realistic on 3G?')
    r = await w.done
    const ev = r.json?.events?.[0]
    check('Ask agent: immediate even in review mode, ask=true, kind question', ev?.type === 'annotation_created' && ev?.thread === tAsk && ev?.ask === true && ev?.kind === 'question' && ev?.quote === 'of reconnecting', JSON.stringify({ type: ev?.type, ask: ev?.ask, q: ev?.quote }))
    await collab('reply', tAsk, 'Measured p95 is 6 s on 3G for 200 notes; I will add that as a footnote.')
    w = waitBg()
    const card = page.getByTestId(`thread-${tAsk}`)
    await card.getByTestId('agent-msg').waitFor({ timeout: 5000 })
    await card.click()
    await card.getByTestId('reply-text').fill('Great, do it.')
    await card.getByTestId('reply-submit').click()
    r = await w.done
    const evr = r.json?.events?.[0]
    check('user reply in a delivered thread → annotation_reply event with the history', evr?.type === 'annotation_reply' && evr?.thread === tAsk && evr?.text === 'Great, do it.' && evr?.messages?.length === 3, JSON.stringify({ type: evr?.type, n: evr?.messages?.length }))
  }

  // ============================================================ 7. comment on a whole block (block handle menu) and on an SVG label (island)
  let tBlock = ''
  let tLabel = ''
  {
    await page.getByTestId('mode-now').click()
    const para = page.locator('.tiptap p', { hasText: 'We merge at' })
    await para.scrollIntoViewIfNeeded()
    const pb = (await para.boundingBox())!
    await page.mouse.move(pb.x + 40, pb.y + pb.height / 2)
    await sleep(200)
    await page.getByTestId('bh-grip').click()
    await page.getByTestId('bm-comment').click()
    w = waitBg()
    tBlock = await composeAndSubmit(page, 'Mention the retry backoff here.', 'change')
    r = await w.done
    const ev = r.json?.events?.[0]
    const onlineBid = await bidOf(page, 'We merge at')
    check('block comment: event target=block with the block id and text', ev?.target === 'block' && ev?.block?.id === onlineBid && ev?.quote.startsWith('We merge at'), JSON.stringify({ t: ev?.target, b: ev?.block?.id }))
    check('block comment: node decoration outlines the paragraph', (await page.locator(`.tiptap p.cmt-node[data-thread="${tBlock}"]`).count()) === 1)

    // SVG label: click the label (opens the in-place overlay), then the island's "comment" button
    await page.evaluate(() => document.querySelector('.island[data-island-kind="figure"]')!.scrollIntoView({ block: 'center' }))
    const lb = await page.evaluate(() => {
      const host = document.querySelector('.island[data-island-kind="figure"] .island-host') as HTMLElement
      const el = Array.from(host.shadowRoot!.querySelectorAll('svg text')).find((e) => e.textContent === 'Outbox queue')!
      const rr = el.getBoundingClientRect()
      return { x: rr.x + rr.width / 2, y: rr.y + rr.height / 2 }
    })
    await page.mouse.click(lb.x, lb.y)
    await page.locator('.island[data-island-kind="figure"] .island-host').locator('[data-testid="svg-overlay"]').waitFor({ timeout: 3000 })
    w = waitBg()
    await page.locator('.island[data-island-kind="figure"]').getByTestId('island-comment').click()
    tLabel = await composeAndSubmit(page, 'Call it "Outbox (SQLite)" to match section 3.', 'change')
    r = await w.done
    const evl = r.json?.events?.[0]
    check('label comment: event target=island with the label (leaf path + text)', evl?.target === 'island' && evl?.leaf?.text === 'Outbox queue' && evl?.quote === 'Outbox queue', JSON.stringify({ t: evl?.target, leaf: evl?.leaf }))
    const leafMarked = () =>
      page.evaluate(() => {
        const host = document.querySelector('.island[data-island-kind="figure"] .island-host') as HTMLElement
        return Array.from(host.shadowRoot!.querySelectorAll('.cmt-leaf')).map((e) => e.textContent)
      })
    check('label comment: the label is outlined inside the island (shadow DOM)', JSON.stringify(await leafMarked()) === '["Outbox queue"]', JSON.stringify(await leafMarked()))
    const op = await collab('set-island-text', '>Outbox queue<', '>Outbox (SQLite)<')
    const lm = await waitFor(leafMarked, (x) => x[0] === 'Outbox (SQLite)', 4000)
    check('label comment: agent rewrites the label → thread still anchored, outline follows the label', op.code === 0 && lm[0] === 'Outbox (SQLite)' && !(await threadsCli()).find((t) => t.thread === tLabel)?.orphaned, JSON.stringify(lm))
    await collab('reply', tLabel, 'Renamed the label to "Outbox (SQLite)".')
    await page.getByTestId(`thread-${tLabel}`).getByTestId('agent-msg').waitFor({ timeout: 5000 })
    await page.evaluate(() => document.querySelector('.island[data-island-kind="figure"]')!.scrollIntoView({ block: 'center' }))
    await sleep(400)
    const fb = (await page.locator('.island[data-island-kind="figure"]').boundingBox())!
    await page.screenshot({ path: shot('screenshot-island-comment.png'), clip: { x: 300, y: Math.max(0, fb.y - 330), width: 1200, height: 660 } })
    await collab('resolve', tLabel)
  }

  // ============================================================ 8. orphan: delete the anchored text
  {
    await selectText(page, 'Never lose a note written offline')
    await page.keyboard.press('Backspace')
    const orphan = page.getByTestId(`orphan-${tDraft2}`)
    await orphan.waitFor({ timeout: 4000 })
    check('delete anchored text → thread moves to "Detached" with its quote', (await orphan.innerText()).includes('Never lose a note written offline'))
    const ts = await threadsCli()
    check('orphan: CLI reports orphaned=true (quote kept)', ts.find((t) => t.thread === tDraft2)?.orphaned === true && ts.find((t) => t.thread === tDraft2)?.quote === 'Never lose a note written offline')
  }

  // ============================================================ 9. agent set-block with changes on both sides of a quote → server rescue
  {
    const bid = await bidOf(page, 'The client sends batches')
    const op = await collab('set-block', bid!, '<p>The client sends small batches of operations. Each operation carries a <mark>client-generated id</mark> so retries are idempotent (per device).</p>')
    await sleep(400)
    const h = await highlight(page, tDraft1)
    check('set-block rewrite: anchor lost in the text diff, re-anchored by quote within the block (rescue)', op.json?.rescuedComments?.includes(tDraft1) && h === 'idempotent', JSON.stringify({ rescued: op.json?.rescuedComments, h }))
  }

  // ============================================================ 10. the HTML file stays clean
  await fetch(`${url}/doc/flush`, { method: 'POST' })
  {
    const file = readDoc()
    const ids = [t1, tDraft1, tDraft2, tBlock, tLabel]
    check('saved HTML has no comment markup (no data-thread / data-comment / cmt class / thread ids)', !/data-thread|data-comment|class="[^"]*\bcmt/.test(file) && !ids.some((id) => file.includes(id)))
    check('saved HTML: <mark> count unchanged (comments are not marks)', (file.match(/<mark\b/g) ?? []).length === (original.match(/<mark\b/g) ?? []).length)
    check('saved HTML has the agent edits', file.includes('Outbox (SQLite)') && file.includes('small batches') && file.includes('conflict resolution'))
    const side = JSON.parse(fs.readFileSync(path.join(tmp, '.collab', 'spec.html.comments.json'), 'utf8'))
    check('sidecar .collab/spec.html.comments.json holds every thread', side.threads.length === (await threadsCli()).length, `${side.threads.length} threads`)
    const bytes = fs.statSync(path.join(tmp, '.collab', 'spec.html.comments.json')).size
    observed(`comments.json: ${bytes} B for ${side.threads.length} threads (${Math.round(bytes / side.threads.length)} B/thread, pretty-printed incl. anchors)`)
  }

  // ============================================================ 11. restart: comments restored (ystate sidecar), queue survives
  {
    const before = await threadsCli()
    const hBefore = await highlight(page, tDraft1)
    // an event queued while nobody listens must survive the restart
    await selectText(page, 'Web client support')
    await page.getByTestId('bubble-comment').click()
    const tQueued = await composeAndSubmit(page, 'Should we reconsider web for v1?', 'question')
    await waitFor(async () => ((await (await fetch(`${url}/api/peek`)).json()) as any).events.length, (n) => n > 0, 4000)
    const code = await server.stop()
    check('restart: server stored and exited', code === 0)
    server = await startServer(doc, port)
    await waitFor(() => page.evaluate(() => (window as any).__provider.status), (s) => s === 'connected', 15000)
    await sleep(800)
    const h = await (await fetch(`${url}/health`)).json()
    const after = await threadsCli()
    check('restart: same threads with the same status + anchors', JSON.stringify(after.map((t) => [t.thread, t.status, t.orphaned, t.quote])) === JSON.stringify(before.map((t) => [t.thread, t.status, t.orphaned, t.quote]).concat([[tQueued, 'open', false, 'Web client support']])), `${after.length} threads`)
    check('restart: Y.Doc (incl. comments) loaded from the .ystate sidecar', h.loadedFrom === 'sidecar', h.loadedFrom)
    check('restart: browser reconnected, highlight unchanged', (await highlight(page, tDraft1)) === hBefore)
    r = await collab('wait', '--timeout', '5')
    check('restart: event queued before the restart is delivered after it', r.code === 0 && r.json?.events?.some((e: any) => e.thread === tQueued), `exit ${r.code}`)
  }

  // ============================================================ 12. stale .ystate (file edited while down) → threads re-anchored from comments.json by quote
  {
    await page.close()
    await server.stop()
    fs.writeFileSync(doc, readDoc().replace('>1. Goals<', '>1. Goals and scope<'))
    server = await startServer(doc, port)
    const page2 = await browser.newPage({ viewport: { width: 1500, height: 1100 } })
    page2.on('pageerror', (e) => !viteNoise.test(String(e)) && consoleErrors.push(String(e)))
    await page2.goto(`${url}/?user=Noah`)
    await page2.locator('.tiptap h1').waitFor({ timeout: 15000 })
    await sleep(800)
    const h = await (await fetch(`${url}/health`)).json()
    const ts = await threadsCli()
    check('stale sidecar: Y.Doc rebuilt from HTML, comments restored from comments.json', h.loadedFrom === 'html' && h.comments.restored === ts.length && ts.length >= 6, `restored ${h.comments.restored}, orphaned ${h.comments.restoredOrphaned}`)
    check('stale sidecar: text threads re-anchored by quote, orphan stays orphan', (await highlight(page2, tDraft1)) === 'idempotent' && ts.find((t) => t.thread === tDraft2)?.orphaned === true && ts.find((t) => t.thread === t1)?.quote === 'outbox')
    check('stale sidecar: block + island threads re-anchored (block id / label)', ts.find((t) => t.thread === tBlock)?.orphaned === false && ts.find((t) => t.thread === tLabel)?.orphaned === false)
    await page2.getByTestId('toggle-resolved').click()
    await sleep(300)
    await page2.evaluate(() => window.scrollTo(0, 0))
    await page2.screenshot({ path: shot('screenshot-sidebar.png'), clip: { x: 300, y: 0, width: 1200, height: 1100 } })
    await page2.screenshot({ path: shot('screenshot-full.png'), fullPage: true })
  }

  check('no console errors during the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} catch (e) {
  console.error(e)
  failures++
} finally {
  await browser?.close()
  if (server) await server.stop()
  console.log(`\nserver output (tail):\n${server?.output().split('\n').slice(-10).join('\n') ?? ''}`)
}
console.log(failures === 0 ? `\nALL ${passes} CHECKS PASSED` : `\n${failures} CHECK(S) FAILED (${passes} passed)`)
process.exit(failures === 0 ? 0 : 1)
