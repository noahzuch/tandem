# project-collab — spike context

Read this before working on any spike.

## The idea

A Claude Code skill (like lavish — npm package `lavish-axi` by kunchenguid, run `npx -y lavish-axi --help`; source on GitHub
under kunchenguid — or plannotator) that lets a user and the agent
work on one document — usually a spec produced during a brainstorming session — together in the browser.

- The document is an HTML file in the working tree.
- The skill starts a local web server and keeps a connection between the browser and the Claude session.
- Unlike lavish (static page + chat sidebar), the server serves the document as a **WYSIWYG editor
  built on Tiptap** (open-source, extensible). The user edits manually, annotates ranges, and the
  agent edits too — all in one UI.
- Tiptap collaboration (Yjs) may let user and agent edit in parallel without file-on-disk races.
- Open question: store the file as HTML or as Tiptap's internal format (ProseMirror JSON / Yjs).
- A "raw HTML island" node could show agent-drawn HTML (diagrams, SVG) as-is but allow editing its text.
- Annotations like lavish: comments on ranges, sent to the agent.
- Bonus: a configurable page container around the editor, e.g. a sidebar tab with the brainstorming journal.

## Decisions already made by the user

- **Vue 3** for UI (not React). Use `@tiptap/vue-3`. Vite + TypeScript.
- **Open source only**: MIT Tiptap packages, Yjs, self-hosted Hocuspocus. No Tiptap Cloud, no Tiptap Pro / paid extensions.
- **Playwright** (headless Chromium) for verification.

## Conventions for every spike

- Lives in `spikes/project-collab/NN-short-name/`, self-contained `package.json` (own `node_modules`).
  Server code in TypeScript run via `tsx`. Reuse code from earlier spikes by copying, not importing across folders.
- **One-command try-out**: `npm start` (after `npm install`) starts everything and prints the URL to open.
  Use a fixed, spike-specific port: spike NN uses port `51NN` (e.g. spike 03 → 5103); if a second port is needed use `52NN`.
- `npm run verify`: a Playwright script (or node script) that proves the spike's claims headlessly and exits 0/1.
- `README.md` with sections: **Question**, **What I built**, **How to try it** (exact commands + what to do in the UI),
  **Findings** (measured, concrete — include what failed), **Verdict / recommendation for the real product**, **Open questions**.
- Sample documents: use realistic spec-like HTML (headings, paragraphs, lists, tables, code, a callout div, an inline SVG diagram,
  a styled two-column layout). `samples/spec.html` in this folder is the shared sample (created by spike 02); copy it in.

## Environment gotchas

- Work from the worktree root `.claude/worktrees/project-collab` using **relative paths**. A PreToolUse hook blocks any
  Bash command whose text contains the word `n e s s y` (written spaced here on purpose) — including absolute paths.
  So never `cd` or reference absolute paths; use relative ones.
- Never `git stash`. Do **not** commit — the orchestrator reviews and commits.
- Don't touch anything outside `spikes/project-collab/`.
- Stop every server/background process you start before finishing (kill by port/PID).
- Node 24, npm 11. Playwright Chromium may need `npx playwright install chromium` once (global cache).
