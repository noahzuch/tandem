# Tandem

Tandem (working name) is a tool to edit + write HTML files together (in tandem) with an agent. The user opens an HTML
document (a spec, an exploration, an explanation …) in a browser-based WYSIWYG editor while Claude Code works on the
same document live: both edit at the same time, the user comments and sends feedback, the agent answers and edits in
place. The HTML file on disk stays the source of truth and the agent's language. It ships as its own Claude Code
plugin (a skill, hooks and a CLI), separate from nessy.

## Status

Specification phase. The product code does not exist yet; features are specified one by one, starting with
F00 · Project setup.

## Where things are

- `features/index.html` — the feature list (F00–F12). Each `‹NN›-‹slug›.html` is either a feature page
  (badge "specification pending") or, once specified, the full spec.
- `features/SPEC-PROCESS.md` — how a feature page becomes a spec. Read it before working on a spec.
- `features/templates/` — spec template, a filled-in example and the diagram templates.
- `features/‹NN›-‹slug›-decisions.md` — brainstorming journal of a feature (local while it is being written).
- Branch `spike` — the throwaway spikes `01-…`–`11-…` and `SUMMARY.html` (results, notes `N1`–`N24`, risks).
  Feature pages link to them with `../`; read them in a worktree: `git worktree add ../tandem-spike spike`.

## Working rules

- Changes reach `main` only through pull requests; `main` is protected and requires green CI.
- Never push unless the user explicitly asks for it. Commit only when asked.
- Spikes are loose evidence, not a blueprint: every decision a spike made is open until a feature spec revalidates
  it, and spike code is never copied in as the design (see `features/SPEC-PROCESS.md`).
- "tandem" is only a working name and is taken by a similar project: keep the name in as few places as possible so
  renaming stays cheap.

## Fixed so far

- Vue 3 + Tiptap (`@tiptap/vue-3`), Vite, TypeScript.
- Open source only: MIT Tiptap packages, Yjs, self-hosted Hocuspocus — no Tiptap Cloud/Pro.
- Playwright (headless Chromium) for verification.
- Claude Code only for now; the editor, server and collaboration must not depend on the coding tool.
- macOS and Linux; no Windows for now.
