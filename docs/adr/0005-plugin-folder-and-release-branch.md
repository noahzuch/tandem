# 0005 · The plugin lives in `plugin/` and reaches users through a release branch

Status: accepted (F00 · Project setup, 2026-11-09)

## Context

A user should install only the plugin, not the sources, documents and tests. Claude Code warns about a `CLAUDE.md` at
a plugin root, which fails strict validation, and this repository needs its `CLAUDE.md`. The build output must not be
committed on `main`, but an installed plugin needs it.

## Decision

- The plugin root is `plugin/`: `.claude-plugin/plugin.json`, `bin/`, `skills/`, `hooks/`, `evals/` (agent tests,
  the only place `claude plugin eval` accepts) and `dist/` (build output, ignored on `main`).
- The repository root holds `.claude-plugin/marketplace.json`, listing one plugin whose source is a `git-subdir`:
  this repository, path `plugin`, ref `release`. Users add the marketplace from the default branch and install the
  plugin from branch `release`, where the release workflow (F12) commits the built `dist/`.
- `claude plugin validate --strict` runs on `plugin/` and on the repository root.
- During development, `mise run claude-dev` loads the plugin with `--plugin-dir plugin` for one session; normal
  sessions in this repository never load it.

Rejected: plugin root = repository root (users would install sources and docs, and the repository's `CLAUDE.md` fails
strict validation); non-strict validation (hides real warnings); stripping `CLAUDE.md` on release (the release branch
would differ from `main` beyond build output); designing the whole release path now (that is F12's).

## Consequences

- F12 builds the release workflow on this shape; F00 proved it once with a local `release` branch: install through
  the marketplace, executable bit of `bin/tandem` kept, `tandem hello` runs.
- No manifest field can declare a minimum Claude Code version. The README names the version tandem is tested with; a
  feature that needs a minimum checks it in its hooks.
