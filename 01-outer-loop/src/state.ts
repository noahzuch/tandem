// Shared helpers for the CLI and the server: where state lives and how to talk HTTP
// without fetch/undici's 300 s headers/body timeouts (long-polls can last up to ~10 min).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const DEFAULT_PORT = Number(process.env.COLLAB_PORT || 5101);
export const APP_ID = "collab-spike-01";

/** One state dir per document: `<doc dir>/.collab/<doc basename>/`. */
export function stateDirFor(doc: string): string {
  const abs = path.resolve(doc);
  return path.join(path.dirname(abs), ".collab", path.basename(abs));
}

export interface ServerInfo {
  app: string;
  pid: number;
  port: number;
  url: string;
  doc: string;
  startedAt: string;
}

export function serverInfoFile(stateDir: string): string {
  return path.join(stateDir, "server.json");
}

export function readServerInfo(stateDir: string): ServerInfo | null {
  try {
    return JSON.parse(fs.readFileSync(serverInfoFile(stateDir), "utf8")) as ServerInfo;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface HttpResult {
  status: number;
  body: string;
  json: any;
}

/**
 * Plain node:http request with NO client-side timeout, so a long-poll can stay open as
 * long as the server wants. Rejects with code "ECONNRESET"/"ECONNREFUSED" when the server dies.
 */
export function request(
  method: string,
  url: string,
  body?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      url,
      {
        method,
        agent: false,
        headers: data ? { "content-type": "application/json", "content-length": data.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("aborted", () => reject(Object.assign(new Error("response aborted"), { code: "ECONNRESET" })));
        res.on("end", () => {
          if (!res.complete) {
            reject(Object.assign(new Error("response incomplete (server died?)"), { code: "ECONNRESET" }));
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = text.trim() ? JSON.parse(text) : null;
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, body: text, json });
        });
      },
    );
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Returns health JSON if a collab server for `doc` answers at `info.url`, else null. */
export async function probe(info: ServerInfo | null, doc: string): Promise<any | null> {
  if (!info) return null;
  try {
    const r = await request("GET", `${info.url}/health`, undefined, { timeoutMs: 1500 });
    if (r.status === 200 && r.json?.app === APP_ID && r.json?.doc === path.resolve(doc)) return r.json;
  } catch {
    /* not reachable */
  }
  return null;
}
