// PLACEHOLDER (F00) — delete in the next feature

import { afterEach, describe, expect, it, vi } from 'vitest';
import { greeting } from '../shared/greeting.ts';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('cli main', () => {
  it('runs the command from argv and sets the exit code', async () => {
    const argv = process.argv;
    process.argv = [argv[0] ?? 'node', 'cli.js', 'hello'];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await import('./main.ts');
    } finally {
      process.argv = argv;
    }
    expect(write).toHaveBeenCalledWith(`${greeting('world')}\n`);
    expect(process.exitCode).toBe(0);
  });
});
