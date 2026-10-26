// Format comparison: HTML (A) vs ProseMirror JSON (B: getJSON(), Bmin: defaults stripped) vs Yjs state (C)
// vs hybrid (D: HTML on disk + Yjs sidecar). Applies the 4 agent edits, writes all before/after files to
// out/edits/, measures edit size / diff size / file size / speed, and writes out/summary.json + out/report.html.
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import * as Y from 'yjs'
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import {
  canonicalHtml, loadHtml, saveHtml, toJsonFile, loadJsonFile, toYDoc, loadYState, schema, Y_FRAGMENT,
} from '../lib/pipeline.ts'
import { EDITS, applyEdit } from '../lib/edits.ts'
import { agentEdit, proneness, unifiedDiff, signalRatio, timeIt, tokens, type MinimalEdit, type Proneness, type DiffStats } from '../lib/metrics.ts'
import { renderReport } from '../lib/report.ts'
import { runMistakes, type MistakeResult } from './check-json.ts'
import { runYjsExperiment, type Scenario } from './yjs-experiment.ts'

export const FORMATS = ['html', 'json', 'json-min'] as const
export type TextFormat = (typeof FORMATS)[number]

export interface EditResult {
  id: string
  title: string
  perFormat: Record<TextFormat, { edit: MinimalEdit; prone: Proneness; diff: DiffStats; before: string; after: string }>
  /** HTML: how much the next editor save changes the agent-written file (prettier/normalisation churn) */
  htmlSaveChurn: { added: number; removed: number }
  /** the agent's change survives a load/save round trip exactly as written (modulo formatting) */
  htmlStableAfterSave: boolean
  yjs: { incrementalUpdateBytes: number; stateBytesAfter: number; fullReplaceUpdateBytes: number; equalsTarget: boolean }
}

export interface Summary {
  sample: string
  sizes: Record<string, { bytes: number; gzip: number }>
  signalRatio: Record<string, number>
  speedMs: Record<string, { load: number; save: number }>
  yjsGrowth: { typedChars: number; gcOn: number; gcOff: number; initial: number }
  /** updateYFragment with an UNCHANGED document still emits this many bytes (object attrs re-set) */
  yjsNoopUpdateBytes: number
  edits: EditResult[]
  mistakes: MistakeResult[]
  yjsScenarios: Scenario[]
}

const write = (p: string, s: string | Uint8Array) => writeFileSync(p, s)

export async function runCompare(samplePath = 'samples/spec.html', outDir = 'out'): Promise<Summary> {
  const src = readFileSync(samplePath, 'utf8')
  const before = await canonicalHtml(src)
  const loadedBefore = loadHtml(before)
  const beforeText: Record<TextFormat, string> = {
    html: before,
    json: toJsonFile(loadedBefore, false),
    'json-min': toJsonFile(loadedBefore, true),
  }
  rmSync(`${outDir}/edits`, { recursive: true, force: true })
  const ext: Record<TextFormat, string> = { html: 'html', json: 'json', 'json-min': 'min.json' }
  // one shared "before" per format (all edits start from the same canonical file)
  mkdirSync(`${outDir}/edits`, { recursive: true })
  for (const f of FORMATS) write(`${outDir}/edits/before.${ext[f]}`, beforeText[f])
  write(`${outDir}/edits/before.ystate`, Y.encodeStateAsUpdate(toYDoc(loadedBefore)))

  // ------------------------------------------------------------ edits
  const edits: EditResult[] = []
  for (const e of EDITS) {
    const dir = `${outDir}/edits/${e.id}`
    mkdirSync(dir, { recursive: true })
    const agentHtml = applyEdit(before, e)
    const loadedAfter = loadHtml(agentHtml)
    const savedHtml = await saveHtml(loadedAfter)
    const afterText: Record<TextFormat, string> = {
      html: agentHtml,
      json: toJsonFile(loadedAfter, false),
      'json-min': toJsonFile(loadedAfter, true),
    }
    const perFormat = {} as EditResult['perFormat']
    for (const f of FORMATS) {
      write(`${dir}/after.${ext[f]}`, afterText[f])
      const edit = agentEdit(beforeText[f], afterText[f])
      const diff = unifiedDiff(`spec.${ext[f]}`, beforeText[f], afterText[f])
      write(`${dir}/${f}.patch`, diff.patch)
      write(`${dir}/${f}.agent-edit.txt`, `--- old_string ---\n${edit.old}\n--- new_string ---\n${edit.new}\n`)
      perFormat[f] = { edit, prone: proneness(edit.new), diff, before: beforeText[f], after: afterText[f] }
    }
    write(`${dir}/after.saved.html`, savedHtml)
    const churn = unifiedDiff('spec.html', agentHtml, savedHtml)
    write(`${dir}/html-save-churn.patch`, churn.patch)
    // stable = re-loading the saved file gives the same document as the agent's file
    const htmlStableAfterSave = loadHtml(savedHtml).doc.eq(loadedAfter.doc)

    // Yjs: server holds a Y.Doc of "before"; the agent's file change is applied as a diff (updateYFragment)
    const ydoc = toYDoc(loadedBefore)
    const sv = Y.encodeStateVector(ydoc)
    const frag = ydoc.getXmlFragment(Y_FRAGMENT)
    updateYFragment(ydoc, frag, loadedAfter.doc, { mapping: new Map(), isOMark: new Map() })
    const inc = Y.encodeStateAsUpdate(ydoc, sv)
    const equalsTarget = yXmlFragmentToProseMirrorRootNode(frag, schema).eq(loadedAfter.doc)
    write(`${dir}/after.ystate`, Y.encodeStateAsUpdate(ydoc))
    // naive alternative: rebuild the fragment from scratch (delete all + insert all)
    const naive = toYDoc(loadedBefore)
    const sv2 = Y.encodeStateVector(naive)
    const nf = naive.getXmlFragment(Y_FRAGMENT)
    naive.transact(() => {
      nf.delete(0, nf.length)
      const tmp = toYDoc(loadedAfter).getXmlFragment(Y_FRAGMENT)
      nf.insert(0, tmp.toArray().map((n) => (n as Y.XmlElement).clone()))
    })
    const fullReplaceUpdateBytes = Y.encodeStateAsUpdate(naive, sv2).length

    edits.push({
      id: e.id,
      title: e.title,
      perFormat,
      htmlSaveChurn: { added: churn.added, removed: churn.removed },
      htmlStableAfterSave,
      yjs: { incrementalUpdateBytes: inc.length, stateBytesAfter: Y.encodeStateAsUpdate(ydoc).length, fullReplaceUpdateBytes, equalsTarget },
    })
  }

  // ------------------------------------------------------------ sizes
  const yState = Y.encodeStateAsUpdate(toYDoc(loadedBefore))
  const sz = (b: string | Uint8Array) => ({ bytes: Buffer.byteLength(b as any), gzip: gzipSync(b).length })
  const sizes: Summary['sizes'] = {
    html: sz(before),
    json: sz(beforeText.json),
    'json-min': sz(beforeText['json-min']),
    yjs: sz(yState),
    'hybrid (html + yjs sidecar)': { bytes: sz(before).bytes + sz(yState).bytes, gzip: sz(before).gzip + sz(yState).gzip },
  }
  const plain = loadedBefore.doc.textBetween(0, loadedBefore.doc.content.size, ' ', ' ')
  const signal: Summary['signalRatio'] = {
    html: signalRatio(before, plain),
    json: signalRatio(beforeText.json, plain),
    'json-min': signalRatio(beforeText['json-min'], plain),
  }

  // ------------------------------------------------------------ speed (median of 20, warm)
  const N = 20
  const speedMs: Summary['speedMs'] = {
    'html (prettier)': { load: await timeIt(N, () => loadHtml(before)), save: await timeIt(N, () => saveHtml(loadedBefore, true)) },
    'html (no prettier)': { load: await timeIt(N, () => loadHtml(before)), save: await timeIt(N, () => saveHtml(loadedBefore, false)) },
    json: { load: await timeIt(N, () => loadJsonFile(beforeText.json)), save: await timeIt(N, () => toJsonFile(loadedBefore, false)) },
    'json-min': { load: await timeIt(N, () => loadJsonFile(beforeText['json-min'])), save: await timeIt(N, () => toJsonFile(loadedBefore, true)) },
    yjs: { load: await timeIt(N, () => loadYState(yState)), save: await timeIt(N, () => Y.encodeStateAsUpdate(toYDoc(loadedBefore))) },
  }

  // ------------------------------------------------------------ Yjs growth: type 1000 chars, then delete them
  const growth = (gc: boolean) => {
    const d = new Y.Doc({ gc })
    Y.applyUpdate(d, yState)
    const frag = d.getXmlFragment(Y_FRAGMENT)
    // first top-level paragraph's text
    const para = frag.toArray().find((n) => n instanceof Y.XmlElement && n.nodeName === 'paragraph') as Y.XmlElement
    const text = para.toArray().find((n) => n instanceof Y.XmlText) as Y.XmlText
    for (let i = 0; i < 1000; i++) text.insert(text.length, 'x') // one transaction per keystroke
    for (let i = 0; i < 1000; i++) text.delete(text.length - 1, 1)
    return Y.encodeStateAsUpdate(d).length
  }
  const yjsGrowth = { typedChars: 1000, initial: yState.length, gcOn: growth(true), gcOff: growth(false) }

  const noop = toYDoc(loadedBefore)
  const svNoop = Y.encodeStateVector(noop)
  updateYFragment(noop, noop.getXmlFragment(Y_FRAGMENT), loadHtml(before).doc, { mapping: new Map(), isOMark: new Map() })
  const yjsNoopUpdateBytes = Y.encodeStateAsUpdate(noop, svNoop).length

  const mistakes = await runMistakes(samplePath)
  const yjsScenarios = await runYjsExperiment(samplePath)
  const summary: Summary = { sample: samplePath, sizes, signalRatio: signal, speedMs, yjsGrowth, yjsNoopUpdateBytes, edits, mistakes, yjsScenarios }
  mkdirSync(outDir, { recursive: true })
  write(`${outDir}/summary.json`, JSON.stringify(stripTexts(summary), null, 2) + '\n')
  write(`${outDir}/report.html`, renderReport(summary))
  return summary
}

/** summary.json without the big before/after/patch strings */
function stripTexts(s: Summary) {
  return {
    ...s,
    edits: s.edits.map((e) => ({
      ...e,
      perFormat: Object.fromEntries(
        Object.entries(e.perFormat).map(([f, v]) => [
          f,
          {
            editCalls: v.edit.calls,
            emitChars: v.edit.emitChars,
            emitTokens: v.edit.emitTokens,
            newStringChars: v.edit.new.length,
            newStringTokens: tokens(v.edit.new),
            ...v.prone,
            diffAdded: v.diff.added,
            diffRemoved: v.diff.removed,
            diffChars: v.diff.chars,
          },
        ]),
      ),
    })),
  }
}

export function printSummary(s: Summary) {
  const pad = (x: unknown, n: number) => String(x).padStart(n)
  console.log(`\nSample: ${s.sample}\n`)
  console.log('Agent edit (str_replace old+new) — chars / ~tokens, and unified diff (+/- lines):')
  console.log('edit'.padEnd(30) + FORMATS.map((f) => pad(f, 26)).join(''))
  for (const e of s.edits) {
    console.log(
      e.id.padEnd(30) +
        FORMATS.map((f) => {
          const v = e.perFormat[f]
          return pad(`${v.edit.calls}× ${v.edit.emitChars}c/${v.edit.emitTokens}t +${v.diff.added}/-${v.diff.removed}`, 26)
        }).join(''),
    )
  }
  console.log('\nYjs (server Y.Doc, agent change applied via updateYFragment):')
  for (const e of s.edits)
    console.log(`  ${e.id.padEnd(30)} update ${e.yjs.incrementalUpdateBytes} B (naive full replace ${e.yjs.fullReplaceUpdateBytes} B), converges: ${e.yjs.equalsTarget}`)
  console.log('\nFile size (bytes / gzip):')
  for (const [k, v] of Object.entries(s.sizes)) console.log(`  ${k.padEnd(30)} ${pad(v.bytes, 7)} / ${pad(v.gzip, 6)}`)
  console.log('\nProse share of file (visible text / file chars):')
  for (const [k, v] of Object.entries(s.signalRatio)) console.log(`  ${k.padEnd(30)} ${(v * 100).toFixed(0)}%`)
  console.log('\nLoad / save, median ms (Node, jsdom):')
  for (const [k, v] of Object.entries(s.speedMs)) console.log(`  ${k.padEnd(30)} ${v.load.toFixed(2)} / ${v.save.toFixed(2)}`)
  const g = s.yjsGrowth
  console.log(`\nYjs state: ${g.initial} B → after typing+deleting ${g.typedChars} chars: ${g.gcOn} B (gc on), ${g.gcOff} B (gc off)`)
  console.log(`Yjs: updateYFragment with an unchanged document still emits ${s.yjsNoopUpdateBytes} B`)
  console.log('\nAgent edits the file while the user types (Yjs merge strategies):')
  for (const r of s.yjsScenarios)
    console.log(`  ${r.id.padEnd(16)} ${r.strategy.padEnd(6)} user-edit-synced-first=${String(r.userEditReachedServerFirst).padEnd(5)} agent ${r.agentEditSurvived ? 'kept' : 'LOST'}, user ${r.userEditSurvived ? 'kept' : 'LOST'}`)
  console.log('\nAgent mistakes — JSON validators vs. collab check (HTML): see npm run check-json')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = await runCompare(process.argv[2])
  printSummary(s)
  console.log('\nwrote out/edits/*, out/summary.json, out/report.html')
}
