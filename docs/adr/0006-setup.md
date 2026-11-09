# 0006 · Setup

Status: accepted (F00 · Project setup, 2026-11-09)

## Context

Every later feature is built in this repository, mostly by agents. The tools, versions and checks must be the same on
every machine and in CI, and give feedback early enough that problems are fixed where they are made. This record
lists the tool choices of F00 with short reasons; the details are in the F00 spec
([`../features/00-project-setup.html`](../features/00-project-setup.html)) and in the configuration files.

## Decision

| Area | Choice | Why, and what lost |
| --- | --- | --- |
| Tools and tasks | **mise** pins Node, pnpm and Claude Code and is the task runner (`mise.toml`) | One prerequisite; runs aggregates in parallel. `package.json` scripts pin nothing. |
| Package manager | **pnpm**, minimum release age kept, install scripts off | Strict `node_modules`: undeclared imports cannot slip into the bundle. npm's protections are off by default. |
| Versions | **Exact versions** for every direct dependency, lockfile committed, frozen in CI | Every upgrade is visible; server and browser can share identical packages. Ranges or exact-only-for-some lost. |
| Hooks | **lefthook** (dev dependency): pre-commit formats and lints staged files, type-checks the project, checks import rules and the plugin; pre-push runs unit tests | Budget about 10 s / 60 s. Type checking never moves out of pre-commit: cross-file type errors are cheapest at commit. husky + lint-staged (two tools) and hk lost. |
| Lint and format | **ESLint** with typescript-eslint (type-aware) and eslint-plugin-vue, **Prettier** (not on `docs/`) | Established Vue path. Biome (partial Vue support) and oxlint + oxfmt (no official Vue template linting, formatter pre-1.0) lost. |
| Architecture | **dependency-cruiser** | See [0002](0002-one-package-with-import-boundaries.md). |
| Unit tests | **Vitest**: Node for cli/server/shared, **happy-dom** for web; browser mode only where needed | Most components don't need a real browser. |
| End-to-end | **Playwright Test** with Chromium, against the built plugin through `bin/tandem` | Tests what users run. |
| Agent tests | **`claude plugin eval`**, on demand only, cases in `plugin/evals/` | Cost money and vary; never in hooks or required checks. |
| TypeScript | **TypeScript 6**, ESM only, `strict` plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `erasableSyntaxOnly` | TS 7 has no stable API for vue-tsc and typescript-eslint yet. `exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature` fight library types. |
| Coverage | Every file a pull request adds or changes: **≥ 80 % lines and branches** on its own, from unit tests | Only-added files, changed lines only, or e2e coverage lost (own scripts, external services, no branch signal). |
| CI | GitHub Actions, Linux: `check` (`mise run check-ci`, as a matrix on the pinned Node 24 and on the latest Node LTS), `pr-title`; agent tests on demand | macOS CI is decided in F01. |
| CI security | Read-only default token, per-job permissions, third-party actions pinned to commit SHAs, Claude credential only in `agent-tests.yml` and never for forks, secret scanning with push protection, Dependabot alerts | Basics before the repository holds a secret. Dependabot update PRs are F12's. |
| Editors | Only an **`.editorconfig`** | Committed editor settings fight personal setups; hooks and CI enforce the result. |
| Licence | **MIT** | Apache-2.0's patent grant buys little for a local plugin; AGPL deters users. |

## Consequences

- `mise install` is the only setup step; after a pull that changed dependencies, `mise run setup`.
- Hooks and CI call the same mise tasks, so local and CI results agree.
- A slow hook is fixed by making the tool faster, not by moving checks out of it.
