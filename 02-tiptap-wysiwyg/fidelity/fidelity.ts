// npm run fidelity — measure what an HTML -> Tiptap -> HTML round trip keeps, alters and drops.
//
// For every ../samples/*.html:
//   * split into shell (<head> …) + body; the editor only sees the body (what the app does)
//   * round-trip the body through three converters: real editor in Chromium (Playwright),
//     @tiptap/html/server (happy-dom), and the same ProseMirror pipeline on jsdom
//   * probe ~60 constructs (kept / altered / dropped), tag census, lost words
//   * idempotence: pass1 == pass2 == pass3 ?
//   * naive mode: what happens if the FULL file (with <head>) is fed to the editor
//   * pretty-printing: does prettier output survive a reload unchanged; diff size of a 1-word edit
// Writes fidelity/report.md (+ raw outputs in fidelity/out/) and prints the report.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { root, startServer } from '../lib/serverProc.ts'
import { splitDocument, formatBody } from '../lib/htmlDoc.ts'
import { browser as browserConv, happyDom, jsdom, type Converter, type RoundTrip } from './converters.ts'
import { probe, lostWords, tagCensus, countComments, attrCensus, type ProbeResult } from './analyze.ts'

const samplesDir = path.resolve(root, '../samples')
const outDir = path.join(root, 'fidelity/out')
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

const samples = fs
  .readdirSync(samplesDir)
  .filter((f) => f.endsWith('.html'))
  .sort((a, b) => (a === 'spec.html' ? -1 : b === 'spec.html' ? 1 : a.localeCompare(b)))

// ------------------------------------------------------------ helpers
/** number of changed lines (deleted + inserted) between two texts, via LCS */
function lineDiff(a: string, b: string): { changed: number; bytes: number } {
  const x = a.split('\n')
  const y = b.split('\n')
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1))
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  let i = 0, j = 0, changed = 0, bytes = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { i++; j++ }
    else if (j < y.length && (i === x.length || dp[i][j + 1] >= dp[i + 1][j])) { changed++; bytes += y[j].length; j++ }
    else { changed++; bytes += x[i].length; i++ }
  }
  return { changed, bytes }
}

function firstDiff(a: string, b: string): string {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  const s = Math.max(0, i - 30)
  return `…${a.slice(s, i + 50)}…  vs  …${b.slice(s, i + 50)}…`.replace(/\n/g, '⏎')
}

const md: string[] = []
const log = (s = '') => md.push(s)
const code = (s: string) => s.replace(/`/g, "'").replace(/\n/g, ' ')
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ------------------------------------------------------------ browser
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike02-fid-'))
fs.writeFileSync(path.join(tmp, 'blank.html'), '<!doctype html><html><head></head><body><p></p></body></html>')
const server = await startServer(path.join(tmp, 'blank.html'))
const chrome = await chromium.launch()
let exitCode = 0
try {
  const page = await chrome.newPage()
  await page.goto(server.url)
  await page.waitForFunction(() => (window as any).__editor?.isInitialized !== false && !!(window as any).__editor?.commands)
  const converters: Record<string, Converter> = { browser: browserConv(page), happyDom, jsdom }

  const summary: { sample: string; kept: number; altered: number; dropped: number; words: string; idem: string; modes: string }[] = []
  const perSample: string[] = []

  for (const sample of samples) {
    const full = fs.readFileSync(path.join(samplesDir, sample), 'utf8')
    const { body, before } = splitDocument(full)
    const base = sample.replace(/\.html$/, '')
    const sec: string[] = []
    const w = (s = '') => sec.push(s)

    // round trips per converter
    const passes: Record<string, RoundTrip[]> = {}
    for (const [name, conv] of Object.entries(converters)) {
      const p1 = await conv(body)
      const p2 = await conv(p1.html)
      const p3 = await conv(p2.html)
      passes[name] = [p1, p2, p3]
      fs.writeFileSync(path.join(outDir, `${base}.${name}.html`), p1.html)
    }
    const real = passes.browser
    fs.writeFileSync(path.join(outDir, `${base}.browser.pretty.html`), await formatBody(real[0].html))

    // probes on the real editor's output
    const results = probe(body, real[0].html)
    const count = (s: string) => results.filter((r) => r.status === s).length
    const lw = lostWords(body, real[0].html)

    // idempotence
    const idem = Object.entries(passes).map(([name, [p1, p2, p3]]) => ({
      name,
      p12: p1.html === p2.html,
      p23: p2.html === p3.html,
      json12: JSON.stringify(p1.json) === JSON.stringify(p2.json),
      diff12: p1.html === p2.html ? '' : firstDiff(p1.html, p2.html),
    }))
    const idemOk = idem.every((r) => r.p23)
    // converter agreement
    const modeDiffs = ['happyDom', 'jsdom'].map((m) => ({
      m,
      same: passes[m][0].html === real[0].html,
      json: JSON.stringify(passes[m][0].json) === JSON.stringify(real[0].json),
      diff: passes[m][0].html === real[0].html ? '' : firstDiff(real[0].html, passes[m][0].html),
      probeDelta: probe(body, passes[m][0].html)
        .filter((r, i) => {
          const b = results.find((x) => x.construct === r.construct)
          return !b || b.status !== r.status || b.how !== r.how
        })
        .map((r) => `${r.construct}: ${r.how}`),
    }))

    summary.push({
      sample,
      kept: count('kept'),
      altered: count('altered'),
      dropped: count('dropped'),
      words: `${lw.total - lw.lost.length}/${lw.total}`,
      idem: idem.map((r) => `${r.name} ${r.p12 ? '1st' : r.p23 ? '2nd' : 'NO'}`).join(', '),
      modes: modeDiffs.map((d) => `${d.m}: ${d.same ? 'same' : 'differs'}`).join(', '),
    })

    w(`### ${sample}`)
    w()
    w(`Probed ${results.length} constructs (real editor in Chromium): **${count('kept')} kept, ${count('altered')} altered, ${count('dropped')} dropped**. ` +
      `Words of text kept: ${lw.total - lw.lost.length}/${lw.total}` + (lw.lost.length ? ` (lost: ${lw.lost.slice(0, 20).join(' ')})` : '') + '.')
    w()
    w('| construct | result | how |')
    w('|---|---|---|')
    for (const r of results) w(`| ${cell(r.construct)} | ${r.status} | ${cell(r.how)} |`)
    w()

    // source formatting / comments / size
    const inLines = body.split('\n').length
    const outLines = real[0].html.split('\n').length
    const pretty = await formatBody(real[0].html)
    w(`**Source formatting:** body ${inLines} lines → ${outLines} line(s) (${real[0].html.length} chars, ${outLines === 1 ? 'one single line — all indentation/line breaks lost' : 'line breaks only inside <pre>'}); ` +
      `comments ${countComments(body)} → ${countComments(real[0].html)}; attributes ${attrCensus(body)} → ${attrCensus(real[0].html)}. ` +
      `Prettier output: ${pretty.split('\n').length} lines.`)
    w()

    // idempotence
    w('**Idempotence** (HTML→Tiptap→HTML repeated):')
    w()
    for (const r of idem)
      w(`- ${r.name}: pass1→pass2 ${r.p12 ? 'identical' : 'CHANGED'}${r.diff12 ? ` (\`${code(r.diff12)}\`)` : ''}; pass2→pass3 ${r.p23 ? 'identical' : 'CHANGED'}; JSON pass1 vs pass2 ${r.json12 ? 'identical' : 'different'}`)
    w()

    // converter agreement
    w('**Converters vs. real editor:**')
    w()
    for (const d of modeDiffs)
      w(`- ${d.m}: HTML ${d.same ? 'identical' : 'differs'}, JSON ${d.json ? 'identical' : 'differs'}` +
        (d.diff ? ` — first diff: \`${code(d.diff)}\`` : '') +
        (d.probeDelta.length ? `; probe differences: ${d.probeDelta.map(cell).join('; ')}` : ''))
    w()

    // naive full file
    const naive = await converters.browser(full)
    const title = /<title>([^<]*)<\/title>/i.exec(before)?.[1] ?? ''
    const cssSnippet = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(before)?.[1].trim().slice(0, 20) ?? ''
    const naiveBodyOnly = naive.html === real[0].html
    w(`**Naive mode (whole file incl. \`<head>\` given to setContent):** ` +
      `doctype/html/head/meta/title/style elements in output: ${/<(title|style|meta|head)\b/i.test(naive.html) ? 'yes' : 'none'}; ` +
      `title text leaked into body: ${title && naive.html.includes(title) && !real[0].html.startsWith(`<h1>${title}`) ? 'YES' : title ? (naive.html.split(title).length - 1 > real[0].html.split(title).length - 1 ? 'YES' : 'no') : 'n/a'}; ` +
      `CSS text leaked: ${cssSnippet && naive.html.includes(cssSnippet) ? 'YES' : 'no'}; ` +
      `result equals body-only round trip: ${naiveBodyOnly ? 'yes' : 'no'}. → \`<head>\` is silently discarded, so the server must keep it.`)
    w()

    // pretty printing
    const rtPretty = await converters.browser(pretty)
    const edited = await converters.browser(real[0].html.replace(/(<p>[^<]{12,}?) (\S+)/, '$1 EDITED'))
    const rawDiff = lineDiff(real[0].html, edited.html)
    const prettyDiff = lineDiff(pretty, await formatBody(edited.html))
    const prettyStable = (await formatBody(rtPretty.html)) === pretty
    w(`**Pretty-printing:** prettier(output) → editor → HTML ${rtPretty.html === real[0].html ? 'equals the unformatted output (whitespace from formatting is absorbed)' : `differs: \`${code(firstDiff(real[0].html, rtPretty.html))}\``}; ` +
      `format→load→save→format ${prettyStable ? 'is a fixed point' : 'is NOT stable'}. ` +
      `One-word edit: raw diff = ${rawDiff.changed} changed lines / ${rawDiff.bytes} chars; pretty diff = ${prettyDiff.changed} changed lines / ${prettyDiff.bytes} chars.`)
    w()

    // tag census
    w('<details><summary>Tag census (input → output)</summary>')
    w()
    w('| tag | in | out |')
    w('|---|---|---|')
    for (const t of tagCensus(body, real[0].html)) w(`| \`${t.tag}\` | ${t.inp} | ${t.out}${t.out === 0 ? ' (gone)' : t.inp === 0 ? ' (added)' : ''} |`)
    w()
    w('</details>')
    w()
    perSample.push(sec.join('\n'))
  }

  log('# Fidelity report (generated by `npm run fidelity`)')
  log()
  log(`Tiptap ${JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@tiptap/core/package.json'), 'utf8')).version}, extensions from \`src/extensions.ts\`. ` +
    'Input = body only (the server keeps `<head>`). "kept" = same element/attribute/text; "altered" = content survives in another form; "dropped" = gone.')
  log()
  log('| sample | kept | altered | dropped | words kept | stable after pass (per converter) | Node converters vs. real editor |')
  log('|---|---|---|---|---|---|---|')
  for (const s of summary) log(`| ${s.sample} | ${s.kept} | ${s.altered} | ${s.dropped} | ${s.words} | ${s.idem} | ${s.modes} |`)
  log()
  for (const s of perSample) log(s)
} catch (e) {
  console.error(e)
  exitCode = 1
} finally {
  await chrome.close()
  server.proc.kill('SIGTERM')
  fs.rmSync(tmp, { recursive: true, force: true })
}

const report = md.join('\n')
fs.writeFileSync(path.join(root, 'fidelity/report.md'), report + '\n')
console.log(report)
console.log(`\nwritten: fidelity/report.md, fidelity/out/*.html`)
process.exit(exitCode)
