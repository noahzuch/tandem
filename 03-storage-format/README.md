# Spike 03: What lives on disk? HTML, ProseMirror JSON, Yjs state, or a hybrid?

## Question

The user asked whether the document should be stored as Tiptap's internal format instead of HTML,
so that "the agent can't create HTML that isn't editable in Tiptap". The candidates:

- **(A) HTML**: the editor owns the body, the head is preserved, prettier runs on save (the spike 02/04 approach).
- **(B) ProseMirror JSON** (`editor.getJSON()`), pretty-printed. **B-min** is the same JSON with schema-default attrs removed.
- **(C) Yjs state**: the binary update / state file that spike 07 collaboration needs anyway.
- **(D) Hybrids**: for example HTML on disk + Yjs sidecar in `.collab/`, or JSON on disk + an HTML export.

The formats are compared on agent editability, guarding against un-editable content, diff readability, size/speed/human
readability, and how they work with Yjs collaboration.

## What I built

Everything runs headlessly in Node. It uses spike 04's extension set (islands + attribute preservation, copied into `src/`)
and parses with jsdom, through the same `prepareForEditor → DOMParser → DOMSerializer → prettier → expandIslands` path that the editor uses.

| file | what it does |
|---|---|
| `src/extensions.ts`, `src/islands/{classify,raw,source}.ts` | Copied from spike 04, unchanged |
| `lib/pipeline.ts` | Load/save for each format: HTML ⇄ PM doc, PM JSON file (`{format, shell:{before,after}, doc}`), Yjs state (`prosemirrorToYDoc` + a `shell` map) |
| `lib/edits.ts` | The 4 agent edits (+1 extra), written as the agent would write them: HTML that copies the style of the file |
| `lib/metrics.ts` | The **cheapest str_replace edit(s)** that turn before into after, for each format (line-anchored, unique `old_string`, one contiguous replacement or one replacement per hunk, whichever is cheaper). Token count (cl100k as a *proxy*), bracket depth/escapes, unified diff |
| `scripts/compare.ts` | `npm run compare`: applies the edits and writes **all before/after files** to `out/edits/<edit>/` (`after.html`, `after.json`, `after.min.json`, `after.ystate`, `*.patch`, `*.agent-edit.txt`, `after.saved.html`, `html-save-churn.patch`). It also measures size/speed/Yjs and writes `out/summary.json` + `out/report.html` |
| `lib/check.ts`, `scripts/check.ts` | **The validator**, `npm run check -- <file.html> [--json] [--strict]` (would be `collab check`). Details below |
| `lib/checkJson.ts`, `scripts/check-json.ts` | Validation for format B: `JSON.parse`, a **JSON Schema generated from the ProseMirror schema** (ajv), and `Node.fromJSON().check()`. `npm run check-json` runs 12 typical agent mistakes through both the JSON validators and `collab check`. `npm run check-json -- f.json` checks one file |
| `scripts/yjs-experiment.ts` | `npm run yjs`: the agent edits the file while a browser is connected and the user types. Tests 3 merge strategies |
| `scripts/start.ts` | `npm start`: runs the comparison, prints the summary, and serves the report on **http://127.0.0.1:5103/** |
| `samples/bad-agent.html` | Deliberately bad agent HTML (13 typical problems, plus one fine section) |
| `verify/verify.ts` | `npm run verify`: **117 checks**, Node only (no browser needed) |

## How to try it

```bash
cd spikes/project-collab/03-storage-format
npm install
npm start                                   # summary in the terminal + http://127.0.0.1:5103/ (Ctrl-C stops)
npm run check -- samples/bad-agent.html     # the validator on bad agent HTML (exit 1)
npm run check -- samples/spec.html          # clean: 0 errors, lists the 2 islands (exit 0)
npm run check-json                          # same agent mistakes: JSON validators vs collab check
npm run yjs                                 # merge strategies for "agent edits file while user types"
npm run verify                              # 117 checks, exit 0/1
```

The report page has the tables below and, for every edit, three columns (HTML / JSON / JSON-min). Each column shows what the
agent writes (`new_string`) and the unified diff. The raw files are at `/edits/<edit>/after.min.json` and similar paths.

## Findings

All numbers are measured on `samples/spec.html` (canonical form, i.e. after one editor save). Tokens use cl100k as a proxy;
Claude's tokenizer differs, so read the *ratios*.

### 0. All formats are lossless, so the choice is about the agent, git and collaboration

HTML → JSON → HTML, HTML → JSON-min → HTML and HTML → Yjs → HTML are all **byte-identical** (verify). Spike 04's islands
already make HTML as faithful as JSON. Choosing JSON gains no fidelity.

### 1. Agent editability: what the agent must emit (str_replace `old_string + new_string`)

| edit | A · HTML | B · JSON (getJSON) | B-min · JSON | B-min / A |
|---|---|---|---|---|
| e1 rewrite a paragraph (text only, marks unchanged) | 1 call, 489 c / **117 t** | 4 calls, 511 c / 107 t | 4 calls, 511 c / **107 t** | 0.9× |
| e2 add a list item (with one bold word) | 1 call, 130 c / **49 t** | 1161 c / 194 t | 866 c / **146 t** | **3.0×** |
| e3 add a table row (3 cells, 2 `code`) | 240 c / **90 t** | 3257 c / 507 t | 1943 c / **280 t** | **3.1×** |
| e4 add a section with an SVG diagram | 1110 c / **387 t** | 2115 c / 583 t | 1917 c / **543 t** | 1.4× |
| e5 (extra) add a bold word + a link in a sentence | 244 c / **78 t** | 3 calls, 1477 c / 232 t | 3 calls, 1161 c / **187 t** | **2.4×** |

How error-prone each snippet is (counted on `new_string`, B-min): e2 has **18 brackets, nesting depth 7**. e3 has **46 brackets, depth 9**.
e5 needs **3 separate edits**: the text node is split in three and `{"type":"link","attrs":{"href":"#api"}}` is spelled out as a mark object. e4 puts the
SVG into the island's `html` attribute as **one JSON string with 103 escapes** (`\"`, `\n`). The HTML snippets have zero brackets and zero
escapes. They are plain tags that agents write fluently.

The honest view of JSON: a **text-only** change (e1) costs the same in both formats, because each JSON text node is its own line.
Anything structural costs 2.4–3× more tokens and needs deeply nested brackets and per-mark objects. Real rewrites usually
change formatting too (e5). JSON also has a hidden cost: the agent must **read** the 32–44 KB file (≈4× the 8 KB HTML) before it can
anchor an edit. The anchors (`"type": "text",`, `}, {`) repeat everywhere, so `old_string` needs several lines to be unique.

The agent's HTML survives the next editor save as written (document-equal on all 5 edits). Prettier reflows lines only where the agent
wrote compactly (e2: +3/−1 lines, e3: +6/−2 in the save that follows).

### 2. Guarding against un-editable content: `collab check` vs JSON validation

**The key point: storing JSON does not prevent un-editable content.** Once the schema has an island node (spike 04's answer for
SVG/figure/custom elements), the agent can put *any* HTML into JSON as `{"type":"htmlIsland","attrs":{"html":"…"}}`. It is the
same content, just escaped. Without an island node the agent can't add diagrams at all. In both cases what the user is
really worried about ("content I can't edit") is not prevented by the format. It needs **feedback**.

**`npm run check -- file.html`** has two layers:
1. **Lint rules on the source** (parse5 with source locations): which elements become islands, and known lossy shapes. Each rule comes with a
   concrete fix (`prose-in-island` → "use `<section>`/`<div>`", `table-caption`, `markup-in-code`, `comment-dropped`,
   `stray-text`, `block-in-inline`, `unclosed-tag` (also inside islands), `event-handler-removed`, `js-link-removed`, `renamed`).
2. **Ground truth: the real schema round trip** (the editor's exact parse/serialize, headless). The input and output are compared on: every word *and the
   containers it sits in* (`structure-changed`), elements per tag, attributes (CSS normalised through CSSOM), island byte-exactness,
   and idempotence. This layer caught things the lint rules didn't predict. **`<li><h3>…</h3><p>…</p></li>` moves the heading
   and paragraph out of the list** (listItem = `paragraph block*`), and `<details>` without `<summary>` moves its content out. Agents write both.

Output for `samples/bad-agent.html` (excerpt, with line numbers):
```
samples/bad-agent.html: 4 error(s), 11 warning(s), 4 info — 51 editor nodes, 3 block + 0 inline island(s), …
  L12   warn  prose-in-island        <x-card> contains 2 prose block(s) (<h2>, <p>): users can't format, split or extend
                                     this text. Use an editable container (<section>, <div>, <aside>, <article>) for prose…
  L17   error markup-in-code         <span> inside <pre> is dropped: code blocks hold plain text only (no syntax-highlight spans…)
  L22   warn  comment-dropped        HTML comment directly inside <ul> is dropped … Move it before the <ul>.
  L28   warn  table-caption          Because of <caption>, this table is not an editable table … Put the caption in a <p> above.
  L41   error structure-changed      "Heading inside a list item" is moved out of <li> (ul>li) to the top level — the schema
                                     doesn't allow this content there.
```
`spec.html` and all 5 agent-written `after.html` files: **0 errors, 0 warnings** (only `info island` for the figure and the agent note).
Runtime: 46 ms warm for spec.html; the CLI takes ≈0.8 s wall time including tsx and jsdom startup.

**The same 12 agent mistakes, fed to each validator** (`npm run check-json`):

| mistake | JSON.parse | JSON Schema (ajv, generated) | ProseMirror `check()` | **collab check (HTML)** |
|---|---|---|---|---|
| trailing comma / missing `}` | ✗ "position 6124 (line 209)" | – | – | HTML analog (unclosed `<strong>`): **warn unclosed-tag** with fix. Missing `</li></ul>` is repaired by the parser |
| marks as `["bold"]` | ✓ | ✗ `/content/1/content/1/marks/0 must be object` | ✗ "no mark type undefined" | `<b>`: info renamed, works |
| text directly in listItem | ✓ | **✓ (passes)** | ✗ `Invalid content for node listItem: <"…">` (no path) | not a mistake in HTML: `<li>text</li>` is normalised |
| heading first in listItem | ✓ | **✓ (passes)** | ✗ `Invalid content for node listItem` (no path) | **error structure-changed** "Step" moves out of `<li>`, with line |
| unknown node type `figure` | ✓ | ✗ enum (24 allowed values) | ✗ "Unknown node type: figure" | info: becomes island (kept, leaf-editable) |
| attr typo `{"lvl":2}` | ✓ | ✗ additional property "lvl" | **✓ (silently ignored)** | `<h2 lvl>`: kept as an attribute, harmless |
| empty text node | ✓ | ✗ minLength | ✗ "Empty text nodes are not allowed" | `<strong></strong>`: dropped, nothing lost |
| paragraph in paragraph | ✓ | **✓** | ✗ (no path) | parser closes the first `<p>`: fine |
| ragged table row | ✓ | ✓ | ✓ | ✓ (both repaired on load) |
| **prose put into an island** | ✓ | **✓** | **✓** | **warn prose-in-island** + fix |
| **broken HTML inside an island** | ✓ | **✓** | **✓** | **warn unclosed-tag** inside `<svg>` |

So, which gives the agent better guidance?
- JSON validation is **strict but blunt**. Any single error makes the whole document unloadable (`fromJSON` throws, all-or-nothing).
  ProseMirror's messages have no path or line. The JSON Schema can't express content expressions (`paragraph block*`), so the most
  common structural mistakes pass it. Neither of them sees what the user actually cares about (prose stuck inside an island,
  broken island HTML), because to JSON that's just a valid string.
- `collab check` on HTML is **forgiving where HTML is forgiving** (missing `<p>` wrappers or unclosed `<li>` aren't mistakes; the parser
  and schema normalise them, and the document still loads). It **flags exactly the cases that lose content or editability**, with line numbers and a fix.
  The ground-truth layer catches what the rules don't foresee.
- To make it automatic, run `collab check` from the skill after each agent write (or from a PostToolUse hook on Write/Edit of the open doc) and feed the findings back.

### 3. Diff / review readability (unified diff, 3 lines of context)

| edit | A · HTML | B · JSON | B-min |
|---|---|---|---|
| e1 rewrite paragraph | +3 −3 (816 c) | +4 −4 (1155 c) | +4 −4 (1176 c) |
| e2 add list item | **+1** (420 c) | +37 (1381 c) | +27 (1084 c) |
| e3 add table row | **+5** (446 c) | +107 (3633 c) | +65 (2212 c) |
| e4 section + diagram | **+14** (1319 c) | +51 (2378 c) | +43 (2176 c) |
| e5 bold + link | **+4 −1** (455 c) | +39 −2 (2066 c) | +31 −2 (1719 c) |
| Yjs (C) | `Binary files differ` | | |

A reviewer can read the HTML diffs as prose. The JSON diffs are bracket scaffolding with the prose split across `"text"` lines. The e4 diagram turns
into one 900-character escaped line. With prettier on save the HTML diffs stay line-local (spike 04: a one-word edit = 144 c).

### 4. File size, speed, human readability

| | A · HTML | B · JSON | B-min | C · Yjs | D · HTML + Yjs sidecar |
|---|---|---|---|---|---|
| bytes | **8,026** | 43,942 (5.5×) | 31,969 (4.0×) | 12,634 | 20,660 |
| gzip | 3,312 | 4,638 | 4,258 | 4,903 | 8,215 |
| prose share of file | **26%** | 5% | 7% | (binary) | |
| load, median ms | 11.8 (jsdom parse) | 0.15 | 0.12 | 0.32 | |
| save, median ms | 5.3 with prettier / 0.8 without | 0.08 | 0.15 | 0.30 | |

- Speed doesn't matter here. Every format is well under 20 ms for a realistic spec. HTML is the slowest because of the DOM parse and prettier.
- Human readability outside the tool: the **HTML opens in any browser as the finished, styled document** and reads fine in an IDE. JSON
  is unreadable in a browser (a raw JSON tree, and the `<head>` CSS is a single escaped string) and hard to read in an IDE. Yjs is opaque binary.
  A JSON-on-disk product would need an HTML export next to it (hybrid "JSON + export") to be viewable. That means two files that
  can drift, and the agent would still prefer to read the export.
- Yjs state growth: typing then deleting 1,000 characters → +24 B with GC on, **+1,024 B with GC off** (GC off is needed
  to keep version snapshots). Fine for a sidecar, but not something to commit.

### 5. Interplay with collaboration (small experiment, `npm run yjs`; spikes 07/08 go deep)

Setup: the server holds a Y.Doc, a browser replica is synced, and the user types in the "Online" paragraph. **The agent read the file
before the user typed** and writes its edit (adds a list item) to disk. The server must turn the file change into Y ops.
In every case the HTML on disk is first parsed into a ProseMirror doc. From there the path is identical for HTML or JSON on disk. **JSON
saves only the ≈12 ms parse.** The diff → Y-ops step (`y-prosemirror` `updateYFragment`, the same function the sync plugin uses
for local edits) is the same.

| strategy | user edit already synced to server | agent edit | user edit |
|---|---|---|---|
| naive: rebuild the Y fragment from the file | no / yes | kept | **LOST** / **LOST** |
| 2-way: `updateYFragment(liveDoc, fileDoc)` | no | kept | kept |
| 2-way | **yes** | kept | **LOST (reverted: the file doesn't contain it)** |
| **3-way: fork a Y.Doc at the base snapshot the file was last written from, `updateYFragment(fork, fileDoc)`, merge the fork's update** | no / yes | **kept** | **kept** |
| 3-way, same paragraph (user types in the intro, agent rewrites the intro) | yes | kept | kept: `"Field technicians (and auditors) regularly work without connectivity…"` |
| 3-way, same island (user edits an SVG label, agent edits the figcaption of the same `<figure>`) | yes | one side **LOST** | (island = one string attr; which side wins depends on the random client ids) |

Also measured:
- An incremental update for an agent edit is **1.2–2.1 KB**, compared with ~11–13 KB for a full replace.
- **`updateYFragment` with an *unchanged* document still emits 735 B.** y-prosemirror compares attrs with `!==`, so
  object-valued attrs (spike 04's `htmlAttrs`) and marks with attrs are rewritten on every call. In the 3-way path this means a no-op
  file write could overwrite a concurrent user change to those attributes. Mitigation: skip when `fileDoc.eq(baseDoc)`, and store
  `htmlAttrs` as a JSON string (strings compare by value) or flatten it.

What gets persisted and when (proposal for spikes 07/08):
- **In memory:** the Y.Doc. It is the live truth while a session is open.
- **`.collab/<doc>.ystate`** (sidecar, not committed): written debounced (~1 s) and on the last disconnect. It allows recovery after a server crash and,
  more importantly, gives the **base snapshot** of the last disk write that the 3-way merge needs. Save the base state (or a `Y.snapshot`) plus
  a hash of the written file on every disk write.
- **`doc.html`** (committed, the agent's interface): written from the Y.Doc, debounced (~1–2 s idle) and on disconnect. A file watcher compares
  the content hash with the last write. A different hash means an external (agent) change → load → 3-way merge → the browser sees it live.

## Decision matrix

Scores: ++ best · + good · o neutral · − weak · −− bad.

| criterion (weight) | A · HTML | B · PM JSON | C · Yjs file | **D1 · HTML on disk + Yjs sidecar** | D2 · JSON on disk + HTML export |
|---|---|---|---|---|---|
| Agent edits (tokens, error-proneness) (high) | **++** 1× | −− 2.4–3× tokens on structural edits, depth 7–9 brackets, escaped SVG | −− needs a CLI | **++** | −− |
| Prevents un-editable content (high) | o by itself, **++ with `collab check`** | − rejects unknown types, but islands accept any HTML, no path/line, all-or-nothing load | o | **++ with `collab check`** | − |
| Diff / review in git (high) | **++** +1…+14 lines | −− +27…+107 lines | −− binary | **++** | − (two diffs) |
| Human readability outside the tool (med) | **++** opens as the styled doc | −− | −− | **++** | o (export only) |
| Fidelity (med) | ++ (spike 04 islands) | ++ | ++ | ++ | ++ |
| Collaboration (high if spike 07) | o needs a base snapshot for the 3-way merge | o same merge, saves only the parse | ++ native, but agent-hostile | **++** Y.Doc live + base snapshot in sidecar | o |
| Size on disk (low) | ++ 8 KB | − 32–44 KB | + 13 KB | + 8 KB committed, sidecar ignored | − |
| Load/save speed (low) | + 12/5 ms | ++ <1 ms | ++ | + | + |

## Verdict / recommendation for the real product

**Keep HTML as the file on disk and the agent's interface (A). Add a `collab check` validator, and when collaboration is on, a Yjs
sidecar in `.collab/` (D1).** Don't store ProseMirror JSON.

- The user's concern is real, but **the format doesn't solve it. Feedback does.** JSON would still let the agent put arbitrary
  HTML into an island (escaped, harder to see). It rejects good-faith structure mistakes with path-less errors and makes the
  whole document unloadable. It also costs ~3× the tokens and produces diffs ~5–20× longer. `collab check` reports exactly which
  constructs become islands, which get restructured, and which lose content, with line numbers and a fix.
  It runs the real schema, so it can't drift from the editor.
- Make the check part of the loop: the skill tells the agent to run `collab check doc.html` after every write (or a PostToolUse hook
  does it). `--strict` turns warnings such as `prose-in-island` into failures if we want to *enforce* "everything editable".
- Collaboration: the Y.Doc is the live state. The HTML file is written from it (debounced). Agent file edits come back in through a **3-way merge
  against the base snapshot** (fork at base → `updateYFragment` → merge). The naive and 2-way approaches lose user edits (measured above).
  The `.collab/*.ystate` sidecar holds that base and is never committed.
- Schema follow-ups found here: `listItem` should accept a heading first (or `collab check` keeps flagging it).
  `htmlAttrs` should be stored as a string for Yjs. `details` without `summary` should get a parse rule.

## Open questions

- **Island concurrency**: an island is one string attr, so it is last-writer-wins for the whole island (measured: one side's edit is lost).
  Should islands get a `Y.Text` per leaf, or should the agent's island edits be applied as text splices? This is for spike 07/08.
- 3-way base snapshot across server restarts: is a `Y.snapshot` + file hash enough, or do we keep the last written HTML too (to diff text,
  not documents)? What happens if the agent edits the file while no server is running? (Then a plain load is enough. There is no live doc.)
- `updateYFragment` is marked `@private @unstable` in y-prosemirror. We would be depending on it, or would need our own PM-doc → Y diff.
- Should `collab check` run automatically through a hook, or does the skill instruction suffice? Should `prose-in-island` be an error by default?
- Token numbers use cl100k as a proxy. Claude's tokenizer should give similar *ratios* but this wasn't measured.
- Not evaluated: Markdown as the on-disk format (it would lose the islands/attributes that spike 04 preserves).
