# tandem

> **Working name.** "tandem" is a placeholder name and is already taken by a similar project. It will change; see
> [Renaming](#renaming).

tandem lets you write and edit HTML documents together with a coding agent. You open an HTML document — a spec, an
exploration, an explanation — in a browser-based WYSIWYG editor while Claude Code works on the same document live:
both edit at the same time, you comment and send feedback, the agent answers and edits in place. The HTML file on
disk stays the source of truth. tandem ships as a Claude Code plugin.

## Status

Specification phase. The repository has its tooling and a throwaway placeholder; the product is specified feature by
feature in [`docs/features/index.html`](docs/features/index.html).

## Prerequisites

- macOS or Linux
- [mise](https://mise.jdx.dev/getting-started.html) — installs everything else
- Claude Code, to try the plugin interactively. tandem is tested with **Claude Code 2.1.319** (the version mise pins
  for the checks).

## Setup

```sh
git clone https://github.com/noahzuch/tandem.git
cd tandem
mise install
```

`mise install` installs the pinned Node and pnpm, then runs `mise run setup`: the dependencies, the Playwright browser
and the git hooks. mise runs that step only when it installed a tool, so after a pull that changed dependencies, run
`mise run setup` yourself. The checks run a pinned Claude Code (installed by mise on first use); `claude` in your shell,
and `mise run claude-dev`, use your own installation.

## Tasks

| Task                  | What it does                                                                  |
| --------------------- | ----------------------------------------------------------------------------- |
| `mise run check-fast` | Format, lint, type check, import rules, plugin validation (fixes what it can) |
| `mise run check`      | `check-fast` plus unit and end-to-end tests                                   |
| `mise run check-ci`   | Checks for the CI, without auto fix and with reporting                        |
| `mise run build`      | Build page, server and CLI into `plugin/dist/`                                |
| `mise run serve`      | Build and start the placeholder server                                        |
| `mise run claude-dev` | Build and start Claude Code with the plugin loaded from `plugin/`             |
| `mise run test-agent` | Run the agent tests (costs model usage)                                       |

Each tool also has its own task (`format`, `lint`, `typecheck`, `arch`, `plugin-validate`, `test`, `e2e`) and a
`-ci` variant. `mise tasks` lists them all.

## Trying the skeleton

```sh
mise run serve
# tandem placeholder running at http://127.0.0.1:53817/
```

Open the printed URL: the page fetches a greeting from the server. Ctrl+C stops it. `plugin/bin/tandem hello` prints
the greeting directly.

To try the plugin, run `mise run claude-dev` and ask Claude to greet you using the tandem plugin. After a change,
rebuild (`mise run build`) and run `/reload-plugins` in that session. Nothing is installed and nothing is written to
your Claude Code settings; normal Claude Code sessions in this repository don't load the plugin.

## How changes are made

Work on a branch. Git hooks format and lint what you commit and type-check the project; the unit tests run before a
push. Open a pull request whose title follows Conventional Commits (`feat(cli): add serve command`). CI must be green
— including coverage of at least 80 % for every changed file — before the pull request is squash-merged into `main`.
Details: [CONTRIBUTING.md](CONTRIBUTING.md).

## Renaming

The working name appears in code once, as `PRODUCT_NAME` in `src/shared/product.ts`, and otherwise only where a file
name or manifest cannot refer to a constant. To rename, change:

1. `src/shared/product.ts` — `PRODUCT_NAME`
2. `plugin/bin/tandem` — the file name (the command users and Claude run)
3. `plugin/skills/tandem/` — the folder name, and `name` in its `SKILL.md`
4. `plugin/.claude-plugin/plugin.json` — `name`, `repository`
5. `.claude-plugin/marketplace.json` — `name`, the plugin's `name` and source `url`
6. `package.json` — `name`
7. `plugin/evals/` — the expected command and greeting in the graders
8. This README and CLAUDE.md

## Licence

[MIT](LICENSE)
