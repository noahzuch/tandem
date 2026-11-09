// PLACEHOLDER (F00) — delete in the next feature

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { greeting } from '../shared/greeting.ts';

export interface StartOptions {
  port: number;
  webRoot: string;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';

const TEXT = 'text/plain; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': JSON_TYPE,
  '.svg': 'image/svg+xml',
};

/** Starts the placeholder HTTP server on 127.0.0.1 and resolves once it is listening. */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const webRoot = resolve(options.webRoot);
  const server = createServer((req, res) => {
    void handle(req, res, webRoot);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port, HOST, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${HOST}:${port}/`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
        server.closeAllConnections();
      }),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, webRoot: string): Promise<void> {
  if (req.method !== 'GET') {
    send(res, 405, TEXT, 'Method Not Allowed', { Allow: 'GET' });
    return;
  }
  const pathname = new URL(req.url ?? '/', `http://${HOST}`).pathname;
  if (pathname === '/api/hello') {
    send(res, 200, JSON_TYPE, JSON.stringify({ message: greeting('world') }));
    return;
  }
  const file = resolveFile(webRoot, pathname);
  if (file === undefined) {
    notFound(res);
    return;
  }
  try {
    const body = await readFile(file);
    send(res, 200, CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', body);
  } catch {
    notFound(res);
  }
}

/** Maps a URL path to a file inside webRoot, or undefined if the path is malformed or leaves webRoot. */
function resolveFile(webRoot: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const relative = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const file = resolve(webRoot, `.${relative}`);
  return file.startsWith(webRoot + sep) ? file : undefined;
}

function notFound(res: ServerResponse): void {
  send(res, 404, TEXT, 'Not Found');
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': contentType, ...headers });
  res.end(body);
}
