// PLACEHOLDER (F00) — delete in the next feature

import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { greeting } from '../shared/greeting.ts';

class FakeChild extends EventEmitter {
  kill = vi.fn<(signal: NodeJS.Signals) => boolean>(() => true);
}

const spawned: { command: string; args: string[]; child: FakeChild }[] = [];

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    const child = new FakeChild();
    spawned.push({ command, args, child });
    return child;
  },
}));

const { runCli } = await import('./cli.ts');

function output(): { stream: Writable; text: () => string } {
  let text = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
}

beforeEach(() => {
  spawned.length = 0;
});

afterEach(() => {
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
});

describe('runCli hello', () => {
  it('greets the world by default', async () => {
    const out = output();
    expect(await runCli(['hello'], out.stream)).toBe(0);
    expect(out.text()).toBe(`${greeting('world')}\n`);
  });

  it('greets the given name', async () => {
    const out = output();
    expect(await runCli(['hello', 'Ada'], out.stream)).toBe(0);
    expect(out.text()).toBe(`${greeting('Ada')}\n`);
  });
});

describe('runCli usage', () => {
  it.each([
    [[]],
    [['nope']],
    [['hello', 'a', 'b']],
    [['serve', '--port', 'x']],
    [['serve', '--port', '70000']],
    [['serve', '--bogus']],
  ])('prints usage and returns 2 for %j', async (argv) => {
    const out = output();
    expect(await runCli(argv, out.stream)).toBe(2);
    expect(out.text()).toContain('Usage:');
    expect(spawned).toHaveLength(0);
  });
});

describe('runCli serve', () => {
  it('starts server.js next to the CLI with the given port and returns its exit code', async () => {
    const result = runCli(['serve', '--port', '4321'], output().stream);
    const [run] = spawned;
    expect(run?.command).toBe(process.execPath);
    expect(run?.args[0]).toMatch(/server\.js$/);
    expect(run?.args.slice(1)).toEqual(['--port', '4321']);
    run?.child.emit('exit', 3, null);
    expect(await result).toBe(3);
  });

  it('passes no port when none is given', async () => {
    const result = runCli(['serve'], output().stream);
    expect(spawned[0]?.args).toHaveLength(1);
    spawned[0]?.child.emit('exit', 0, null);
    expect(await result).toBe(0);
  });

  it('forwards SIGINT and SIGTERM to the server and stops forwarding once it exits', async () => {
    const result = runCli(['serve'], output().stream);
    const child = spawned[0]?.child;
    // Node passes the signal name to signal listeners; process.emit does not, so pass it here.
    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGTERM', 'SIGTERM');
    expect(child?.kill.mock.calls).toEqual([['SIGINT'], ['SIGTERM']]);
    child?.emit('exit', null, 'SIGTERM');
    expect(await result).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(0);
  });
});
