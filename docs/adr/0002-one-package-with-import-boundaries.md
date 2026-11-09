# 0002 · One package with enforced import boundaries

Status: accepted (F00 · Project setup, 2026-11-09)

## Context

tandem has code that runs in Node (the CLI and the local server), code that runs in the browser (the editor page),
and code both share. It ships as one bundled Claude Code plugin; nothing is published as a separate package. Mixing
the environments by accident — a Node module pulled into the page, server code pulled into the CLI — breaks the build
or bloats a bundle, and is easy for an agent to do.

## Decision

The repository is one pnpm package with four source folders:

- `src/cli/` and `src/server/` run in Node, `src/web/` in the browser, `src/shared/` in both.
- `cli`, `server` and `web` may import `shared`, but not each other. The CLI starts the built server as a process
  instead of importing its code.
- `shared` imports none of the other folders and no Node built-ins; `web` imports no Node built-ins.
- No circular imports, no orphan modules, and no development-only dependency in code that ships.

The rules are enforced by dependency-cruiser (`.dependency-cruiser.cjs`, `mise run arch`) before each commit that
touches `src/` and in CI. TypeScript enforces the environments too: `tsconfig.node.json` has Node types and no DOM,
`tsconfig.web.json` has DOM types and no Node types, and both include `src/shared`.

Rejected: a workspace of several packages (per-package configuration and linking pay off for separately published
packages, not for one bundled plugin)

## Consequences

- New folders under `src/` need a rule in `.dependency-cruiser.cjs`.
- Bundling mistakes surface at commit time instead of at runtime.
