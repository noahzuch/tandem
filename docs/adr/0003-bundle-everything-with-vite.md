# 0003 · All runtime dependencies bundled; Vite builds every output

Status: accepted (F00 · Project setup, 2026-11-09)

## Context

The plugin runs on users' machines. Any install step there (an `npm install`, or Claude Code installing dependencies
from a lockfile next to a `package.json`) can fail and may resolve versions that were never tested. Later features
bring heavy libraries (Yjs, Hocuspocus, an HTML parser) that must exist exactly once in the browser and once on the
server; a second copy of Yjs breaks its `instanceof` checks.

## Decision

One `vite.config.ts` builds three outputs into `plugin/dist/`: the page (`web/`, for the browser, from `src/web`),
the server (`server.js`) and the CLI (`cli.js`), both for Node 24 from `src/server` and `src/cli` with every
dependency inlined (`resolve.noExternal: true`). `plugin/` has no `package.json`, so Claude Code never installs
dependencies for it.

Rejected: tsdown or esbuild for the Node bundles (a second build configuration or engine whose resolution can differ
from the page build); `node_modules` on the release branch, or letting Claude Code install from a lockfile (an install
step on users' machines and untested versions).

## Consequences

- An installed plugin needs only Node; it runs exactly the versions that were tested.
- Shared code and libraries are resolved the same way for browser and Node.
- Features that add heavy runtime libraries (F02, F05) must prove that they bundle, and that server and browser use
  one pinned copy of shared collaboration packages.
- If Vite's Node build stops working for a library, the fallback is a Node-library bundler for the two Node outputs
  only, keeping Vite for the page (a new ADR).
