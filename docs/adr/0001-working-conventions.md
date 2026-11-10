# 0001 · Working conventions

Status: accepted (F00 · Project setup, 2026-11-09)

## Context

Most of tandem is written by coding agents, one feature at a time, from specifications. Without fixed conventions,
each feature would decide again where specs live, whether they are kept up to date, how changes reach `main`, and
whether local checks may be skipped. Decisions would get lost between brainstorming and spec, and specs that are
edited after implementation would no longer say what was decided when.

## Decision

- **Specs** live in `docs/features/‹NN›-‹slug›.html` and are written by the process in
  [`docs/features/SPEC-PROCESS.md`](../features/SPEC-PROCESS.md). A spec is self-contained: it states every decision
  with its rejected alternatives and never relies on a spike or on the spike summary.
- **Brainstorming journals** (`docs/features/‹NN›-‹slug›-decisions.md`) are working notes, git-ignored and never
  committed. Everything accepted in a journal ends up in the spec; binding decisions also in an ADR.
- **Spikes** stay on branch `spike`. Specs mention them only as soft references — the branch and a path, as text.
- **Specs are frozen** once their feature is implemented. The **living documents** — the architecture document in
  `docs/architecture/`, these ADRs, README.md and CONTRIBUTING.md — are updated by every feature's implementation;
  a feature is done only when they describe the system as it is.
- **Changes reach `main` only through pull requests:** a branch, a pull request whose title follows Conventional
  Commits, all required checks green, then a squash merge.
- **Git hooks are never skipped.** When a hook fails, the cause is fixed. Agents never push and never skip hooks
  unless the user explicitly asks.

## Consequences

- One commit on `main` per pull request; its message is the pull request's title, which F12 can turn into a changelog.
- The spec of a feature remains the record of what was decided at the time; the current state is in the living
  documents, which must be updated in the same pull request as the code (the pull-request template asks for it).
- Journals and spikes can be thrown away without breaking any committed document.
