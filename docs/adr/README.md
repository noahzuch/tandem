# Architecture decision records

The decisions that bind later features, and why they were made. The current state of the system is described in
[`../architecture/index.html`](../architecture/index.html); these records are its history.

Each record is `NNNN-title.md` with Status, Context, Decision and Consequences. Status is `proposed`, `accepted` or
`superseded by NNNN`. A record is never rewritten once accepted: a changed decision gets a new record that supersedes
the old one, and the old one's status points to it.

| ADR                                                | Decision                                                 | Status   |
| -------------------------------------------------- | -------------------------------------------------------- | -------- |
| [0001](0001-working-conventions.md)                | Working conventions: specs, living documents, git flow   | accepted |
| [0002](0002-one-package-with-import-boundaries.md) | One package with four source folders and enforced import rules | accepted |
| [0003](0003-bundle-everything-with-vite.md)        | All runtime dependencies bundled; Vite builds every output | accepted |
| [0004](0004-node-24-on-users-machines.md)          | Node 24 or newer on users' machines                      | accepted |
| [0005](0005-plugin-folder-and-release-branch.md)   | The plugin lives in `plugin/` and reaches users through a release branch | accepted |
| [0006](0006-setup.md)                              | Setup: tools, versions, hooks, coverage, CI baseline, licence | accepted |
