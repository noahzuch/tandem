// PLACEHOLDER (F00) — delete in the next feature

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCT_NAME } from '../shared/product.ts';

afterEach(() => {
  vi.restoreAllMocks();
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
});

describe('server main', () => {
  it('starts on the given port, prints the URL and stops once on SIGINT', async () => {
    const argv = process.argv;
    process.argv = [argv[0] ?? 'node', 'server.js', '--port', '0'];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let resolveExit: (code: number | undefined) => void = () => undefined;
    const exited = new Promise<number | undefined>((resolve) => (resolveExit = resolve));
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => resolveExit(code)) as typeof process.exit);
    try {
      await import('./main.ts');
    } finally {
      process.argv = argv;
    }

    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toMatch(new RegExp(`^${PRODUCT_NAME} placeholder running at http://127\\.0\\.0\\.1:\\d+/$`));
    const url = line.slice(line.indexOf('http'));
    expect((await fetch(new URL('api/hello', url))).status).toBe(200);

    process.emit('SIGINT');
    process.emit('SIGTERM');
    expect(await exited).toBe(0);
    expect(exit).toHaveBeenCalledTimes(1);
    await expect(fetch(url)).rejects.toThrow();
  });
});
