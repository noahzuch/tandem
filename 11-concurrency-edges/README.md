# Spike 11: Concurrency edge cases. The agent vs. a second human

## Question

Spike 07 measured "same paragraph, different positions" only with the user's caret **outside** the agent's change. But
y-tiptap turns a changed textblock into one delete + one insert (`updateYText` → lib0 `simpleDiff`: common prefix +
common suffix). So an agent edit inside a paragraph is **one span** from its first to its last changed character.
This spike asks:

1. What happens when user A types **inside** that span, or right next to it?
2. What happens when the agent changes the **block type** under A's caret, **rewrites the words** A is typing in,
   **moves** the block A types in, or **proofreads** the whole paragraph?
3. "Isn't this the same problem as two humans editing a collaborative document?" Every scenario also runs with a
   **second human** (browser B with real keyboard and mouse input in the editor UI) doing the same edit.
4. What does that mean for `collab patch --avoid-caret` (spike 08)? Would a span-based rule (block only when the caret
   is inside the agent's changed span) separate the bad cases from the harmless ones?

## What I built

This is a copy of spike 08 (editor, Yjs/Hocuspocus, `collab patch`, the two-pass merge, carets, `--naive-merge`).
It uses port **5111** (HMR 5211). New and changed files:

| file | what it does |
|---|---|
| `experiments/edges.ts` | **The scenario runner** (`npm run edges`). Each run starts a fresh server on a temp copy of the doc. User A ("Noah", headless Chromium) types `" qa1 qb2 qc3 qd4 qe5 qf6 qg7 qh8"` with real key events, 80–140 ms per key, into the paragraph "Phase one ships…". Meanwhile the other party edits. The **agent** uses the HTTP calls `collab` makes (`POST /agent/patch` = `collab patch`, `POST /agent/op` = `set-block` / `move-section`). The **human** is browser B ("Pat"), using the toolbar "Turn into…", Alt+Shift+↑, the drag handle, or selecting and typing. The other party starts at a different offset into A's typing in every run (300/800/1300/1800/2300 ms, ±150 ms jitter from run 5 on). Afterwards the runner records A's doc, the other side's doc, and the file on disk, then classifies the run (below). |
| `lib/livePatch.ts` | + **`caretProbe`**: what an update does to each human caret (`none` / `inside-span` / `recreated`), computed on the merge fork, so it is known *before* applying. + `mergeInto(…, apply=false)` (dry run). + **PROTOTYPE `--fine-diff`**: a word-level diff for text inside changed textblocks instead of `simpleDiff`'s single span. It also ignores whitespace-only "collapse" hunks (see Findings §4). |
| `lib/migrate.ts` | **PROTOTYPE `--migrate-positions`**: the agent's merge writes y-tiptap *position migrations* ("old character id → re-created character id"), as the browser editor does for structural edits (Findings §3) |
| `server/server.ts` | + flags `--fine-diff`, `--migrate-positions`. `patch` returns `caretImpact`. **`avoidCaret: 'span'`** (`collab patch --avoid-jump`) refuses with `USER_IN_SPAN` only when the dry run says a caret would jump. `/agent/op` reports `caretImpact` too. The default doc is `lib/edgesDoc.ts` (the shared sample + two plain-prose sections). |
| `bin/collab.ts` | + `patch --avoid-jump` |
| `verify/verify.ts` | `npm run verify`: 9 headless checks + 50 browser checks over 129 runs (≈ 4 min). It asserts what was **observed**, bad outcomes included. |
| `experiments/runs/final.jsonl` | Raw results of the 400 runs behind the tables below |

**Classification of a run, from A's point of view** (all computed, not judged by eye):

- **lost**: characters A typed are missing anywhere. This is a multiset count against "doc before + the other party's change + T".
- **garbled**: all characters are there, but T is not contiguous. A's text is torn apart, or other text is mixed into A's words.
- **misplaced**: T is intact, but A's block is not the ideal one. The ideal is the other party's change plus T at A's caret.
- **clean**: A's block equals the ideal, block type included.

Each run also records:

- whether the other party's intended change is in the doc as intended
- caret jumps: T ended up in more than one piece
- where A's caret ended
- convergence (A == B / server)
- whether the file on disk has A's final blocks

All 400 runs converged, and the file matched in every run.

## How to try it

```bash
cd spikes/project-collab/11-concurrency-edges
npm install
npx playwright install chromium            # once
npm start                                  # http://127.0.0.1:5111/?user=Noah  (edits .work/spec.html, a fresh copy)
npm start -- --fine-diff --migrate-positions   # the same with both prototypes
```

Open http://127.0.0.1:5111/?user=Noah. Put the caret after "every week" in **6. Rollout** and keep typing. In a second
terminal, act as the agent:

```bash
node --import tsx bin/collab.ts patch <<'EOF'
<<<<<<< SEARCH
northern region
=======
southern region
>>>>>>> REPLACE
<<<<<<< SEARCH
the crash rate
=======
the error rate
>>>>>>> REPLACE
EOF
```

Your next keystrokes land before "southern". Try the same with `patch --avoid-jump` (it is refused with
`USER_IN_SPAN`) and with the server started with `--fine-diff` (it is clean). To see the second-human cases, open a
second tab with `?user=Pat` and use "Turn into…", Alt+Shift+↑ or the drag handle on the paragraph you type in.

```bash
npm run edges -- --scenario 1 --runs 5          # one scenario (1–10), 5 runs each; --party agent|human, --variant 2c
npm run edges -- --variant 1a-agent --runs 10   # one variant; prints every run (A's block, caret, pieces) + a summary
npm run verify                                  # ≈ 4 min, exits 0/1
```

## Findings

### 1. Results (10 runs per cell, 5 for the prototypes; `experiments/runs/final.jsonl`)

`lost / garbled / misplaced / clean` from A's point of view. "jump" = A's later keystrokes landed somewhere else.
"probe" = the server's `caretImpact` for the agent's update.

| # | scenario | **agent** (`collab patch` / ops) | **second human** (editor UI, keyboard) |
|---|---|---|---|
| 1a | two words far apart changed, A types **between** them | **0/0/0 clean of 10: 2 lost, 8 garbled**, jump 10/10, probe `inside-span` 10/10 | **10 clean** |
| 1b | the word **before** A's typed text ("week" → "month") | 7 clean, 3 lost (whitespace collapse widened the span → jump), probe `none` 7 / `inside-span` 3 | 10 clean |
| 1c | the word right **after** the caret, adjacent ("reports" → "escalates") | **10 clean**, probe `none` | 8 clean, 1 lost (a keystroke), 1 misplaced (B's own word scrambled: `scalatese`) |
| 1d | A **pauses** with the caret right after "week"; the other party replaces "week"; A goes on | **10 misplaced** | **10 misplaced, identical text** |
| 2 | block type change under the caret: `patch` `<p>`→`<h2>`, `set-block`, `<ul><li>`, `<blockquote>` (agent) / toolbar "Turn into…" H2, bullet list, quote (human) | **0 clean of 40: 23 lost (1 char) + 17 garbled**, caret → the **next block** ("7. Risks") 40/40, probe `recreated` 40/40 | H2 10 clean · list 8 clean, 2 lost · quote 7 clean, 3 lost. Every loss = the keystroke in flight (1 char) + caret → next block |
| 3 | the sentence A types in is rewritten (agent: fresh read → patch; human: B selects it and types) | 10 lost (A's characters so far overwritten), the agent's sentence intact | **10 lost, the same text as the agent** |
| 3b | the same with a **stale** SEARCH (agent read before A typed) | **10 clean**: `NOT_FOUND` every time, nothing applied | – |
| 4a | the section A types in is moved (`move-section`) / B presses Alt+Shift+↑ | 10 clean | 10 clean |
| 4b | `patch` that moves A's paragraph up **and** edits it / B drags it with the drag handle | 6 clean, 4 lost (whitespace collapse → jump), probe `none` 6 / `inside-span` 4 | 6 clean, 4 lost (keystroke in flight + caret → next block) |
| 5 | proofread: 3 typos spread over A's paragraph (3 small SEARCH blocks) | **0 clean of 10: 7 garbled, 3 lost**, jump 10/10, and the agent's fix itself damaged 10/10 (`pil1 qb2 … qh8ot`) | **10 clean** |
| 5w | the same as one whole-paragraph SEARCH/REPLACE (fresh read) | 0 clean: 8 garbled, 2 lost, jump 10/10 | – |
| 6 | spike 07's one-pass merge (`--naive-merge`): 1a / 5 / 2a | 1a 0 clean (9 garbled, 1 lost) · 5 0 clean · 2a **10 lost**, caret to the end of the doc | – |

Prototypes and the guard (agent only, 5 runs each):

| # | variant | result |
|---|---|---|
| 7 | `--fine-diff` (word-level text diff, PROTOTYPE): 1a, 5, 5w | **15/15 clean**, probe `none` |
| 7 | `--fine-diff`: 3 (sentence rewrite) | 5 lost (overwritten, by intent) |
| 8 | `--migrate-positions` (PROTOTYPE): 1a, 5, 2a–2d | **no caret jump in 30 runs**. 13 clean. The other 17 are all whitespace collapse (§4): a space vanishes (`qh8and`, 13 lost) or moves (`in the␣␣southern`, 4 misplaced). |
| 9 | both prototypes: 1a, 1b, 5, 4b, 2a, 2c | **28/30 clean**. 2a: 1 whitespace collapse in the re-created block. 2c: 1 keystroke in flight + jump (as with a human) |
| 10 | `patch --avoid-jump` (the span rule as a guard): 1a, 5, 2a, 3 | refused (`USER_IN_SPAN`) **20/20**, A clean |
| 10 | `--avoid-jump`: 1b, 1c, 4b | applied 14/15. One 4b run refused (its whitespace collapse would have jumped). A clean 15/15. |

Example strings. The first line is A's paragraph before; A types `␣qa1␣qb2␣qc3␣qd4␣qe5␣qf6␣qg7␣qh8` after "every week".

```
before   Phase one ships to twenty pilot devices in the northern region. The rollout team collects feedback every week and reports …
1a agent Phase one ships to twenty pilot devices in the 1 qb2 qc3 qd4 qe5 qf6 qg7 qh8southern region. The rollout team collects feedback every week qa and reports …
1a human Phase one ships to twenty pilot devices in the southern region. The rollout team collects feedback every week qa1 qb2 qc3 qd4 qe5 qf6 qg7 qh8 and reports …
1a fine  (identical to 1a human)
5 agent  Phase one ships to twenty pil1 qb2 qc3 qd4 qe5 qf6 qg7 qh8ot devices in the northern region. … feedback every week qa and reports …
1d both  … The rollout team collects feedback every  qa1 qb2 qc3 qd4 qe5 qf6 qg7 qh8month and reports …
2 agent  …feedback every week qa and reports …  (h2)          + next block: "1 qb2 qc3 qd4 qe5 qf6 qg7 qh87. Risks"
2 human  …feedback every week qa1 qb2 qc3 qd4 qe5 qf6 qg7 qh8 and reports …  (h2, caret still after qh8)
3 both   Phase one ships to twenty pilot devices in the northern region. 1 qb2 qc3 qd4 qe5 qf6 qg7 qh8Feedback is collected weekly; blockers go to the sync owner. …
1b ws    … The rollout team collects feedback every qe5 qf6 qg7 qh8month qa1 qb2 qc3 qd4 and reports …   (a space lost, then the jump)
1c human … every week and qa1 qb2 qc3 qd4 qe5 qf6 qg7 qh8 scalatese blockers …   (B typed "escalates")
```

### 2. Mechanism 1: the agent's span (text). Agent only.

A caret is a Yjs relative position. y-tiptap creates it with `assoc = -1`, which means "right after character X", where
X is the character **left** of the caret. If X is deleted, the caret resolves to where X was: the **start** of the
deleted run. Yjs places the agent's new text *after* the deleted run. So A's next keystrokes land in front of
the agent's replacement:

- **The agent** reaches the Y.Doc through the merge (HTML → ProseMirror doc → `updateYFragment`). Every changed
  textblock gets **one** `simpleDiff` span, from the first to the last changed character. In 1a that span deletes and
  re-inserts everything between "northern" and "crash", including what A had typed. X is in it, so the caret
  jumps 40–90 characters back to "in the |southern". It happened in 10/10 runs (1a, 5, 5w). In 5 the jump even lands
  *inside* the agent's word, because "pilto" → "pilot" shares the prefix "pil". A's text then splits the agent's fix
  (`pil1 qb2 … qh8ot`).
- **The human**'s editor sends one ProseMirror transaction per keystroke or selection replace. y-tiptap diffs each
  transaction separately, so B's spans are exactly the replaced word. A's caret is outside them, and the result is
  clean in 30/30 runs (1a, 1b, 5).

So this is **not** the same problem as two humans. It is an artifact of turning "old HTML → new HTML" into Y ops
with a prefix/suffix diff. The PROTOTYPE word-level diff (`--fine-diff`) applies only the changed words. 1a, 5 and 5w
then become clean in 15/15 runs, and the update shrinks (1a: 206 B → 85 B).

### 3. Mechanism 2: re-created elements (type change, move). The same code path, but the human's editor writes migrations

Yjs cannot rename an XML element. A `<p>` → `<h2>` deletes the paragraph's Y element and inserts a new one, for the
agent's merge **and** for the human's "Turn into…" (both go through `updateYFragment`). A's caret then points into a
deleted Y.XmlText and does not resolve.

The difference: **y-tiptap 3.0.10's sync plugin writes "position migrations" for local structural transactions.** It
derives from the ProseMirror step mapping which character went where, and stores a record in the shared Y.Map
`__tiptap_position_migrations:root:default`. Every client runs its relative positions through that map
(`resolvePositionMigration` inside `relativePositionToAbsolutePosition`). So when B turns the paragraph into a heading,
A's caret follows its character into the heading (H2: 10/10 clean). The agent's merge has no ProseMirror transaction
and writes no migration. y-tiptap's fallback (`findAbsolutePositionAfterStructuralChange`) then puts the caret at the
start of the **next block** in 40/40 runs, and A goes on typing into "7. Risks".

The PROTOTYPE `lib/migrate.ts` writes the same kind of record from the merge. It pairs old and new textblocks by
Y.XmlText, block id or text, and aligns their characters with the word diff. Result: no jump in 30 runs. It also fixes
the text span of §2, because deleted-and-re-inserted characters are migrated too. The price is about 0.6–1 KB per
update for the migration record (the shared map grows; y-tiptap's own records grow the same way).

What **neither** side fixes: a keystroke A types while the change is **in flight** goes into the deleted element and
is **lost** (1 char). A's caret then also falls back to the next block, because the in-flight character is not in
anyone's migration:

- **Human**: H2 0/10, list 2/10, quote 3/10, drag 4/10, Alt+Shift+↑ 0/10.
- **Agent**: higher (23/40), because its window is longer. The snapshot → prettier render → merge → broadcast takes
  20–80 ms, against a few ms for B's local transaction. `set-block` is worse in principle, because it replaces the
  block with the HTML of the last read. Here it was a fresh read, so the window was only read → op.

With both prototypes, the type change behaves like the human one (2a: 4/5 clean, 2c: 4/5 clean + 1 in-flight loss).

Moves are fine on both sides when nothing else changes. `move-section` was 10/10 clean: the moved blocks keep their Y
elements, or spike 08's merge keeps the caret's block in place and re-creates the others. Alt+Shift+↑ was 10/10.

### 4. Mechanism 3: whitespace collapse. Agent only

When A has just typed a space in front of an existing space (`qd4␣|␣and`), the block holds two spaces for about
100 ms. Canonical HTML and the re-parse collapse them, so the agent's target text has one space. When the agent
changes **anything else in that block** in this window, the merge deletes a space:

- If the deleted space is the one right of the caret, A's next word glues on (`qh8and`). This is a 1-char loss; the
  probe says `none`.
- If it is A's own space, the `simpleDiff` span now reaches from the agent's word to A's caret, and A jumps (1b: 3/10,
  4b: 4/10).

This is spike 08's "leadreads" bug in a block the agent *does* change. Spike 08's node reuse only protects unchanged
blocks. `--fine-diff` drops whitespace-only "collapse" hunks for blocks changed in place; re-created blocks
(type change) still have it.

### 5. Same position, same words: the same for both

- **1d** (A's caret rests right after the replaced word): X is the last letter of "week", which the other party
  deletes. A's next keystrokes land **before** the new word, for the agent and for B alike:
  `every  qa1 … qh8month`, 10/10 each, the same string. This is Yjs/y-tiptap caret semantics, not the merge.
- **3** (the sentence A types in is rewritten): both overwrite A's characters typed so far. That is the intent of
  the edit, since B saw them and selected them. A's later keystrokes land glued in front of the new sentence
  (`qh8Feedback is…`). The result is the same with the agent and with B, 10/10 each. Spike 07's S3a orphan is the
  same thing seen from the other side. With a **stale** SEARCH (the realistic case: the agent read seconds ago), the
  patch fails with `NOT_FOUND` 10/10 and A is safe. The SEARCH string acts as an optimistic lock on the text it
  covers.
- **Human-only races**, rare: in 1c, once A's keystroke vanished, and once B's own word was scrambled to `scalatese`
  by A typing right next to it. These are y-tiptap caret recovery effects at the same position. The agent never typed
  character by character here, so it did not hit them.

### 6. The caret probe as a rule (`--avoid-caret` question)

The server already merges into a fork, so it can tell before applying what a patch does to every human caret.
`caretProbe` classifies each caret as:

- **none**: the character left of the caret survives. The caret stays, whatever else changes in the block.
- **inside-span**: that character is deleted by the update, and the caret will jump to the span start.
- **recreated**: the caret's Y.XmlText is deleted (type change or re-created block).

Over the 10-run data for the default merge, the probe **separates the outcomes perfectly**. Every agent run with
`inside-span` / `recreated` ended badly: 1a 10, 1b 3, 1d 10, 2 40, 3 10, 4b 4, 5 20. Every run with `none` ended
clean: 1b 7, 1c 10, 4a 10, 4b 6. Verify asserts this on every run, 36 applied agent runs per verify. It even catches
the whitespace-collapse jumps, because it runs on the real merge.

Spike 08's `--avoid-caret` ("a caret is anywhere in a changed textblock") flags 1b, 1c and 4b too. Those were clean in
23 of 30 runs, and the 7 bad ones are exactly the probe's `inside-span` runs. So the block-level rule is too coarse;
the span rule is exact.

Implemented as `collab patch --avoid-jump` (`avoidCaret: 'span'`, dry-run merge → `USER_IN_SPAN`). Results:

- refused 1a, 5, 2a, 3: 20/20
- applied 1b, 1c, 4b: 14/15. The one refusal was a 4b run whose whitespace collapse would have jumped.
- A clean in 35/35 runs

## Verdict / recommendation for the real product

1. **Agent vs. human, side by side.**

   | mechanism | agent | human |
   |---|---|---|
   | §2 text span | jumps every time A types inside it | never |
   | §3 type change | caret → next block 40/40 + in-flight loss | clean, except the in-flight keystroke |
   | §4 whitespace collapse | sometimes loses a space or jumps | never |
   | §5 same position / same words | – | identical to the agent |
   | moves | clean | clean (drag: in-flight loss) |

   Real character loss is only ever **1 char in flight**, or **intended overwriting** (3). The agent adds no loss of
   its own beyond the collapsed space. What it adds is **garbling**: A's later keystrokes land elsewhere.
2. **"Is it the same problem with two humans?"**
   - **Partly.** Same position and same words (1d, 3) behave identically, and so does the in-flight keystroke into a
     re-created block. Those are CRDT/caret semantics that any Yjs editor shares.
   - **Not the same:** the span (§2), the missing migrations (§3) and the whitespace collapse (§4). They exist
     because the agent arrives as "old HTML → new HTML" through `simpleDiff`, without a ProseMirror transaction.
     A human editor emits character-level steps plus a step mapping.
   - All three are fixable in the merge. With both prototypes the agent behaved like a human in 28/30 runs.
3. **Carry into the product:**
   - **a word-level text diff** for in-place textblock changes, dropping whitespace-collapse hunks (`--fine-diff`)
   - **position migrations** for everything the merge re-creates (`--migrate-positions`). Better still, upstream:
     an exported y-tiptap API that takes a ProseMirror mapping, or a merge that produces a real ProseMirror
     `Transform` and feeds y-tiptap's own migration code. Both are prototypes here and only cover plain-text
     textblocks.
   - **the caret probe** in every agent response (`caretImpact`). It is cheap: it runs on the fork the merge already
     builds.
4. **`--avoid-caret`:**
   - **Without** the merge fixes: make `--avoid-jump` (the span rule) the default for `patch`, because it blocks
     exactly the bad cases. Spike 08's block-level `--avoid-caret` is too coarse. It would block the harmless 1b, 1c
     and 4b edits, so the agent would learn to ignore it.
   - **With** the fixes, the probe only fires for 1d and 3, which are the same with humans. A **hint** is enough
     there ("Noah's caret is in the words you replace; their next keystrokes will land before your text"). Rewriting
     the very words a user is typing (3) should still be a **proposal**: it overwrites their characters, and a human
     co-author at least sees it happening.
   - Blocking stays justified only for case 3 and for big rewrites of the caret's block while the fixes are not in.
5. Don't use `set-block` for a type change while the user types. It replaces the block with the HTML of the last
   read, so everything typed since that read is gone, not merged. Use `patch` (its SEARCH string fails instead) or a
   real `set-type` op.

## Open questions

- **In-flight keystrokes into a re-created element** (1–2 chars, both sides): could y-tiptap re-apply local pending
  inserts whose parent was deleted remotely, using the migration record? Or should type changes become attribute
  changes in the schema (one `block` node with a `type` attribute, so Yjs never re-creates it)?
- The migration prototype pairs blocks by Y.XmlText, block id, then text, and aligns characters with a word diff.
  Not covered: carets at the very end of a text (y-tiptap's boundary transfers), inline atoms, marks split over
  several Y.XmlTexts, blocks split or merged by the edit. The migration map grows with every structural edit, for the
  editor too. Who prunes it?
- `--fine-diff` handles textblocks changed **in place**. A paragraph split into two, or a list item re-parented, still
  goes through `simpleDiff` / re-creation.
- 1d (caret resting right after a replaced word) is the same for humans. Should the product still special-case it,
  for example by anchoring the caret with `assoc = 0` when the user is idle? That would need a y-tiptap change.
- The human races seen in 1c (a lost keystroke, a scrambled word) happened 2 times in 10 runs. They were not
  investigated further; they come from y-tiptap's caret recovery (spike 06's `CollabCaretFix` covers only part of it).
- Timing: all runs are local (ws latency below 5 ms). With real network latency the in-flight window grows for both
  parties. That is not measured.
- The probe sees only carets that awareness has published. A keystroke typed after the last awareness update is
  invisible to it (in-flight again).
