# 0004 · Node 24 or newer on users' machines

Status: accepted (F00 · Project setup, 2026-11-09)

## Context

The bundled CLI and server need Node. Claude Code itself no longer needs Node, so a plugin user may have none, or an
old one. Node 22's support ends around April 2027, likely before tandem's first release; Node 24 is supported until
about April 2028.

## Decision

Plugin users need Node 24 or newer. The plugin's entry point `plugin/bin/tandem` is a bash script (bash 3.2, as on
macOS) that checks for `node` and its major version and, if it is missing or older than 24, says which version is
needed and where to get it, and exits non-zero. Otherwise it runs `dist/cli.js`. The bundles target Node 24. mise pins
Node 24 for development; CI runs all checks on that version and again on the latest Node LTS.

Rejected: Node 22 (support probably ends before the first release); standalone executables (four build targets and about
100 MB each).

## Consequences

- The minimum must be raised before April 2028.
- Only macOS and Linux are supported for now; Windows would need a different entry point.
