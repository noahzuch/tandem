// Server-side glue between ONE HTML file on disk and ONE live Y.Doc (spike 03's recommendation D1):
//
//   load   .collab/<doc>.ystate exists and its recorded hash matches the HTML file → Y state from the sidecar
//          (keeps Yjs history / client ids, so clients that were offline still merge). Otherwise the Y.Doc is
//          seeded from the HTML (headless parse with the spike 04/05 schema incl. islands) — server-side, so
//          the first browser never has to "setContent" into an empty doc.
//   store  (debounced by Hocuspocus) Y.Doc → body HTML → prettier → expandIslands → splice into the file's own
//          shell (<head> untouched) → write; then the sidecar + its meta (hash of what we wrote).
//   watch  the file changed on disk and the hash is not ours → someone (the agent's Edit tool) wrote it →
//          3-way merge: fork a Y.Doc at the base (= the Y state the file on disk was produced from),
//          reconcile the fork to the new file content, merge the fork's update into the live doc.
//          Concurrent live edits (the user typing) survive because they are ops relative to the same base.
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { updateYFragment } from '@tiptap/y-tiptap'
import { splitDocument, joinDocument } from './htmlDoc.ts'
import { docToBody, docText, fragmentOf, loadHtml, seedFragment, sha1, withBlockIds, yToDoc, yToDocWithMapping } from './pipeline.ts'

export interface CollabStats {
  loadedFrom: 'sidecar' | 'html' | null
  loads: number
  stores: number
  storesSkippedUnchanged: number
  externalMerges: number
  externalFormattingOnly: number
  echoesIgnored: number
  lastStoreAt: number | null
  lastStoreBytes: number
  lastMergeUpdateBytes: number
  lastMergeMs: number
  log: string[]
}

export type Origin = { source: 'local'; context: { from: string } }

export class CollabDoc {
  readonly name: string
  readonly sidecarPath: string
  readonly metaPath: string
  readonly stats: CollabStats = {
    loadedFrom: null,
    loads: 0,
    stores: 0,
    storesSkippedUnchanged: 0,
    externalMerges: 0,
    externalFormattingOnly: 0,
    echoesIgnored: 0,
    lastStoreAt: null,
    lastStoreBytes: 0,
    lastMergeUpdateBytes: 0,
    lastMergeMs: 0,
    log: [],
  }
  /** the live document while loaded (Hocuspocus owns its lifecycle) */
  live: Y.Doc | null = null
  /** Y state the file on disk corresponds to (base of the 3-way merge) */
  private baseState: Uint8Array | null = null
  /** sha1 of the file content as we last wrote or merged it → the watcher ignores our own writes */
  private knownHash: string | null = null
  private watcher: fs.FSWatcher | null = null
  private watchTimer: ReturnType<typeof setTimeout> | null = null
  private storing: Promise<void> | null = null
  private merging: Promise<void> | null = null

  constructor(
    readonly docPath: string,
    readonly opts: {
      pretty: boolean
      log?: (msg: string) => void
      /** spike 06: the Y.Doc was just seeded from HTML (no usable sidecar) → restore comments from their own sidecar */
      afterHtmlSeed?: (ydoc: Y.Doc) => void
      /** spike 06: runs before every store (refresh the comments' last-known quotes, so .ystate and JSON carry them) */
      beforeStore?: (ydoc: Y.Doc) => void
      /** spike 06: runs after every store (comments sidecar) */
      afterStore?: (ydoc: Y.Doc) => void
      /** spike 06: an external file edit was merged into the live doc (→ rescue orphaned comment anchors) */
      afterExternalMerge?: (ydoc: Y.Doc) => void
    } = { pretty: true },
  ) {
    this.name = path.basename(docPath)
    const dir = path.join(path.dirname(docPath), '.collab')
    this.sidecarPath = path.join(dir, `${this.name}.ystate`)
    this.metaPath = path.join(dir, `${this.name}.ystate.json`)
  }

  private log(msg: string) {
    this.stats.log.push(`${new Date().toISOString().slice(11, 23)} ${msg}`)
    if (this.stats.log.length > 200) this.stats.log.shift()
    this.opts.log?.(msg)
  }

  // ---------------------------------------------------------------- load
  async load(ydoc: Y.Doc): Promise<void> {
    const file = fs.readFileSync(this.docPath, 'utf8')
    const hash = sha1(file)
    let from: 'sidecar' | 'html' = 'html'
    if (fs.existsSync(this.sidecarPath) && fs.existsSync(this.metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8')) as { htmlHash: string }
        if (meta.htmlHash === hash) {
          Y.applyUpdate(ydoc, new Uint8Array(fs.readFileSync(this.sidecarPath)), { source: 'local', context: { from: 'load' } })
          from = 'sidecar'
        } else this.log(`sidecar is for another file version (${meta.htmlHash.slice(0, 8)} ≠ ${hash.slice(0, 8)}) → rebuilding from HTML`)
      } catch (e) {
        this.log(`sidecar unreadable (${(e as Error).message}) → rebuilding from HTML`)
      }
    }
    if (from === 'html') {
      const { doc } = loadHtml(file)
      seedFragment(ydoc, withBlockIds(doc))
      this.opts.afterHtmlSeed?.(ydoc)
    }
    this.live = ydoc
    this.baseState = Y.encodeStateAsUpdate(ydoc)
    this.knownHash = hash
    this.stats.loadedFrom = from
    this.stats.loads++
    this.log(`loaded ${this.name} from ${from} (${fragmentOf(ydoc).length} top-level blocks)`)
    // seeded from HTML: ids were added → write them back right away so file, sidecar and Y.Doc agree
    if (from === 'html') await this.store(ydoc)
    this.watch()
  }

  unload() {
    this.live = null
  }

  // ---------------------------------------------------------------- store
  /** Y.Doc → HTML file + sidecar. Serialised: a second call waits for the first. */
  store(ydoc: Y.Doc): Promise<void> {
    const run = async () => {
      if (this.storing) await this.storing
      await this.doStore(ydoc)
    }
    const p = run().finally(() => {
      if (this.storing === p) this.storing = null
    })
    this.storing = p
    return p
  }

  private async doStore(ydoc: Y.Doc) {
    this.opts.beforeStore?.(ydoc)
    const t0 = performance.now()
    const state = Y.encodeStateAsUpdate(ydoc)
    const body = await docToBody(yToDoc(ydoc), this.opts.pretty)
    const current = fs.readFileSync(this.docPath, 'utf8')
    const out = joinDocument(splitDocument(current), body)
    const hash = sha1(out)
    if (hash !== sha1(current)) {
      fs.writeFileSync(this.docPath, out)
      this.stats.stores++
      this.stats.lastStoreBytes = Buffer.byteLength(out)
      this.log(`stored ${this.name} (${Buffer.byteLength(out)} B, ${Math.round(performance.now() - t0)} ms)`)
    } else this.stats.storesSkippedUnchanged++
    this.knownHash = hash
    this.baseState = state
    fs.mkdirSync(path.dirname(this.sidecarPath), { recursive: true })
    fs.writeFileSync(this.sidecarPath, state)
    fs.writeFileSync(this.metaPath, JSON.stringify({ htmlHash: hash, writtenAt: new Date().toISOString(), stateBytes: state.length }, null, 2))
    this.stats.lastStoreAt = Date.now()
    this.opts.afterStore?.(ydoc)
  }

  // ---------------------------------------------------------------- watch + 3-way merge
  private watch() {
    if (this.watcher) return
    const dir = path.dirname(this.docPath)
    this.watcher = fs.watch(dir, (_event, filename) => {
      if (filename && filename !== this.name) return
      if (this.watchTimer) clearTimeout(this.watchTimer)
      // editors/agents often write in two steps (truncate + write): wait for the burst to end
      this.watchTimer = setTimeout(() => void this.onFileChanged(), 150)
    })
  }

  close() {
    this.watcher?.close()
    this.watcher = null
    if (this.watchTimer) clearTimeout(this.watchTimer)
  }

  /** returns after the pending merge (if any) finished — for tests */
  settle(): Promise<void> {
    return Promise.all([this.merging, this.storing]).then(() => undefined)
  }

  private onFileChanged(): Promise<void> {
    const p = (this.merging ?? Promise.resolve()).then(() => this.mergeFromDisk())
    this.merging = p.finally(() => {
      if (this.merging === p) this.merging = null
    })
    return this.merging
  }

  private async mergeFromDisk() {
    if (this.storing) await this.storing
    let file: string
    try {
      file = fs.readFileSync(this.docPath, 'utf8')
    } catch {
      return // mid-write / deleted; the next event retries
    }
    const hash = sha1(file)
    if (hash === this.knownHash) {
      this.stats.echoesIgnored++
      return
    }
    const live = this.live
    if (!live || !this.baseState) {
      // nobody has the document open: the next load parses the HTML (the sidecar hash won't match)
      this.knownHash = hash
      return
    }
    const t0 = performance.now()
    const fileDoc = withBlockIds(loadHtml(file).doc)
    const fork = new Y.Doc()
    Y.applyUpdate(fork, this.baseState)
    const { doc: baseDoc, meta } = yToDocWithMapping(fork)
    if (baseDoc.eq(fileDoc)) {
      // whitespace / formatting only (or our own write with a different shell): nothing to merge
      this.stats.externalFormattingOnly++
      this.knownHash = hash
      this.log(`file changed on disk, document equal → ignored (formatting only)`)
      return
    }
    const sv = Y.encodeStateVector(fork)
    fork.transact(() => updateYFragment(fork, fragmentOf(fork), fileDoc, meta), 'file')
    const update = Y.encodeStateAsUpdate(fork, sv)
    const before = docText(yToDoc(live))
    Y.applyUpdate(live, update, { source: 'local', context: { from: 'file-watcher' } } satisfies Origin)
    // from now on the file on disk corresponds to the fork's state (base + file edit)
    this.baseState = Y.encodeStateAsUpdate(fork)
    this.knownHash = hash
    this.stats.externalMerges++
    this.stats.lastMergeUpdateBytes = update.length
    this.stats.lastMergeMs = Math.round(performance.now() - t0)
    const after = docText(yToDoc(live))
    this.log(`external edit merged: ${update.length} B update in ${this.stats.lastMergeMs} ms (text ${before.length} → ${after.length} chars)`)
    fork.destroy()
    this.opts.afterExternalMerge?.(live)
  }
}
