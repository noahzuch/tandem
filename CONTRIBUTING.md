# Contributing

These rules apply to everyone working in this repository, human or agent. The reasons are in the architecture
decision records in [`docs/adr/`](docs/adr/).

## Setup

Install [mise](https://mise.jdx.dev/getting-started.html), then run `mise install` in the repository. It installs the
pinned Node and pnpm, the dependencies, the Playwright browser and the git hooks. After a pull that changed
dependencies, run `mise run setup`. The tasks that check the plugin use a pinned Claude Code version, which mise
installs on first use; `claude` in your shell stays your own installation. macOS and Linux only.

## Tasks

Every tool that checks or formats code has a local task, which fixes what it can, and a `-ci` variant, which never
changes files and fails on any finding: `format`, `lint`, `typecheck`, `arch` (import rules), `plugin-validate`,
`test` (unit tests; the `-ci` variant adds the coverage gate), `e2e` (end-to-end tests against the built plugin) and
`test-agent` (agent tests, costs model usage). Aggregates: `check-fast` (everything but tests), `check` (everything),
`check-ci` (exactly what CI runs). Plain tasks: `setup`, `build`, `serve`, `claude-dev`.

Every report a tool writes goes to the git-ignored `reports/` folder: `coverage/`, `unit/junit.xml`, `e2e/html/` and
`e2e/results/` (traces and screenshots of failed end-to-end tests), `arch.md` and `agent-tests/`.

## Git hooks

lefthook runs before each commit: format and lint on the staged files (fixes are staged again), a type check of the
whole project when TypeScript or Vue changed, the import rules when `src/` changed, plugin validation when `plugin/`
changed. Before each push: the unit tests when `src/` changed. Hooks should take about 10 s before a commit and 60 s
before a push; if they get slower, make the tools faster.

**Never skip hooks** (`--no-verify` or similar). When a hook fails, fix the cause.

## Changing `main`

1. Work on a branch. Commits inside a branch are free-form.
2. Open a pull request to `main`. Its title follows [Conventional Commits](https://www.conventionalcommits.org/):
   `type(scope)?: description`, type one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
   `chore`, `revert`. The `pr-title` check enforces it.
3. All required checks must be green: `check (pinned)`, `check (lts)`, `pr-title`. Lint and type errors appear as annotations
   on the changed lines.
4. The pull request is squash-merged: one pull request becomes one commit on `main`, with the title as message.

Nobody pushes to `main` directly. **Coverage gate:** every file a pull request adds or changes under `src/` must reach
at least 80 % line and 80 % branch coverage from unit tests, on its own. A new file without tests counts as 0 %. Unit
tests sit next to the code as `‹name›.test.ts`; end-to-end tests live in `e2e/`.

Agent tests run only on demand (by hand, or with the label `agent-tests`, which only the maintainer sets) and are not
a required check.

## Specifying features

Features are specified one by one in [`docs/features/`](docs/features/index.html), following
[`docs/features/SPEC-PROCESS.md`](docs/features/SPEC-PROCESS.md):

- A spec is self-contained. It states every decision with its rejected alternatives and never relies on a spike or the
  spike summary; a spike may be mentioned as a soft reference (branch `spike` and a path, as text).
- Brainstorming journals (`docs/features/*-decisions.md`) are working notes. They are git-ignored and never committed.
- Spikes live on branch `spike` and are evidence, not a blueprint: their code is never copied in as the design.

## Done means documented

A spec is frozen once its feature is implemented. Implementing a feature includes updating the living documents:

- [`docs/architecture/index.html`](docs/architecture/index.html) — the system as it is now;
- [`docs/adr/`](docs/adr/) — a new ADR, or one that supersedes an old one, when a binding decision is made or changed;
- README.md and this file, when setup, tasks or rules change.

The pull-request template asks for tests, living documents and ADRs on every pull request.

`docs/` is never formatted by Prettier: its HTML files are tandem documents whose formatting tandem itself will own.
