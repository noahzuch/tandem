// collab — the agent-facing CLI of the spike.
//
//   collab open   <doc> [--browser]                         start (or reuse) the detached server, print URL
//   collab wait   <doc> [--timeout s] [--consumer name] [--takeover] [--settle ms]
//                                                           block until browser events arrive, print one JSON line
//   collab watch  <doc> [--consumer name]                   stream events, one JSON line per event (for Monitor / terminals)
//   collab peek   <doc> [--consumer name] [--ack] [--hook]  non-blocking: print pending events (for hooks)
//   collab push   <doc> <text> | --json '<obj>'             agent -> browser
//   collab status <doc>
//   collab stop   <doc>
//
// Exit codes of `wait`: 0 = events, 2 = timeout (nothing happened), 3 = no server / server died,
//                       4 = another wait already listening for this consumer, 1 = usage/other error.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PORT,
  pidAlive,
  probe,
  readServerInfo,
  request,
  stateDirFor,
  type ServerInfo,
} from "../src/state.ts";

const SPIKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_TS = path.join(SPIKE_DIR, "src", "server.ts");

function out(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function fail(code: number, obj: Record<string, unknown>): never {
  out({ status: "error", ...obj });
  process.exit(code);
}

function parse(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (["browser", "takeover", "ack", "hook"].includes(name) || next === undefined) flags[name] = true;
      else flags[name] = argv[++i];
    } else pos.push(a);
  }
  return { flags, pos };
}

async function running(doc: string): Promise<ServerInfo | null> {
  const dir = stateDirFor(doc);
  const info = readServerInfo(dir);
  if (info && pidAlive(info.pid) && (await probe(info, doc))) return info;
  return null;
}

async function requireServer(doc: string): Promise<ServerInfo> {
  const info = await running(doc);
  if (!info) fail(3, { code: "NO_SERVER", hint: `run: collab open ${doc}` });
  return info;
}

async function open(doc: string, flags: Record<string, string | true>) {
  if (!fs.existsSync(doc)) fail(1, { code: "NO_DOC", doc });
  const dir = stateDirFor(doc);
  fs.mkdirSync(dir, { recursive: true });
  let info = await running(doc);
  let reused = true;
  if (!info) {
    reused = false;
    const stale = readServerInfo(dir);
    if (stale) fs.rmSync(path.join(dir, "server.json"), { force: true }); // crashed / killed earlier
    // Prefer the port this doc had last time, so already-open tabs reconnect after a crash/restart
    // even when the doc had fallen back to an ephemeral port.
    let preferred = DEFAULT_PORT;
    try {
      preferred = Number(fs.readFileSync(path.join(dir, "last-port"), "utf8")) || DEFAULT_PORT;
    } catch {
      /* first start */
    }
    const logFd = fs.openSync(path.join(dir, "server.log"), "a");
    // Detached + own process group + stdio to a log file + unref: survives the CLI (and the
    // Bash tool call) exiting. Same pattern lavish uses (startServer / createServerSpawnOptions).
    const child = spawn(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), SERVER_TS, path.resolve(doc), dir, String(preferred)],
      { detached: true, stdio: ["ignore", logFd, logFd], cwd: SPIKE_DIR, env: process.env },
    );
    child.unref();
    fs.closeSync(logFd);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const cand = readServerInfo(dir);
      if (cand && cand.pid === child.pid && (await probe(cand, doc))) {
        info = cand;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!info) fail(1, { code: "START_FAILED", log: path.join(dir, "server.log") });
  }
  process.stderr.write(`\n  collab: open ${info.url} in your browser (server pid ${info.pid}, ${reused ? "reused" : "started"})\n\n`);
  if (flags.browser) spawn(process.platform === "darwin" ? "open" : "xdg-open", [info.url], { stdio: "ignore", detached: true }).unref();
  out({
    status: "open",
    url: info.url,
    port: info.port,
    pid: info.pid,
    reused,
    state_dir: path.relative(process.cwd(), dir) || ".",
    next: `collab wait ${doc}`,
  });
}

/** One long-poll + ack. Returns the parsed server payload. */
async function waitOnce(info: ServerInfo, consumer: string, timeoutS: number, settle: number, takeover: boolean) {
  const q = new URLSearchParams({ consumer, timeout: String(timeoutS), settle: String(settle) });
  if (takeover) q.set("takeover", "1");
  let r;
  try {
    r = await request("GET", `${info.url}/api/wait?${q}`);
  } catch (e) {
    return { status: "server_gone", error: String((e as Error).message) };
  }
  const payload = r.json ?? { status: "bad_response", body: r.body };
  return payload;
}

async function ack(info: ServerInfo, consumer: string, seq: number) {
  await request("POST", `${info.url}/api/ack`, { consumer, seq });
}

async function wait(doc: string, flags: Record<string, string | true>) {
  const info = await requireServer(doc);
  const consumer = typeof flags.consumer === "string" ? flags.consumer : "agent";
  const timeoutS = Number(flags.timeout ?? 540); // < 600 s = Claude Code's max Bash timeout
  const settle = Number(flags.settle ?? 400);
  const p = await waitOnce(info, consumer, timeoutS, settle, !!flags.takeover);
  switch (p.status) {
    case "events":
      out({ status: "events", events: p.events });
      // ack only AFTER the events are written to stdout -> at-least-once delivery.
      await ack(info, consumer, p.ack);
      process.exit(0);
    case "timeout":
      out({ status: "timeout", hint: "nothing happened; run wait again to keep listening" });
      process.exit(2);
    case "listener_active":
      fail(4, { code: "LISTENER_ACTIVE", hint: p.hint });
    case "server_gone":
    case "server_stopped":
      fail(3, { code: "SERVER_GONE", detail: p, hint: `run: collab open ${doc} (queued events survive a restart)` });
    default:
      fail(1, { code: "UNEXPECTED", detail: p });
  }
}

async function watch(doc: string, flags: Record<string, string | true>) {
  const consumer = typeof flags.consumer === "string" ? flags.consumer : "agent";
  for (;;) {
    const info = await running(doc);
    if (!info) {
      out({ status: "server_gone" });
      process.exit(3);
    }
    const p = await waitOnce(info, consumer, 300, Number(flags.settle ?? 0), true);
    if (p.status === "events") {
      for (const ev of p.events) out(ev); // one line per event -> one notification per event
      await ack(info, consumer, p.ack);
    } else if (p.status === "replaced") {
      out({ status: "replaced", hint: "another listener took over this consumer" });
      process.exit(4);
    } else if (p.status !== "timeout") {
      out({ status: p.status });
      if (p.status === "server_gone" || p.status === "server_stopped") process.exit(3);
    }
  }
}

async function peek(doc: string, flags: Record<string, string | true>) {
  const info = await running(doc);
  const consumer = typeof flags.consumer === "string" ? flags.consumer : "agent";
  if (!info) {
    if (!flags.hook) out({ status: "no_server" });
    return;
  }
  const r = await request("GET", `${info.url}/api/peek?consumer=${encodeURIComponent(consumer)}`);
  const p = r.json;
  if (flags.hook) {
    // Shape for a UserPromptSubmit / Stop-style hook: inject pending events as additional context.
    if (p.events.length) {
      out({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `collab: ${p.events.length} pending browser event(s) on ${doc}: ${JSON.stringify(p.events)}`,
        },
      });
    }
  } else out(p);
  if (flags.ack && p.ack) await ack(info, consumer, p.ack);
}

async function push(doc: string, pos: string[], flags: Record<string, string | true>) {
  const info = await requireServer(doc);
  let body: Record<string, unknown>;
  if (typeof flags.json === "string") body = JSON.parse(flags.json);
  else if (pos.length) body = { kind: "message", text: pos.join(" ") };
  else fail(1, { code: "USAGE", hint: "collab push <doc> <text> | --json '<obj>'" });
  const r = await request("POST", `${info.url}/api/push`, body);
  out({ status: "pushed", ...r.json });
}

async function status(doc: string) {
  const dir = stateDirFor(doc);
  const info = readServerInfo(dir);
  const health = await probe(info, doc);
  if (!health) {
    out({ status: "stopped", stale_state: !!info });
    process.exit(3);
  }
  out({ status: "running", url: info!.url, ...health });
}

async function stop(doc: string) {
  const dir = stateDirFor(doc);
  const info = readServerInfo(dir);
  if (!info) return out({ status: "not_running" });
  try {
    await request("POST", `${info.url}/api/stop`, {}, { timeoutMs: 2000 });
  } catch {
    /* fall through to kill */
  }
  const deadline = Date.now() + 3000;
  while (pidAlive(info.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (pidAlive(info.pid)) process.kill(info.pid, "SIGKILL");
  fs.rmSync(path.join(dir, "server.json"), { force: true });
  out({ status: "stopped", pid: info.pid });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parse(rest);
  const doc = pos.shift();
  if (!cmd || !doc) fail(1, { code: "USAGE", hint: "collab <open|wait|watch|peek|push|status|stop> <doc> ..." });
  switch (cmd) {
    case "open":
      return open(doc, flags);
    case "wait":
      return wait(doc, flags);
    case "watch":
      return watch(doc, flags);
    case "peek":
      return peek(doc, flags);
    case "push":
      return push(doc, pos, flags);
    case "status":
      return status(doc);
    case "stop":
      return stop(doc);
    default:
      fail(1, { code: "USAGE", hint: `unknown command ${cmd}` });
  }
}
main().catch((e) => fail(1, { code: "CRASH", error: String(e?.stack || e) }));
