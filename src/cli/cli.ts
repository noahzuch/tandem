// PLACEHOLDER (F00) — delete in the next feature

import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { greeting } from '../shared/greeting.ts';
import { PRODUCT_NAME } from '../shared/product.ts';

const USAGE = `Usage: ${PRODUCT_NAME} <command>

Commands:
  hello [name]        Print a greeting
  serve [--port n]    Start the local placeholder server (Ctrl+C stops it)
`;

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** Runs one CLI command and resolves with the process exit code. */
export async function runCli(argv: string[], out: Writable): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'hello' && rest.length <= 1) {
    out.write(`${greeting(rest[0] ?? 'world')}\n`);
    return 0;
  }
  if (command === 'serve') {
    const port = parsePort(rest);
    if (port !== null) return serve(port);
  }
  out.write(USAGE);
  return 2;
}

/** Returns the --port value (undefined if absent), or null if the arguments are invalid. */
function parsePort(args: string[]): string | undefined | null {
  try {
    const { values } = parseArgs({ args, options: { port: { type: 'string' } } });
    if (values.port === undefined) return undefined;
    const port = Number(values.port);
    return Number.isInteger(port) && port >= 0 && port <= 65535 ? values.port : null;
  } catch {
    return null;
  }
}

/** Starts the built server next to this file in the foreground and resolves with its exit code. */
function serve(port: string | undefined): Promise<number> {
  const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));
  const args = port === undefined ? [serverPath] : [serverPath, '--port', port];
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
      resolve(code ?? 1);
    });
  });
}
