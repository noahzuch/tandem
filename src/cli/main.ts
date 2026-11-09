// PLACEHOLDER (F00) — delete in the next feature
// Entry of dist/cli.js, called through plugin/bin/tandem.

import { runCli } from './cli.ts';

process.exitCode = await runCli(process.argv.slice(2), process.stdout);
