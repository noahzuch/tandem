# (draft, spike 08) collab skill: section "Editing the document"

> This is the section spike 08 would put into the product's SKILL.md. `collab` stands for the shipped CLI
> (in this spike: `node --import tsx bin/collab.ts`).

## Editing the document

While the document is open in the browser, the user may be typing in it right now. The live document is held by the
collab server, not by the file. **Do not use Edit, Write or MultiEdit on the document's `.html` file while
it is open.** The file is a snapshot. The server rewrites it about a second after every keystroke, so your Edit
can be refused with "File has been modified since read" and your view of the file is up to 3 s old. Every server
write also puts a "file changed on disk" notice into your context.

### 1. Read the live document

```bash
collab read --outline                 # one line per block: line number, type, block id, start of the text,
                                      # and ✎ <name> on the block the user is typing in
collab read --section "3. API" -n     # only that section, with line numbers (the HTML the file will contain)
collab read                           # the whole document
```

Read only the section you are going to change. `read` is always current. The file on disk can lag behind it.

### 2. Change text: `collab patch` (the default)

Send one or more SEARCH/REPLACE blocks. They work like the Edit tool's `old_string`/`new_string`. Copy the SEARCH
text from `collab read`. Put all the edits for one task in **one** patch, because a patch is applied atomically.

```bash
collab patch <<'EOF'
<<<<<<< SEARCH
of reconnecting for a typical day of notes.
=======
of reconnecting, for up to 500 queued notes.
>>>>>>> REPLACE
<<<<<<< SEARCH
  <li><p data-bid="x1ux46">Never lose a note written offline.</p></li>
=======
  <li><p data-bid="x1ux46">Never lose a note written offline.</p></li>
  <li><p>Sync uses at most 2&nbsp;% battery per day.</p></li>
>>>>>>> REPLACE
EOF
```

- SEARCH must match exactly once. Differences in whitespace and line breaks are ignored, because the server
  re-wraps lines. To replace every occurrence, end the block with `>>>>>>> REPLACE ALL`.
- Keep `data-bid="…"` attributes that you copy. New blocks need no id. Write plain HTML like the rest of the file.
  Diagrams go in `<figure>` or `<svg>`.
- The result is `{"ok":true,…}`. If it contains `"warnings"`, the user's caret was in a block you changed. Their
  typing has been merged, but run `collab read` again before you edit that block again.

**If the patch fails, nothing was applied.** Handle it like this:

| error | meaning | what to do |
|---|---|---|
| `NOT_FOUND` (exit 1) | The user changed that text after you read it, or SEARCH never matched. | The output ends with `--- closest block, line N (current html)`. Copy SEARCH from that block and retry once. Do not re-read the whole document. |
| `AMBIGUOUS` (exit 1) | SEARCH matches more than once. The lines are listed. | Add surrounding context, or use `REPLACE ALL` if you really mean every occurrence. |
| `USER_IN_BLOCK` (exit 5, only with `--avoid-caret`) | The user is typing in a block that this patch rewrites. | Wait a few seconds and retry, or use `--propose` (below). |
| `BAD_PATCH` | The SEARCH/REPLACE markers are malformed. | Fix the block syntax. |

### 3. Use these operations instead of a patch when they fit

```bash
collab move-section "4. Conflict handling" "3. API"            # reorder: no copy of the section needed
collab replace-text "Owner: Noah" "Owner: Noah & Claude"         # one short text change, no HTML
collab set-island-text ">Sync server<" ">Sync API<"              # a label inside an SVG/figure
collab append-section '<h2 id="rollout">6. Rollout</h2><p>…</p>'
collab reply <thread> "Done: …" --resolve                        # answer a comment after you changed the text
```

Use `move-section` to reorder sections. A move written as a patch has to repeat the whole section twice (once
deleted, once inserted), so it costs about twice the tokens.

### 4. Large rewrites (many sections, or a new structure): snapshot

```bash
collab export .collab/scratch.html      # a private copy; edit it freely with Edit/Write
collab apply  .collab/scratch.html      # one 3-way merge against the moment of export
```

Apply within a few minutes of the export, then export again for the next round. Anything the user typed since the
export is kept, except in blocks that you rewrote yourself.

### 5. When the user is in the block you want to change

`collab read --outline` shows `✎ Noah` on the block the user is typing in.

- **Small edits** (a word, a number, inserting a list item or a table row) are fine even in that block. Characters
  are merged, and the user's caret stays where it is.
- **Rewriting a whole sentence or paragraph** the user is typing in: don't apply it. Propose it:
  `collab patch --propose --message "Tighten this?" <<'EOF' … EOF`. This creates a change request in the sidebar
  with **Accept change / Reject**. Continue with your other work. You will get the user's decision as a comment event.
- Never retry a `USER_IN_BLOCK` in a tight loop. Wait for your next `collab wait` wake-up, or ask in a reply.

### 6. After editing

Do not check your work by reading the file on disk. Run `collab read --section …`, or trust the `ok` result. Report
what you changed in one line, for example in the comment thread that asked for it (`collab reply <thread> … --resolve`).
