// Fixtures for end-to-end tests. `startCli` starts plugin/bin/tandem with arguments, waits for the URL it prints and
// stops the process after the test.

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';

export const CLI = fileURLToPath(new URL('../plugin/bin/tandem', import.meta.url));

export interface RunningCli {
  /** The first http(s) URL the process printed. */
  url: string;
  process: ChildProcess;
  /** Everything the process wrote to stdout and stderr so far. */
  output(): string;
}

const URL_PATTERN = /https?:\/\/\S+/;

function start(args: string[], timeoutMs = 10_000): Promise<RunningCli> {
  const child = spawn(CLI, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`No URL printed within ${timeoutMs} ms. Output:\n${output}`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = URL_PATTERN.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve({ url: match[0], process: child, output: () => output });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Exited with ${code} before printing a URL. Output:\n${output}`));
    });
  });
}

function stop(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.kill('SIGINT');
  });
}

export const test = base.extend<{ startCli: (args: string[]) => Promise<RunningCli> }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires an object pattern for fixtures without dependencies
  startCli: async ({}, use) => {
    const started: ChildProcess[] = [];
    await use(async (args) => {
      const cli = await start(args);
      started.push(cli.process);
      return cli;
    });
    await Promise.all(started.map(stop));
  },
});

export { expect } from '@playwright/test';
export { stop };
