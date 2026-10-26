// The detached per-document server. Started by `collab open` as:
//   node --import tsx src/server.ts <doc> <stateDir> <preferredPort>
//
// Responsibilities:
//   - serve the browser page (/), the document (/doc) and a WebSocket (/ws)
//   - append every browser event to an on-disk, append-only queue (events.jsonl) with a monotonic seq
//   - long-poll endpoint for the agent (/api/wait) with per-consumer cursors (cursors.json, ack'd explicitly)
//   - agent pushes (/api/push) are broadcast to all browsers and replayed on (re)connect (pushes.jsonl)
//   - presence: browsers see whether an agent is currently listening; the agent gets a `browser_closed`
//     event when the last browser tab has been gone for a grace period
//   - self-shutdown after an idle period with no browser and no waiting agent
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { APP_ID, serverInfoFile, type ServerInfo } from "./state.ts";

const [docArg, stateDir, portArg] = process.argv.slice(2);
if (!docArg || !stateDir) {
  console.error("usage: server.ts <doc> <stateDir> [port]");
  process.exit(1);
}
const doc = path.resolve(docArg);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const DISCONNECT_GRACE_MS = Number(process.env.COLLAB_DISCONNECT_GRACE_MS || 8000);
const IDLE_SHUTDOWN_MS = Number(process.env.COLLAB_IDLE_MS || 30 * 60_000);
const HEARTBEAT_MS = 15_000;

fs.mkdirSync(stateDir, { recursive: true });
const eventsFile = path.join(stateDir, "events.jsonl");
const pushesFile = path.join(stateDir, "pushes.jsonl");
const cursorsFile = path.join(stateDir, "cursors.json");

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

type Ev = { seq: number; ts: string; type: string; [k: string]: unknown };

function readJsonl<T>(file: string): T[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

// ---- durable state (survives server crash/restart) ----
const events: Ev[] = readJsonl<Ev>(eventsFile);
let seq = events.at(-1)?.seq ?? 0;
const pushes: Record<string, unknown>[] = readJsonl(pushesFile);
let cursors: Record<string, number> = {};
try {
  cursors = JSON.parse(fs.readFileSync(cursorsFile, "utf8"));
} catch {
  /* fresh */
}

// ---- volatile state ----
interface Waiter {
  consumer: string;
  res: http.ServerResponse;
  settleMs: number;
  timer?: NodeJS.Timeout;
  settleTimer?: NodeJS.Timeout;
  heartbeat?: NodeJS.Timeout;
  done: boolean;
}
const waiters = new Map<string, Waiter>(); // one active long-poll per consumer
const clients = new Set<WebSocket>();
let everHadBrowser = false;
let disconnectTimer: NodeJS.Timeout | null = null;
let lastActivity = Date.now();

function pending(consumer: string): Ev[] {
  const after = cursors[consumer] ?? 0;
  return events.filter((e) => e.seq > after);
}

function addEvent(type: string, data: Record<string, unknown>): Ev {
  const ev: Ev = { seq: ++seq, ts: new Date().toISOString(), type, ...data };
  events.push(ev);
  fs.appendFileSync(eventsFile, JSON.stringify(ev) + "\n");
  log("event", ev.seq, type);
  for (const w of waiters.values()) scheduleDelivery(w);
  onNewEvent();
  return ev;
}
let onNewEvent: () => void = () => {};

function finishWaiter(w: Waiter, payload: Record<string, unknown>) {
  if (w.done) return;
  w.done = true;
  clearTimeout(w.timer);
  clearTimeout(w.settleTimer);
  clearInterval(w.heartbeat);
  if (waiters.get(w.consumer) === w) waiters.delete(w.consumer);
  if (!w.res.writableEnded) w.res.end(JSON.stringify(payload));
  broadcastPresence();
}

/** Small settle window so a burst of events (typing, several clicks) arrives as one batch. */
function scheduleDelivery(w: Waiter) {
  if (w.done || w.settleTimer) return;
  w.settleTimer = setTimeout(() => {
    const evs = pending(w.consumer);
    if (evs.length) finishWaiter(w, { status: "events", events: evs, ack: evs.at(-1)!.seq });
    else w.settleTimer = undefined;
  }, w.settleMs);
}

function broadcast(msg: unknown) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
  return clients.size;
}
/** Consumers that would notice a browser event right now ("terminal" = the human's npm start log, not an agent). */
function listeningConsumers(): string[] {
  const all = new Set([...waiters.keys(), ...agentSockets.values()]);
  all.delete("terminal");
  return [...all];
}
function broadcastPresence() {
  broadcast({ type: "presence", agentListening: listeningConsumers() });
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const t = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(t ? JSON.parse(t) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  lastActivity = Date.now();
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        app: APP_ID,
        pid: process.pid,
        doc,
        port: (server.address() as any)?.port,
        browsers: clients.size,
        listening: [...waiters.keys()],
        seq,
        cursors,
      });
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, "index.html")));
    }
    if (req.method === "GET" && url.pathname === "/doc") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(fs.readFileSync(doc));
    }

    // ---- agent side ----
    if (req.method === "GET" && url.pathname === "/api/wait") {
      const consumer = url.searchParams.get("consumer") || "agent";
      const timeoutS = Math.max(0, Number(url.searchParams.get("timeout") ?? 540));
      const settleMs = Math.max(0, Number(url.searchParams.get("settle") ?? 400));
      const takeover = url.searchParams.get("takeover") === "1";
      const existing = waiters.get(consumer);
      if (existing && !takeover) {
        return json(res, 409, { status: "listener_active", consumer, hint: "another wait is already listening; pass --takeover to replace it" });
      }
      if (existing) finishWaiter(existing, { status: "replaced" });
      const now = pending(consumer);
      if (now.length) return json(res, 200, { status: "events", events: now, ack: now.at(-1)!.seq });

      // Headers go out immediately + whitespace heartbeat (same trick as lavish) so no proxy/client
      // header timeout fires during a long wait. JSON.parse ignores leading whitespace.
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.write(" ");
      const w: Waiter = { consumer, res, settleMs, done: false };
      w.heartbeat = setInterval(() => !res.writableEnded && res.write(" "), HEARTBEAT_MS);
      w.timer = setTimeout(() => finishWaiter(w, { status: "timeout" }), timeoutS * 1000);
      waiters.set(consumer, w);
      // If the CLI is killed (Ctrl-C, TaskStop, harness timeout) the socket closes: drop the waiter.
      // Nothing was ack'd, so the events stay queued for the next wait.
      res.on("close", () => {
        if (!w.done) {
          log("waiter abandoned", consumer);
          finishWaiter(w, { status: "abandoned" });
        }
      });
      broadcastPresence();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/ack") {
      const { consumer = "agent", seq: ackSeq } = await readBody(req);
      cursors[consumer] = Math.max(cursors[consumer] ?? 0, Number(ackSeq) || 0);
      fs.writeFileSync(cursorsFile, JSON.stringify(cursors));
      return json(res, 200, { ok: true, cursor: cursors[consumer] });
    }
    if (req.method === "GET" && url.pathname === "/api/peek") {
      const consumer = url.searchParams.get("consumer") || "agent";
      const evs = pending(consumer);
      return json(res, 200, { status: evs.length ? "events" : "empty", events: evs, ack: evs.at(-1)?.seq });
    }
    if (req.method === "POST" && url.pathname === "/api/push") {
      const body = await readBody(req);
      const push = { id: pushes.length + 1, ts: new Date().toISOString(), kind: body.kind || "message", ...body };
      pushes.push(push);
      fs.appendFileSync(pushesFile, JSON.stringify(push) + "\n");
      const delivered = broadcast({ type: "agent-push", push });
      return json(res, 200, { ok: true, id: push.id, delivered_to_browsers: delivered });
    }
    // Lets tests / other tools inject an event without a browser (curl).
    if (req.method === "POST" && url.pathname === "/api/event") {
      const { type = "feedback", ...rest } = await readBody(req);
      const ev = addEvent(String(type), { ...rest, source: "http" });
      return json(res, 200, { ok: true, seq: ev.seq });
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      json(res, 200, { ok: true });
      shutdown("stop requested");
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    log("error", e);
    if (!res.headersSent) json(res, 500, { error: String(e) });
  }
});

// ---- browser side ----
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/agent-ws")) return agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit("connection", ws, req));
  if (!req.url?.startsWith("/ws")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// Agent event stream over WebSocket — lets Claude Code's Monitor tool subscribe with its native
// `ws` source (no CLI process at all). One text frame per event. Delivery = ack (at-most-once
// per frame, but the frame is only sent when the socket is OPEN).
const agentWss = new WebSocketServer({ noServer: true });
const agentSockets = new Map<WebSocket, string>();
agentWss.on("connection", (ws, req) => {
  const consumer = new URL(req.url || "/", "http://x").searchParams.get("consumer") || "monitor";
  agentSockets.set(ws, consumer);
  flushAgentSocket(ws);
  broadcastPresence();
  ws.on("close", () => {
    agentSockets.delete(ws);
    broadcastPresence();
  });
});
function flushAgentSocket(ws: WebSocket) {
  const consumer = agentSockets.get(ws);
  if (!consumer || ws.readyState !== WebSocket.OPEN) return;
  for (const ev of pending(consumer)) {
    ws.send(JSON.stringify(ev));
    cursors[consumer] = ev.seq;
  }
  fs.writeFileSync(cursorsFile, JSON.stringify(cursors));
}
onNewEvent = () => agentSockets.forEach((_c, ws) => flushAgentSocket(ws));
wss.on("connection", (ws) => {
  clients.add(ws);
  everHadBrowser = true;
  lastActivity = Date.now();
  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }
  log("browser connected", clients.size);
  ws.send(JSON.stringify({ type: "hello", pushes, agentListening: listeningConsumers(), seq }));
  ws.on("message", (raw) => {
    lastActivity = Date.now();
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!["feedback", "edit", "annotation"].includes(msg?.type)) return;
    const { type, ...rest } = msg;
    const ev = addEvent(type, rest);
    ws.send(JSON.stringify({ type: "queued", seq: ev.seq, eventType: type }));
  });
  ws.on("close", () => {
    clients.delete(ws);
    lastActivity = Date.now();
    log("browser disconnected", clients.size);
    if (clients.size === 0 && everHadBrowser && !disconnectTimer) {
      // A reload reconnects within the grace period and produces no event.
      disconnectTimer = setTimeout(() => {
        disconnectTimer = null;
        if (clients.size === 0) addEvent("browser_closed", { grace_ms: DISCONNECT_GRACE_MS });
      }, DISCONNECT_GRACE_MS);
    }
  });
});

// Agent (or the user's editor) changed the file on disk -> tell browsers to reload the doc view.
let docTimer: NodeJS.Timeout | null = null;
fs.watch(doc, () => {
  if (docTimer) clearTimeout(docTimer);
  docTimer = setTimeout(() => broadcast({ type: "doc-changed" }), 150);
});

// Idle self-shutdown: no browser and no waiting agent for IDLE_SHUTDOWN_MS.
setInterval(() => {
  if (clients.size === 0 && waiters.size === 0 && Date.now() - lastActivity > IDLE_SHUTDOWN_MS) shutdown("idle");
}, Math.min(30_000, IDLE_SHUTDOWN_MS)).unref();

let shuttingDown = false;
function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown:", reason);
  for (const w of waiters.values()) finishWaiter(w, { status: "server_stopped", reason });
  broadcast({ type: "server-stopped", reason });
  try {
    const info = JSON.parse(fs.readFileSync(serverInfoFile(stateDir), "utf8"));
    if (info.pid === process.pid) fs.unlinkSync(serverInfoFile(stateDir));
  } catch {
    /* already gone */
  }
  for (const c of clients) c.close();
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function listen(port: number) {
  server.once("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE" && port !== 0) {
      log(`port ${port} in use, falling back to an ephemeral port`);
      listen(0);
    } else {
      log("listen failed", e);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const actual = (server.address() as any).port as number;
    const info: ServerInfo = {
      app: APP_ID,
      pid: process.pid,
      port: actual,
      url: `http://127.0.0.1:${actual}`,
      doc,
      startedAt: new Date().toISOString(),
    };
    // Write atomically: the CLI polls for this file to know the server is up.
    const tmp = serverInfoFile(stateDir) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(info, null, 2));
    fs.renameSync(tmp, serverInfoFile(stateDir));
    fs.writeFileSync(path.join(stateDir, "last-port"), String(actual));
    log("listening", info.url, "doc", doc, "replayed events", events.length);
  });
}
listen(Number(portArg ?? 5101));
