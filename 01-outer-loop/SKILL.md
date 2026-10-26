---
name: collab
description: Open a document (usually a spec from a brainstorming session) in a shared browser editor and keep working on it together with the user. Use when the user wants to review, annotate or co-edit a document visually, or says "let's work on the spec together".
argument-hint: <path to the HTML document>
---

<!-- DRAFT from spike 01 (outer loop). The CLI is `collab` = `npx tsx bin/collab.ts` in the spike;
     in the product it would ship in the plugin's bin/ (on PATH while the plugin is active). -->

# Collab: work on a document together in the browser

The user sees the document in the browser and can send feedback, annotate passages and edit it.
You receive their actions as **events** and answer by editing the file and/or **pushing** a
message that appears live in their browser.

## 1. Open

```bash
collab open <doc.html>
```

This prints one JSON line containing `url`. Give the user the URL in one short sentence. The
server runs in the background, survives your commands and remembers the session in
`.collab/<doc>/` next to the doc. Running `open` again reuses the running server or restarts a
dead one, and queued events are never lost.

## 2. Listen: always keep exactly one background `wait` running

Start the listener with the Bash tool and `run_in_background: true`:

```bash
collab wait <doc.html>
```

- While it runs, the browser shows **"agent: listening"**. Without a listener the badge says
  "not listening" and events queue up, so the user knows whether you will notice.
- You are **not blocked**. Keep chatting with the user or doing other work. When the user acts in
  the browser, the command exits and you get a task notification. Read its output file.
- Never start a second `wait` for the same doc. It fails with exit 4 `LISTENER_ACTIVE`. Use
  `--takeover` only if you lost track of the old one.
- Do not use `nohup`, `&` or `disown`. Only the harness's background facility wakes you up.

## 3. React to the notification

The output is one JSON line. Handle it by exit code:

| exit | output | what to do |
|---|---|---|
| 0 | `{"status":"events","events":[…]}` | handle **all** events in the batch (see below), then go to step 4 |
| 2 | `{"status":"timeout"}` | nothing happened (about 9 min). Just restart the background wait. Do not tell the user. |
| 3 | `SERVER_GONE` / `NO_SERVER` | run `collab open <doc>` (queued events survive), then restart the wait |
| 4 | `LISTENER_ACTIVE` | another wait is already running. Do nothing. |

How to handle each event `type`:

- `feedback` `{text}`: the user is talking to you about the doc. Do what they ask.
- `annotation` `{quote, comment}`: a comment on a passage. Address it in the doc.
- `edit` `{…}`: the user changed the doc. **Re-read the file before your next edit.** Never
  overwrite their change.
- `browser_closed`: every tab has been closed for a few seconds. Ask in the chat whether to
  continue. Do not reopen the browser yourself.

Events are delivered at least once. The CLI acks them only after printing, so a killed `wait`
loses nothing. Rarely, the same event can be delivered twice. Deduplicate by `seq`.

## 4. Answer, then listen again

1. Edit the document file. The browser reloads the doc view automatically when the file changes.
2. Reply in the browser, briefly. The user is looking there, not at the terminal:
   ```bash
   collab push <doc.html> "Added a Risks section and tightened the goals."
   ```
3. **Immediately start the next background `wait`.** Forgetting this is the main failure mode:
   the user keeps typing into a page whose badge says "not listening".

You can also push without being asked, for example "I'm restructuring section 3, give me a minute".

## 5. Finish

When the user says they are done, or the brainstorming moves on, run `collab push <doc> "…wrap-up…"`
then `collab stop <doc>`. If you forget, the server stops on its own after 30 minutes with no
browser and no listener.

## Fallback when background tasks are not available

Run `collab wait <doc> --timeout 540` in the foreground (the Bash tool caps at 10 minutes). On
exit 2, run it again. You are blocked while waiting, so tell the user to talk to you in the
browser and not in the terminal.
