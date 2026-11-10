// CI REPORT DEMO — deliberate failures to inspect the CI summary and annotations; never merge.

// arch: the CLI must not import the server (no-cross-environment).
import { startServer } from '../server/server.ts';

// typecheck: two type errors.
export const port: number = 'not a number';
export const missing = startServer.doesNotExist;

// lint: two errors and a warning (an unused disable directive).
let neverReassigned = 1;
export const unsafe = JSON.parse('{}');
// eslint-disable-next-line no-console
export const fine = neverReassigned;
