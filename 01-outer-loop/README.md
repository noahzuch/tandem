# Spike 01: Outer loop (skill ↔ local server ↔ browser ↔ Claude session)

## Question

How does a Claude Code skill start a local web server for a document, and how do events travel
**both ways**?

- **browser → server → running Claude session:** the agent must notice "user sent feedback",
  "user edited the doc" and "user annotated a passage".
- **agent → server → browser:** the agent pushes a reply or an update that appears live.

Which wake-up mechanism on the Claude Code side gives the best user experience?

## What I built

| file | what it does |
|---|---|
| `bin/collab.ts` | Agent-facing CLI: `open`, `wait`, `watch`, `peek`, `push`, `status`, `stop` (all take `<doc>`) |
| `src/server.ts` | Detached per-doc server: HTTP + WebSocket (`/ws` browser, `/agent-ws` agent stream), long-poll `/api/wait`, durable event queue |
| `src/state.ts` | State-dir layout, `node:http` client with no timeout (avoids undici's 300 s limits), health probe |
| `public/index.html` | Plain HTML/JS page: doc in an iframe; feedback box; "I edited the doc"; "Annotate selection"; live agent pushes; "agent: listening" badge |
| `SKILL.md` | **Draft skill**: the loop protocol the agent would follow |
| `verify/verify.ts` | Playwright end-to-end proof (25 checks) |
| `verify/click-feedback.ts` | Helper: headless browser sends one feedback message (used for manual tests) |

**Mechanics**

- **Start.** `collab open doc.html` spawns `node --import tsx src/server.ts …` with
  `detached: true`, stdio redirected to `.collab/<doc>/server.log`, and `unref()`. It then polls
  until `server.json` appears and `/health` answers for this doc. The server outlives the CLI and
  the Bash tool call.
- **Find again.** `.collab/<doc>/server.json` `{pid, port, url, doc}` plus a liveness check (pid
  alive, and `/health` returns `app` + same `doc`). Stale state (after `kill -9`) is detected
  and replaced.
- **Port.** The server tries 5101, falls back to an ephemeral port on `EADDRINUSE`, and
  remembers `last-port` so a restarted server returns to the same port. Open tabs then reconnect
  by themselves.
- **Queue.** Every browser event gets a monotonic `seq` and is appended to `events.jsonl`. Each
  consumer (`agent`, `terminal`, `monitor`, …) has a cursor in `cursors.json`. `wait` prints
  first and **acks afterwards** (`POST /api/ack`), which gives **at-least-once** delivery.
  Events that arrive while nobody waits stay queued. A 400 ms settle window batches bursts.
- **One listener per consumer.** A second `wait` gets exit 4 `LISTENER_ACTIVE`, and `--takeover`
  replaces the first (the same idea as lavish).
- **Long-poll robustness.** Headers are sent at once, plus a whitespace heartbeat every 15 s
  (copied from lavish), so neither side hits a header or idle timeout.
- **Presence.** The browser badge shows whether an agent is listening right now. When the last
  tab has been closed for longer than a grace period (8 s; a reload does not trigger it), the
  agent gets a `browser_closed` event.
- **Agent → browser.** `collab push` sends a WebSocket broadcast and appends to `pushes.jsonl`, so
  pushes are replayed on reconnect. When the doc changes on disk, `fs.watch` broadcasts
  `doc-changed` and the iframe reloads.
- **Exit codes of `wait`.** 0 = events, 2 = timeout, 3 = no server or server died, 4 = listener
  active.
- **Idle shutdown.** The server stops itself after 30 min with no browser and no listener.

## How to try it

```bash
cd spikes/project-collab/01-outer-loop
npm install
npx playwright install chromium   # once, for verify
npm start                          # starts the detached server on :5101, prints the URL, then
                                   # streams every browser event in this terminal (consumer "terminal")
```

1. Open http://127.0.0.1:5101. The badge says **connected** and **agent: not listening**.
2. In a second terminal, act as the agent:
   ```bash
   npm run collab -- wait samples/spec.html --timeout 120   # blocks; the badge flips to "agent: listening"
   ```
3. In the page, type feedback and click **Send feedback**. `wait` prints
   `{"status":"events","events":[{"seq":…,"type":"feedback","text":"…"}]}` and exits 0. Also try
   **I edited the doc**, or select text in the doc and click **Annotate selection**.
4. Reply as the agent: `npm run collab -- push samples/spec.html "Thanks, on it"`. The message
   appears in the page right away.
5. Edit `samples/spec.html` on disk. The doc view reloads.
6. `npm run stop` stops the server. `npm start` then exits, because its watch sees `server_stopped`.

`npm run verify` runs the whole thing headless on temporary copies of the doc and exits 0 or 1.

## How lavish does it

I read `lavish-axi@0.1.92` (`npm pack lavish-axi`). It ships as one bundle, `dist/cli.mjs`
(about 650 KB), with source-module markers. Line numbers below refer to that file.

- **Daemon start.** `startServer()` (around line 14420) spawns `process.execPath dist/server.mjs server --port 4387`
  using `createServerSpawnOptions()`: `detached: true`, stdio to `~/.lavish-axi/server.log`,
  `child.unref()`, and env `LAVISH_AXI_NO_OPEN=1`. `ensureServer()` (line 14178) is called by
  **every** command (`open`, `poll`, `reply`). It probes `/health` on the port, adopts a
  matching server, replaces a server from an older version, refuses a foreign process on the
  port (it identifies the owner via `lsof` + `ps` in `lavishListenerPids`), and retries for up to 5 s.
- **Find again.** There is **one global server**, not one per doc: fixed port 4387
  (`LAVISH_AXI_PORT`), state dir `~/.lavish-axi/` (`LAVISH_AXI_STATE_DIR`), and `state.json`
  holding all sessions. A session is keyed by `sha256(absolute file path)[:16]` (`sessionKey`). It
  has no pid file. Discovery is just port + `/health`.
- **Agent waits.** `lavish-axi poll <file>` makes a `GET /api/poll?file=…` long-poll with **no
  timeout** by default (`--timeout-ms` is "for tests only"). The server sends headers at once
  (`Lavish-Poll-State: listening`) plus a `" "` heartbeat every 15 s (`pollHeartbeatMs`, see
  `handlePoll` around line 10690). Only one poll per file is allowed: `LISTENER_ACTIVE`, or
  `--takeover` → `LISTENER_REPLACED`. "Poll delivery consumes the response": feedback stays
  queued until a poll delivers it. The poll also returns on `browser_disconnected`, after a
  10 s reconnect grace (`DEFAULT_BROWSER_DISCONNECT_GRACE_MS`), and when the user clicks Send & End.
- **Agent replies.** `lavish-axi reply <file> --agent-reply "…"` posts to
  `/api/:key/agent-reply` and waits up to 10 s for a receipt. Alternatively,
  `poll --agent-reply "…"` replies and then waits again in a single call. The server emits
  `agent-reply` on an internal event bus, which forwards it to the browser over a per-session
  **WebSocket** (`eventWebSocketServer`, around line 11598, with a 30 s heartbeat). A reply also marks
  delivered notes as Done.
- **Idle.** The server stops itself after 30 min with no connections (`DEFAULT_IDLE_TIMEOUT_MS`).
- **Claude Code integration.** The text in `POLL_WAKE_PATH_RULES` (line 12765) explicitly
  allows a background poll *only* through "a harness-native tracked background-job facility
  whose completion result is guaranteed to resume or notify the same agent". It says to keep it
  in the foreground by default and never use `nohup`/`&`. For Codex it says to stay in the
  foreground. `lavish-axi setup hooks` installs **SessionStart** hooks via `axi-sdk-js`
  (`installSessionStartHooks`) for Claude Code, Codex, OpenCode and Copilot CLI. As far as I can
  tell, these hooks only inject the CLI guidance and do not deliver events. The shipped
  `skills/lavish/SKILL.md` is 34 lines and points to `--help` as the source of truth.
- **Plannotator.** Not investigated (optional). From memory, and not verified here: it hooks the
  `ExitPlanMode` permission request and blocks the hook until the user approves or denies in
  the browser. That is a one-shot blocking hook, not a loop.

My prototype keeps lavish's good ideas: detach + unref, `/health` adoption, header +
whitespace heartbeat, a single listener with takeover, queue until delivered, and a
browser-disconnect event. It differs in four ways: **one server per doc** (state next to the
doc), **explicit ack after printing**, a **bounded `wait` timeout** with exit code 2, and
**presence shown in the browser**.

## Findings

### Claude Code side: what I observed in my own session

| mechanism | result | latency | limits observed |
|---|---|---|---|
| **a) foreground `wait`** | ✅ Works. Event sent 4 s into a 30 s wait: `wait` returned at once (≈0.4 s settle). A wait on an empty queue → exit 2 after `--timeout`. | <0.5 s | The agent is **blocked** and cannot talk to the user in the terminal. The Bash tool caps at 10 min, so the agent must loop (`--timeout 540`, exit 2 → re-run). |
| **b) background `wait` (`run_in_background: true`)** | ✅ Works. I started the wait, kept working (status calls, a duplicate wait → exit 4), then sent feedback via headless Chromium. I got a `task-notification` (`completed (exit code 0)`) right after, and the output file contained the event JSON. A server crash (`kill -9`) during a background wait → notification `failed with exit code 3` + `SERVER_GONE`. | <0.5 s + notification | **Untested here:** I am a subagent that is never idle, so I could not test whether an *idle* main session is woken without a user prompt. Each event wakes the agent **once**, and the agent must re-arm the wait itself (see the SKILL loop). |
| **c1) Monitor + `collab watch` (command)** | ✅ Works. One notification per stdout line. A new consumer first receives the whole backlog (4 old events in one batched notification), then live events. | <0.5 s | Monitor expires after at most **30 min** (`timeout_ms` cap), so it needs re-arming. Too many events → Monitor auto-stops. Output is interleaved with the conversation. |
| **c2) Monitor `ws` source → `/agent-ws`** | ✅ Works with no CLI process at all. Each event is one text frame, which becomes one notification. After a server `kill -9` the Monitor reported `[WebSocket closed: 1006 Connection ended]`. | instant | Same 30 min cap. Delivery is ack-on-send (at-most-once if the frame is lost). It is tied to the URL/port, so after a restart onto another port the agent must re-arm with the new URL. |
| **d) hooks** | Feasible as a **safety net**, not as the main loop. `collab peek <doc> --consumer hook --hook` already prints the `UserPromptSubmit` `additionalContext` JSON (tested). | only at the next user prompt / agent stop | See "Hooks" below. |

**Hooks (d) in detail.** A `UserPromptSubmit` hook running `collab peek --hook --ack` injects any
events the agent missed whenever the user types in the terminal. It costs one HTTP call and
never blocks. A `Stop` hook could return `decision: "block"` while events are pending, or while
no wait is armed ("you forgot to re-arm the listener"), which would enforce the loop. It cannot
wake an idle agent, because hooks only run when Claude Code is already doing something.
Building a long-poll *inside* a Stop hook would turn the session into a dedicated listener that
the user cannot interrupt nicely, so I would not do it.

**From the Claude Code docs** (asked via claude-code-guide; I did not test these myself):

- **Default timeouts.** Command hooks default to 600 s and `UserPromptSubmit` to 30 s.
- **Stop-hook loop limit.** `Stop` input includes `stop_hook_active` and `background_tasks`. A
  `Stop` hook can block at most 8 consecutive times (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). That
  is enough for an "is a listener armed?" check, but not for an endless loop.
- **`async: true` hooks** deliver their output only on the next turn. They do not wake the agent.
- **`asyncRewake` hooks** reportedly run in the background and "wake Claude on exit code 2". The
  claude-code-guide summary marked this as unverified. If it is real, a hook that runs
  `collab wait` and exits 2 on events is another wake path. Test this.
- **Plugin monitors.** A plugin can declare `monitors/monitors.json` (`name`, `command`,
  `description`, and optionally `when` = start on the first run of a named skill). These are
  auto-started in interactive sessions, and their output reaches Claude as notifications (the
  manifest key is `experimental.monitors`). That would let the product auto-arm
  `collab watch-all` without relying on the agent to re-arm. They are not started under `-p`.
- **Background tasks and idle sessions.** Background Bash commands have **no time limit** in a
  local interactive session (30 min by default in `-p`/SDK/CI). Monitors cap at 30 min. Whether
  either one wakes an **idle** session is **not documented**.

### Robustness (all covered by `npm run verify`, 25 checks, green)

- **Queue while nobody waits.** `edit` + `annotation` sent with no listener are returned together
  by the next `wait` (one batch). After the ack, the next wait times out (exit 2).
- **Killed `wait`** (TaskStop or Ctrl-C) loses nothing: the server sees the socket close and drops
  the waiter, and since nothing was acked the next `wait` gets the event.
- **Server crash** (`kill -9`): the page shows "disconnected – retrying". `wait` → exit 3.
  `open` detects the stale `server.json`, restarts on the **same port** (`last-port`), the open
  tab reconnects on its own, the event queued before the crash is still delivered, and the
  earlier pushes are replayed.
- **User closes the browser:** a blocked `wait` wakes with `{"type":"browser_closed"}` after the
  grace period. A reload within the grace period produces no event.
- **Port collision / several docs:** while `npm start` held 5101, `verify` ran fully green. Its
  docs fell back to ephemeral ports (49358, 49412). Each doc has its own server and state dir.
- **Multiple sessions:** two Claude sessions on the same doc using the default consumer `agent`
  → the second gets `LISTENER_ACTIVE` (exit 4). With different `--consumer` names, **both** get
  every event, each with its own cursor (I tried `terminal` + `agent` + `monitor`). Two agents
  then both react, and with real edits they would race on the file. That is a product decision
  for later; spike 03/Yjs may solve the race.
- **Long waits:** the CLI uses `node:http` with no client timeout and the server sends headers +
  heartbeat immediately. `fetch` (undici) would kill a body-less response after 300 s.
- **Push with no browser open** → `delivered_to_browsers: 0`, and the push is stored and shown on
  the next connect.

### Other findings

- `npx tsx` startup is about 0.2–0.3 s per CLI call, which is fine. In the product, ship the CLI
  pre-compiled.
- **Security gap (not fixed):** any local process can `POST /api/event`, which is effectively
  prompt injection into the agent. The browser WebSocket has no auth either. The real product
  needs a per-session token in the URL and an `Origin`/`Host` check. Lavish checks the Host
  allow-list and same-origin on poll takeover.
- Watch out when testing: a `grep` for `"agent"` in `/health` also matched the `cursors` object.
  Status checks in a skill need structured fields, not grep.

## Verdict / recommendation for the real product

1. **Primary loop: background `collab wait` (`run_in_background: true`) + re-arm after every
   notification.** The agent stays free to chat in the terminal, and it gets woken with the full
   event batch and an exit code that says what happened. It has at-least-once semantics, no
   30-min expiry like Monitor, and no process left over if it is killed. The draft
   `SKILL.md` encodes the loop: wait in the background → handle the batch → edit the file +
   `push` → wait again.
2. **Keep the foreground loop as the fallback** (`--timeout 540`, re-run on exit 2) for harnesses
   without completion-aware background tasks. This is the same stance as lavish.
3. **Add a `UserPromptSubmit` hook (`collab peek --hook --ack`)** as a safety net for events that
   arrive while no wait is armed. Consider a `Stop` hook that reminds the agent to re-arm when a
   session is open and no listener is registered.
4. **Next experiment: a plugin-declared monitor** (`monitors/monitors.json` with
   `when: <collab skill>`). It is auto-armed by the harness, so the agent cannot forget to
   re-arm, which is the main weakness of (1). It would have to watch all open docs and, by the
   docs, it would also have the 30-min Monitor cap. Spike it in a real plugin install.
5. **Monitor (`ws` source or `watch`) is a good second choice** for chatty streams such as typing
   or presence, because it gives one notification per event. Its 30-min cap and at-most-once
   delivery make it worse for the core feedback loop.
6. **Server design to keep:** one detached server per doc; state next to the doc
   (`.collab/<doc>/`); `/health` identity check; preferred port + fallback + `last-port`; a
   durable jsonl queue with per-consumer cursors and ack-after-print; a single listener with
   takeover; header + heartbeat long-poll; WebSocket to the browser with replay; and the
   **"agent: listening" badge**. The badge is cheap and tells the user whether typing in the
   page is currently noticed.

## Open questions

- Does a background-task completion wake an **idle** main session with no user prompt? I could
  not test this from inside a subagent. If it does not, the UX degrades to "noticed at the next
  user prompt", and the `UserPromptSubmit` hook then becomes essential. → Test in a real
  interactive session: start a background `wait`, end the turn, click in the browser.
- How are `edit` events modelled once Tiptap/Yjs is in place? Options are per-keystroke (needs
  debouncing, plus a "user is typing" presence state) or "user paused editing for N s" with a
  diff summary.
- Is one server per doc acceptable, or should it be one per project (like lavish's single
  global server with sessions keyed by path)? One per project would make port handling simpler.
- How should the server and CLI authenticate (token in `server.json` + URL) without making the
  "open this URL" step clumsy?
- Should the agent's own edits be suppressed from the `doc-changed` → reload path once the
  editor is live (Yjs), to avoid reload flicker?

## Orchestrator note (main session)

The open question "does a background task wake an *idle* main session?" is answered by the harness itself:
a Bash command started with `run_in_background` "keeps running across turns and re-invokes you when it exits",
and the orchestrating session was in fact woken from idle by background-task notifications during this spike run.
So the recommended loop (background `collab wait`, re-armed after each notification) also works when the user's
session is idle — the remaining risk is only that the agent forgets to re-arm, which plugin-declared monitors or a
hook safety net could cover.
