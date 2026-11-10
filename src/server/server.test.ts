// PLACEHOLDER (F00) — delete in the next feature

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { greeting } from '../shared/greeting.ts';
import { startServer, type RunningServer } from './server.ts';

let base: string;
let server: RunningServer;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'server-test-'));
  const webRoot = join(base, 'web');
  await mkdir(join(webRoot, 'assets'), { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<p>page</p>');
  await writeFile(join(webRoot, 'assets', 'app.js'), 'console.log(1);');
  await writeFile(join(webRoot, 'assets', 'data.bin'), 'x');
  await writeFile(join(base, 'secret.txt'), 'secret');
  server = await startServer({ port: 0, webRoot });
});

afterAll(async () => {
  await server.close();
  await rm(base, { recursive: true, force: true });
});

/** Sends a raw request, so paths are not normalised the way fetch() would. */
function get(path: string, method = 'GET'): Promise<{ status: number; type: string | undefined; body: string }> {
  const { hostname, port } = new URL(server.url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startServer', () => {
  it('listens on 127.0.0.1 with the actual port in the URL', () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(server.url).not.toContain(':0/');
  });

  it('answers GET /api/hello with the greeting as JSON', async () => {
    const res = await get('/api/hello');
    expect(res.status).toBe(200);
    expect(res.type).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ message: greeting('world') });
  });

  it('serves index.html for /', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.type).toContain('text/html');
    expect(res.body).toBe('<p>page</p>');
  });

  it('serves files from the web root with their content type', async () => {
    const js = await get('/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.type).toContain('text/javascript');
    const bin = await get('/assets/data.bin');
    expect(bin.type).toBe('application/octet-stream');
  });

  it('answers 404 for missing files, directories without index and malformed paths', async () => {
    expect((await get('/missing.js')).status).toBe(404);
    expect((await get('/assets')).status).toBe(404);
    expect((await get('/%E0%A4%A')).status).toBe(404);
  });

  it('answers 404 for paths that leave the web root', async () => {
    expect((await get('/../secret.txt')).status).toBe(404);
    expect((await get('/..%2fsecret.txt')).status).toBe(404);
    expect((await get('/assets/..%2f..%2fsecret.txt')).status).toBe(404);
  });

  it('answers 405 for other methods', async () => {
    const res = await get('/api/hello', 'POST');
    expect(res.status).toBe(405);
  });

  it('close rejects when the server is not running', async () => {
    const other = await startServer({ port: 0, webRoot: base });
    await other.close();
    await expect(other.close()).rejects.toThrow();
  });

  it('rejects when the port is taken', async () => {
    const port = Number(new URL(server.url).port);
    await expect(startServer({ port, webRoot: base })).rejects.toThrow(/EADDRINUSE/);
  });
});
