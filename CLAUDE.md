# Tandem

@README.md

Tandem (working name) is a tool to edit + write HTML files together (in tandem) with an agent. The user opens an HTML
document (a spec, an exploration, an explanation …) in a browser-based WYSIWYG editor while Claude Code works on the
same document live: both edit at the same time, the user comments and sends feedback, the agent answers and edits in
place. The HTML file on disk stays the source of truth and the agent's language. It ships as its own Claude Code
plugin (a skill, hooks and a CLI), separate from nessy.

Fixed so far: Vue 3 + Tiptap (`@tiptap/vue-3`), Vite, TypeScript; open source only (MIT Tiptap packages, Yjs,
self-hosted Hocuspocus — no Tiptap Cloud/Pro); Playwright for verification; Claude Code only for now, but the editor,
server and collaboration must not depend on the coding tool; macOS and Linux only. The current state of the system is
in [`docs/architecture/index.html`](docs/architecture/index.html), the binding decisions in [`docs/adr/`](docs/adr/).

**Follow [CONTRIBUTING.md](CONTRIBUTING.md)** — setup, tasks, hooks, pull requests, how features are specified and
what "done" means. The README has an overview and the renaming steps.

## Rules for agents

- Never push unless the user explicitly asks for it. Commit only when asked.
- Never skip git hooks (`git commit --no-verify`, `git push --no-verify` or similar) unless the user explicitly asks.
  If a hook fails, fix the cause.
- Spikes (branch `spike`, read them in a worktree: `git worktree add ../tandem-spike spike`) are a reference, not a
  blueprint: every decision a spike made is open until a feature spec revalidates it, and spike code is never copied
  in as the design.
- Keep the working name "tandem" in as few places as possible (see Renaming in the README).
- Everything under `src/` and the plugin's stub skill, hook and agent-test case is a placeholder from F00, marked
  `PLACEHOLDER (F00)`. The next feature deletes it before building anything; nothing may depend on it.
