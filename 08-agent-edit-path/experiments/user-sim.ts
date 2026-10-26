// The "user" for spike 08's experiment: a headless browser that keeps typing into the live document at human speed
// while the agent (Claude Code, for real) edits it. Every sentence carries a marker (u01, u02, …) so that
// experiments/check-loss.ts can tell afterwards whether any typed text was lost.
//
//   npm run user-sim -- [--url http://127.0.0.1:5108] [--minutes 20] [--log .work/user-sim.jsonl]
//                       [--delay 110] [--gap 2500] [--comment]          (--comment: first create one change request)
//
// Stops after --minutes, or as soon as the file `<log>.stop` exists (touch it), and always closes the browser.
// Writes its pid to `<log>.pid`.
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const opt = (n: string, d: string) => {
  const i = args.indexOf(n)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d
}
const url = opt('--url', 'http://127.0.0.1:5108').replace(/\/$/, '')
const minutes = Number(opt('--minutes', '20'))
const logPath = path.resolve(opt('--log', '.work/user-sim.jsonl'))
const delay = Number(opt('--delay', '110'))
const gap = Number(opt('--gap', '2500'))
const stopFile = `${logPath}.stop`
fs.mkdirSync(path.dirname(logPath), { recursive: true })
fs.rmSync(stopFile, { force: true })
fs.writeFileSync(`${logPath}.pid`, String(process.pid))
fs.writeFileSync(logPath, '')
const log = (o: Record<string, unknown>) => fs.appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n')

// where the user types: several sections, including the blocks the agent's tasks touch
const ANCHORS = [
  'Sync completes within', // T1 rewords this list item
  'Field technicians lose connectivity', // T8 edits this paragraph (comment)
  'Never lose a note written offline', // T2 inserts after this item
  'Stale base version', // T3 adds a row to this table
  'We merge at', // T7 moves this section
  'Saves are appended to the', // T5 renames a term in this paragraph
  'The client sends batches', // API section (T7)
  'Full-document sync was rejected', // appendix, untouched
]
const SENTENCES = [
  'Ops wants this confirmed before the pilot',
  'Check this against the field interviews',
  'Pat thinks this is too strict for v1',
  'Needs a number from the load test',
  'Mention the battery budget here',
  'Ask legal whether notes count as records',
  'This came up twice in the interviews',
  'Keep it short, the ops lead reads this on a phone',
]

const deadline = Date.now() + minutes * 60_000
const browser = await chromium.launch()
let n = 0
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  await page.goto(`${url}/?user=Noah`)
  await page.waitForFunction(() => (window as any).__editor && (window as any).__provider?.synced !== false, null, { timeout: 20000 })
  await page.waitForTimeout(800)
  log({ event: 'start', url, minutes, delay, gap })

  if (args.includes('--comment')) {
    // the user asks for a change through the real UI (selection → bubble → Comment → kind "change")
    await page.getByTestId('mode-now').click()
    await page.evaluate((s) => {
      const ed = (window as any).__editor
      let from = -1
      ed.state.doc.descendants((nd: any, p: number) => {
        if (from >= 0 || !nd.isText) return
        const i = nd.text.indexOf(s)
        if (i >= 0) from = p + i
      })
      ed.commands.setTextSelection({ from, to: from + s.length })
      ed.view.focus()
    }, 'on site')
    await page.getByTestId('bubble-comment').click()
    await page.getByTestId('composer').waitFor({ timeout: 3000 })
    await page.getByTestId('kind-change').click()
    await page.getByTestId('composer-text').fill('Which sites? Name the typical ones (basements, rural areas).')
    await page.getByTestId('composer-submit').click()
    await page.getByTestId('composer').waitFor({ state: 'detached', timeout: 3000 })
    const id = await page.evaluate(() => (window as any).__comments.store.active as string)
    log({ event: 'comment', thread: id, quote: 'on site' })
    await page.waitForTimeout(1000)
  }

  while (Date.now() < deadline && !fs.existsSync(stopFile)) {
    n++
    const marker = `u${String(n).padStart(2, '0')}`
    const anchor = ANCHORS[(n - 1) % ANCHORS.length]
    const sentence = ` ${SENTENCES[(n - 1) % SENTENCES.length]} (${marker}).`
    // caret at the end of the textblock that contains the anchor (or a random paragraph if the agent removed it)
    const where = await page.evaluate((a) => {
      const ed = (window as any).__editor
      let end = -1
      let found = false
      const blocks: number[] = []
      ed.state.doc.descendants((nd: any, p: number) => {
        if (!nd.isTextblock) return
        if (nd.textContent.length > 20) blocks.push(p + nd.nodeSize - 1)
        if (end < 0 && nd.textContent.includes(a)) {
          end = p + nd.nodeSize - 1
          found = true
        }
        return false
      })
      if (end < 0) end = blocks[Math.floor(Math.random() * blocks.length)]
      ed.commands.setTextSelection(end)
      ed.view.focus()
      const dom = ed.view.domAtPos(end).node
      ;(dom.nodeType === 1 ? dom : dom.parentElement).scrollIntoView({ block: 'center' })
      return { found, pos: end }
    }, anchor)
    const t0 = Date.now()
    await page.keyboard.type(sentence, { delay })
    log({ event: 'typed', n, marker, anchor, anchorFound: where.found, typed: sentence, ms: Date.now() - t0 })
    await page.waitForTimeout(gap + Math.round(Math.random() * gap * 0.6))
  }
  // give the provider a moment to sync the last keystrokes
  await page.waitForTimeout(1500)
  const text = await page.evaluate(() => (window as any).__editor.state.doc.textBetween(0, (window as any).__editor.state.doc.content.size, '\n', '￼'))
  log({ event: 'stop', sentences: n, finalText: text })
} catch (e) {
  log({ event: 'error', error: String((e as Error).stack ?? e) })
} finally {
  await browser.close()
  fs.rmSync(`${logPath}.pid`, { force: true })
}
