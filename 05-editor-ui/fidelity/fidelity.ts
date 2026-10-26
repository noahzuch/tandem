// npm run fidelity — measure what an HTML -> Tiptap -> HTML round trip keeps, normalises, alters, drops.
//
// For every ../samples/*.html (body only — the server keeps <head>):
//   * BEFORE = spike 02's schema (fidelity/baselineExtensions.ts, ProseMirror on jsdom — identical to
//     the real editor for these samples per spike 02)
//   * AFTER  = spike 04 in the real editor (headless Chromium): prepareForEditor → setContent → getHTML →
//     expandIslands; cross-checked with @tiptap/html/server (happy-dom) and jsdom
//   * probes per construct, idempotence (pass1 == pass2 == pass3), island byte-exactness,
//     the prettier path (format with placeholders → expand), diff size of a one-word edit
//   * "agent wrote something odd" cases: stray inline markup at top level, broken nesting, …
// Writes fidelity/report.md (+ raw outputs in fidelity/out/) and prints the report.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { root, startServer } from '../lib/serverProc.ts'
import { splitDocument, formatBody } from '../lib/htmlDoc.ts'
import { browser as browserConv, happyDom, jsdom, baseline, type Converter, type RoundTrip } from './converters.ts'
import { probe, lostWords, tagCensus, countComments, attrCensus, islandSources, type ProbeResult } from './analyze.ts'
import { expandIslands } from '../src/islands/raw.ts'
import { prepareForEditor } from '../src/islands/source.ts'

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
const code = (s: string) => s.replace(/`/g, "'").replace(/\n/g, '⏎')
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const STATUSES = ['kept', 'normalised', 'altered', 'dropped'] as const
const counts = (r: ProbeResult[]) => Object.fromEntries(STATUSES.map((s) => [s, r.filter((x) => x.status === s).length])) as Record<(typeof STATUSES)[number], number>

/** prettier path exactly like the server: format the placeholder HTML, then expand */
const prettyPath = async (rt: RoundTrip) => expandIslands(await formatBody(rt.raw))

// "agent wrote HTML the schema can't hold" — run through the real editor
const ODD_CASES: [string, string][] = [
  ['stray inline markup at top level', '<b>Bold</b> loose text <i>italic</i> <a href="#x">link</a><p>Then a paragraph.</p>'],
  ['unclosed tags', '<p>one<p>two<ul><li>a<li>b</ul>tail'],
  ['inline element wrapping blocks', '<span class="note"><p>Para A</p><p>Para B</p></span>'],
  ['block inside a link', '<a href="#x"><div>block in link</div></a>'],
  ['text directly in <ul>', '<ul>stray text<li>item</li></ul>'],
  ['text directly in <table>', '<table><tr><td>a</td></tr>stray</table>'],
  ['unknown element with prose inside', '<x-card data-v="1"><h2>Card title</h2><p>Card body.</p></x-card>'],
  ['div mixing inline + block', '<div class="box">intro <em>text</em><p>para</p>outro</div>'],
  ['svg inside a heading', '<h2 id="h">Title <svg width="10" height="10"><circle cx="5" cy="5" r="4"/></svg></h2>'],
  ['<style> + <script> + comment between list items', '<style>.x{color:red}</style><ul><li>a</li><!-- note --><li>b</li></ul><script>alert(1)</script>'],
  ['img with onerror + javascript: link', '<p><img src="x" onerror="alert(1)"> <a href="javascript:alert(1)">js</a></p>'],
]

// ------------------------------------------------------------ browser
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike04-fid-'))
fs.writeFileSync(path.join(tmp, 'blank.html'), '<!doctype html><html><head></head><body><p></p></body></html>')
const server = await startServer(path.join(tmp, 'blank.html'))
const chrome = await chromium.launch()
let exitCode = 0
try {
  const page = await chrome.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.goto(server.url)
  await page.waitForFunction(() => !!(window as any).__editor?.commands && !!(window as any).__islands)
  const converters: Record<string, Converter> = { browser: browserConv(page), happyDom, jsdom }

  const summary: string[] = []
  const perSample: string[] = []
  const constructMatrix = new Map<string, { before: string; after: string; how: string }>()

  for (const sample of samples) {
    const full = fs.readFileSync(path.join(samplesDir, sample), 'utf8')
    const { body } = splitDocument(full)
    const base = sample.replace(/\.html$/, '')
    const sec: string[] = []
    const w = (s = '') => sec.push(s)

    // round trips per converter
    const passes: Record<string, RoundTrip[]> = {}
    for (const [name, conv] of Object.entries({ ...converters, baseline })) {
      const p1 = await conv(body)
      const p2 = await conv(p1.html)
      const p3 = await conv(p2.html)
      passes[name] = [p1, p2, p3]
      fs.writeFileSync(path.join(outDir, `${base}.${name}.html`), p1.html)
    }
    const real = passes.browser
    const pretty = await prettyPath(real[0])
    fs.writeFileSync(path.join(outDir, `${base}.browser.pretty.html`), pretty)

    const after = probe(body, real[0].html)
    const before = probe(body, passes.baseline[0].html)
    const ca = counts(after)
    const cb = counts(before)
    const lwA = lostWords(body, real[0].html)
    const lwB = lostWords(body, passes.baseline[0].html)
    const sources = islandSources(body)
    const exact = sources.filter((s) => real[0].html.includes(s)).length
    const exactPretty = sources.filter((s) => pretty.includes(s)).length
    const stab = (name: string) => {
      const [p1, p2, p3] = passes[name]
      return p1.html === p2.html ? '1st' : p2.html === p3.html ? '2nd' : 'NO'
    }
    summary.push(
      `| ${sample} | ${after.length} | ${cb.kept} / ${cb.normalised} / ${cb.altered} / ${cb.dropped} | **${ca.kept} / ${ca.normalised} / ${ca.altered} / ${ca.dropped}** | ` +
        `${lwB.total - lwB.lost.length}/${lwB.total} → ${lwA.total - lwA.lost.length}/${lwA.total} | ${attrCensus(passes.baseline[0].html)} → ${attrCensus(real[0].html)} of ${attrCensus(body)} | ` +
        `${exact}/${sources.length} (pretty: ${exactPretty}/${sources.length}) | ${stab('baseline')} → ${stab('browser')} |`,
    )

    for (const r of after) {
      const b = before.find((x) => x.construct === r.construct)
      const key = r.construct
      const prev = constructMatrix.get(key)
      const entry = { before: b?.status ?? '–', after: r.status, how: r.how }
      if (!prev || (prev.after === 'kept' && r.status !== 'kept')) constructMatrix.set(key, entry)
    }

    w(`### ${sample}`)
    w()
    w(`Probed ${after.length} constructs. **Before (spike 02 schema): ${cb.kept} kept, ${cb.normalised} normalised, ${cb.altered} altered, ${cb.dropped} dropped. ` +
      `After (spike 04, real editor): ${ca.kept} kept, ${ca.normalised} normalised, ${ca.altered} altered, ${ca.dropped} dropped.** ` +
      `Words of text kept: ${lwA.total - lwA.lost.length}/${lwA.total}` + (lwA.lost.length ? ` (lost: ${lwA.lost.slice(0, 20).join(' ')})` : '') + '. ' +
      `Islands: ${sources.length} (${sources.map((s) => /^<!--/.test(s) ? 'comment' : /^<([\w-]+)/.exec(s)?.[1]).join(', ')}), byte-identical in output: ${exact}/${sources.length}, after prettier: ${exactPretty}/${sources.length}.`)
    w()
    w('| construct | before | after | how (after) |')
    w('|---|---|---|---|')
    for (const r of after) w(`| ${cell(r.construct)} | ${before.find((x) => x.construct === r.construct)?.status ?? '–'} | **${r.status}** | ${cell(r.how)} |`)
    w()

    // idempotence + converters
    w('**Idempotence** (HTML→Tiptap→HTML repeated):')
    w()
    for (const [name, [p1, p2, p3]] of Object.entries(passes))
      w(`- ${name}: pass1→pass2 ${p1.html === p2.html ? 'identical' : `CHANGED (\`${code(firstDiff(p1.html, p2.html))}\`)`}; pass2→pass3 ${p2.html === p3.html ? 'identical' : 'CHANGED'}; JSON pass1 vs pass2 ${JSON.stringify(p1.json) === JSON.stringify(p2.json) ? 'identical' : 'different'}`)
    w()
    w('**Node converters vs. real editor:** ' + ['happyDom', 'jsdom'].map((m) => {
      const same = passes[m][0].html === real[0].html
      return `${m}: HTML ${same ? 'identical' : `differs (\`${code(firstDiff(real[0].html, passes[m][0].html))}\`)`}, JSON ${JSON.stringify(passes[m][0].json) === JSON.stringify(real[0].json) ? 'identical' : 'differs'}`
    }).join('; '))
    w()

    // pretty printing
    const reloaded = await converters.browser(pretty)
    const prettyStable = (await prettyPath(reloaded)) === pretty
    const edited = await converters.browser(real[0].html.replace(/(<p>[^<]{12,}?) (\S+)/, '$1 EDITED'))
    const rawDiff = lineDiff(real[0].html, edited.html)
    const prettyDiff = lineDiff(pretty, await prettyPath(edited))
    w(`**Pretty-printing (server path: prettier on placeholders, then expand):** format→load→save→format ${prettyStable ? 'is a fixed point' : `is NOT stable (\`${code(firstDiff(pretty, await prettyPath(reloaded)))}\`)`}; ` +
      `one-word edit: raw diff = ${rawDiff.changed} changed lines / ${rawDiff.bytes} chars; pretty diff = ${prettyDiff.changed} changed lines / ${prettyDiff.bytes} chars. ` +
      `Comments ${countComments(body)} → ${countComments(real[0].html)}; attributes ${attrCensus(body)} → ${attrCensus(real[0].html)}.`)
    w()
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

  // odd agent HTML
  const odd: string[] = []
  odd.push('| case | input | output (real editor, islands expanded) | islands | stable |')
  odd.push('|---|---|---|---|---|')
  for (const [name, input] of ODD_CASES) {
    const p1 = await converters.browser(input)
    const p2 = await converters.browser(p1.html)
    const st = prepareForEditor(input).stats
    odd.push(`| ${name} | \`${code(input)}\` | \`${code(p1.html)}\` | ${st.blockIslands}b/${st.inlineIslands}i/${st.comments}c | ${p1.html === p2.html ? 'yes' : 'no'} |`)
  }

  log('# Fidelity report (generated by `npm run fidelity`)')
  log()
  log(`Tiptap ${JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@tiptap/core/package.json'), 'utf8')).version}. Input = body only (the server keeps \`<head>\`). ` +
    '**before** = spike 02 schema (`fidelity/baselineExtensions.ts`), **after** = spike 04 (`src/extensions.ts` + islands) in the real editor. ' +
    'Status per construct: kept / normalised (harmless or by policy) / altered (lossy) / dropped.')
  log()
  log('| sample | constructs | before: kept / norm. / altered / dropped | after: kept / norm. / altered / dropped | words kept before → after | attributes before → after | islands byte-identical | stable after pass (before → after) |')
  log('|---|---|---|---|---|---|---|---|')
  for (const s of summary) log(s)
  log()
  log('## All constructs (worst result over the samples)')
  log()
  log('| construct | before | after | how |')
  log('|---|---|---|---|')
  for (const [k, v] of constructMatrix) log(`| ${cell(k)} | ${v.before} | **${v.after}** | ${cell(v.how)} |`)
  log()
  log('## HTML the schema cannot hold as nodes (agent-written oddities)')
  log()
  for (const l of odd) log(l)
  log()
  log('## Per sample')
  log()
  for (const s of perSample) log(s)
  if (pageErrors.length) {
    log(`Page errors during the run: ${pageErrors.join(' | ')}`)
    exitCode = 1
  }
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
