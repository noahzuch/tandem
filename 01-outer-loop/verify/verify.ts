// npm run verify — proves the outer loop headlessly, end to end, through the real CLI:
//   open (detached server) -> browser connects -> wait receives feedback -> queue holds events while
//   nobody waits -> push appears live -> agent edit on disk reloads the doc view -> kill -9 + reopen
//   keeps queued events and the page reconnects -> second doc on a busy port falls back ->
//   killed wait loses nothing -> browser_closed event -> stop.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";

const SPIKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = import.meta.resolve("tsx");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "collab-verify-"));
const doc = path.join(tmp, "spec.html");
const doc2 = path.join(tmp, "other.html");
fs.copyFileSync(path.join(SPIKE, "samples", "spec.html"), doc);
fs.copyFileSync(path.join(SPIKE, "samples", "spec.html"), doc2);
const env = { ...process.env, COLLAB_DISCONNECT_GRACE_MS: "1500" };

interface CliResult { code: number; json: any; stdout: string; ms: number }
function cli(...args: string[]): { done: Promise<CliResult>; kill: () => void } {
  const t0 = Date.now();
  const child = spawn(process.execPath, ["--import", TSX, path.join(SPIKE, "bin", "collab.ts"), ...args], { cwd: SPIKE, env });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => process.stderr.write(d));
  const done = new Promise<CliResult>((resolve) =>
    child.on("close", (code) => {
      let json: any = null;
      try { json = JSON.parse(stdout.trim().split("\n").at(-1) || "null"); } catch { /* raw */ }
      resolve({ code: code ?? -1, json, stdout, ms: Date.now() - t0 });
    }),
  );
  return { done, kill: () => child.kill("SIGTERM") };
}
const run = (...a: string[]) => cli(...a).done;

let passed = 0;
function check(cond: unknown, msg: string, extra?: unknown): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}${extra === undefined ? "" : " -> " + JSON.stringify(extra)}`);
  passed++;
  console.log(`  ok  ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForListening(url: string, consumer = "agent") {
  for (let i = 0; i < 100; i++) {
    const h = await fetch(`${url}/health`).then((r) => r.json());
    if (h.listening.includes(consumer)) return;
    await sleep(50);
  }
  throw new Error("wait never registered");
}

let browser: Browser | undefined;
let pids: number[] = [];
try {
  console.log("1. open starts a detached server");
  const o = await run("open", doc);
  check(o.code === 0 && o.json.status === "open" && o.json.reused === false, "open started a new server", o.json);
  const url: string = o.json.url;
  pids.push(o.json.pid);
  const o2 = await run("open", doc);
  check(o2.json.reused === true && o2.json.pid === o.json.pid, "second open reuses the running server (found via .collab/<doc>/server.json + /health)");

  console.log("2. browser connects");
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url);
  await page.locator("#status", { hasText: "connected" }).waitFor({ timeout: 5000 });
  check(true, "page connected over WebSocket");

  console.log("3. browser -> agent: blocking wait returns feedback");
  const w1 = cli("wait", doc, "--timeout", "30");
  await waitForListening(url);
  await page.locator("#agent", { hasText: "agent: listening" }).waitFor({ timeout: 3000 });
  check(true, "page shows 'agent: listening' while wait is blocked");
  await page.fill("#feedback", "Please add a risks section");
  await page.click("#send");
  const r1 = await w1.done;
  check(r1.code === 0, "wait exited 0 (events)", r1);
  check(r1.json.events.length === 1 && r1.json.events[0].type === "feedback" && r1.json.events[0].text === "Please add a risks section", "wait printed the feedback event", r1.json);
  await page.locator("#agent", { hasText: "not listening" }).waitFor({ timeout: 3000 });
  check(true, "page shows 'not listening' after wait returned");

  console.log("4. events are queued while no wait is running (and batched)");
  await page.click("#edited");
  await page.fill("#feedback", "this paragraph is vague");
  await page.click("#annotate");
  await page.locator("#log", { hasText: "queued annotation" }).waitFor();
  const r2 = await run("wait", doc, "--timeout", "5");
  check(r2.code === 0 && r2.json.events.map((e: any) => e.type).join(",") === "edit,annotation", "next wait returns both queued events at once", r2.json);
  check(r2.ms < 3000, `queued events returned immediately (${r2.ms} ms incl. tsx startup)`);
  const r3 = await run("wait", doc, "--timeout", "1");
  check(r3.code === 2 && r3.json.status === "timeout", "events were acked: next wait times out with exit 2", r3.json);

  console.log("5. agent -> browser: push appears live");
  const p = await run("push", doc, "Added a risks section — have a look.");
  check(p.code === 0 && p.json.delivered_to_browsers === 1, "push delivered to 1 browser", p.json);
  await page.locator("#pushes li", { hasText: "Added a risks section" }).waitFor({ timeout: 3000 });
  check(true, "push text rendered in the page");

  console.log("6. agent edits the file on disk -> doc view reloads");
  fs.writeFileSync(doc, fs.readFileSync(doc, "utf8").replace("<h2>Goals</h2>", "<h2>Goals</h2><p id='agent-marker'>Edited by agent</p>"));
  await page.frameLocator("#doc").locator("#agent-marker").waitFor({ timeout: 5000 });
  check(true, "iframe shows the agent's on-disk edit");

  console.log("7. killed wait loses nothing (at-least-once)");
  const w2 = cli("wait", doc, "--timeout", "30");
  await waitForListening(url);
  w2.kill(); // like TaskStop / Ctrl-C on a background wait
  await w2.done;
  await sleep(200);
  await page.fill("#feedback", "sent after the wait was killed");
  await page.click("#send");
  await page.locator("#log", { hasText: "queued feedback" }).first().waitFor();
  const r4 = await run("wait", doc, "--timeout", "5");
  check(r4.code === 0 && r4.json.events[0].text === "sent after the wait was killed", "event delivered to the next wait", r4.json);

  console.log("8. only one listener per consumer");
  const w3 = cli("wait", doc, "--timeout", "10");
  await waitForListening(url);
  const dup = await run("wait", doc, "--timeout", "1");
  check(dup.code === 4 && dup.json.code === "LISTENER_ACTIVE", "second concurrent wait is rejected (exit 4)", dup.json);
  const take = cli("wait", doc, "--timeout", "1", "--takeover");
  const r5 = await w3.done;
  check(r5.code === 1 && r5.json.detail?.status === "replaced", "--takeover replaces the old listener", r5.json);
  await take.done;

  console.log("9. server crash (kill -9) + reopen keeps the queue, page reconnects by itself");
  await page.click("#edited");
  await page.locator("#log", { hasText: "queued edit" }).first().waitFor();
  process.kill(o.json.pid, "SIGKILL");
  await page.locator("#status", { hasText: "disconnected" }).waitFor({ timeout: 3000 });
  const dead = await run("wait", doc, "--timeout", "1");
  check(dead.code === 3, "wait against a dead server exits 3", dead.json);
  const o3 = await run("open", doc);
  pids.push(o3.json.pid);
  check(o3.json.reused === false && o3.json.pid !== o.json.pid, "open detects the stale state file and starts a fresh server");
  await page.locator("#status", { hasText: "connected" }).first().waitFor({ timeout: 8000 });
  check(o3.json.url === url, "same port again, so the open tab reconnected on its own");
  const r6 = await run("wait", doc, "--timeout", "5");
  check(r6.code === 0 && r6.json.events.some((e: any) => e.type === "edit"), "edit queued before the crash survives (events.jsonl)", r6.json);
  check(await page.locator("#pushes li", { hasText: "Added a risks section" }).count() === 1, "earlier agent pushes are replayed after reconnect");

  console.log("10. a second doc while 5101 is busy -> ephemeral port fallback");
  const od = await run("open", doc2);
  pids.push(od.json.pid);
  check(od.code === 0 && od.json.port !== o3.json.port, `second doc got its own server on port ${od.json.port}`, od.json);
  await run("stop", doc2);

  console.log("11. user closes the browser -> agent gets browser_closed after the grace period");
  const w4 = cli("wait", doc, "--timeout", "15");
  await waitForListening(url);
  await page.close();
  const r7 = await w4.done;
  check(r7.code === 0 && r7.json.events[0].type === "browser_closed", "wait woke up with browser_closed", r7.json);

  console.log("12. stop");
  const s = await run("stop", doc);
  check(s.json.status === "stopped", "stop reported stopped");
  const st = await run("status", doc);
  check(st.code === 3, "status says stopped afterwards");
  console.log(`\nPASS — ${passed} checks`);
} catch (e) {
  console.error(String((e as Error).message || e));
  console.error("\nFAILED");
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await run("stop", doc).catch(() => {});
  await run("stop", doc2).catch(() => {});
  for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  fs.rmSync(tmp, { recursive: true, force: true });
}
