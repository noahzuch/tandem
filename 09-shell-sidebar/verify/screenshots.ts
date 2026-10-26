// npm run screenshots — the README images, from the demo project (own server on a free port, temp copy of demo/).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { chromium } from 'playwright'
import { root, startServer } from '../lib/serverProc.ts'
import { SCRIPT } from '../demo/journal-demo.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike09-shots-'))
for (const f of ['spec.html', 'decisions.md', 'banner-mockup.html']) fs.copyFileSync(path.join(root, 'demo', f), path.join(dir, f))
fs.mkdirSync(path.join(dir, '.collab'))
fs.copyFileSync(path.join(root, 'demo/spec.html.shell.json'), path.join(dir, '.collab/spec.html.shell.json'))
const srv = await startServer(path.join(dir, 'spec.html'))
const collab = (...a: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'bin/collab.ts', '--server', srv.url, ...a], { cwd: root, encoding: 'utf8' }).stdout
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 })
  await page.goto(`${srv.url}/?user=Noah&color=%232a7de1`)
  await page.waitForSelector('[data-entry="D-1"]')
  await sleep(800)
  collab('comment', 'mark overlapping edits', 'Should the banner show both versions side by side? See D-5.')
  spawnSync(process.execPath, ['--import', 'tsx', 'bin/collab.ts', '--server', srv.url, 'patch'], {
    cwd: root,
    input: '<<<<<<< SEARCH\nRetry with exponential backoff\n=======\nRetry with exponential backoff (max 5 min)\n>>>>>>> REPLACE\n',
  })
  await sleep(300)
  // scroll the doc to the conflict section, open D-5 from its reference in the spec
  await page.locator('.tiptap h2', { hasText: '4. Conflict handling' }).scrollIntoViewIfNeeded()
  await page.evaluate(() => window.scrollBy(0, 160))
  await page.locator('.tiptap .jref[data-jref="D-5"]').click()
  await sleep(900)
  await page.screenshot({ path: path.join(root, 'screenshot-shell.png') })

  // the agent appends a journal entry (brainstorm skill writes decisions.md) and adds a panel
  fs.writeFileSync(path.join(dir, 'decisions.md'), fs.readFileSync(path.join(dir, 'decisions.md'), 'utf8').replace(/\n## Rejected Approaches/, `\n${SCRIPT[0].text}\n\n${SCRIPT[1].text}\n\n## Rejected Approaches`))
  await page.waitForSelector('[data-entry="D-6"]')
  await page.click('[data-testid="tab-activity"]')
  await sleep(1200)
  await page.screenshot({ path: path.join(root, 'screenshot-live.png') })

  await page.click('[data-testid="sb-collapse-left"]')
  collab('panel', 'open', 'mockup')
  await sleep(800)
  await page.screenshot({ path: path.join(root, 'screenshot-collapsed.png') })
  console.log('wrote screenshot-shell.png, screenshot-live.png, screenshot-collapsed.png')
} finally {
  await browser.close()
  await srv.stop()
  fs.rmSync(dir, { recursive: true, force: true })
}
