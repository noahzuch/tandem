# Decision Journal — Offline sync for field notes

## Journal

<!-- F-N: [status] <fact> (Source: <how verified>)
     status = verified | assumed | REFUTED

     A refuted fact is NEVER deleted or silently edited. Set its status to REFUTED and
     append an Erratum, then add the correction as a new F-M.

     Cross-reference: "see D-3", "contradicts F-1", "resolves Q-2" -->

<!-- D-N: [status] **<decision summary>**
     status = accepted | superseded-by D-M
     - Evaluated: <options considered>
     - Rejected <option>: <why>
     - Chosen because: <rationale> -->

<!-- Q-N: [assumption] <unresolved question>
     - Current assumption: <what we're assuming>
     - Impact if wrong: <what breaks> -->

F-1: [verified] Field technicians are offline for long stretches: in the 2026-Q3 telemetry, 38 % of note saves happened without connectivity; the longest offline stretch was 9 h (a basement plant room). (Source: mobile telemetry export, 2026-10-10)

F-2: [verified] A technician produces 40–120 notes per day, median 2.1 KB each. Photos are uploaded separately by the media service and are not part of the notes payload. (Source: notes DB sample, 500 devices)

D-1: [accepted] **Every save goes into a durable on-device outbox; the network is never on the save path.**
     - Evaluated: (a) outbox queue replayed in order on reconnect; (b) save directly to the server with retries; (c) full-document sync on reconnect.
     - Rejected (b): a save would block or fail while offline, which F-1 says is the normal case.
     - Rejected (c): re-sends every note on each reconnect, see Rejected Approaches.
     - Chosen because: saves stay local and instant; the replay order is explicit and testable.

F-3: [verified] Replaying 120 queued ops in batches of 50 takes 2.8 s on a mid-range Android device over a throttled 3G link. (Source: spike `outbox-replay`, 2026-10-14)

D-2: [accepted] **Real-time collaboration between technicians is a non-goal for v1.**
     - Evaluated: live co-editing over WebSocket; offline-first only.
     - Rejected live co-editing: needs the connectivity that F-1 says technicians do not have.
     - Chosen because: technicians rarely edit the same note at the same time (F-4).

F-4: [assumed] Two technicians edit the same note while both are offline less than once per week per site. (Source: interview with the field ops lead, 2026-10-12; not measured)

D-3: [accepted] **Each operation carries a client-generated id; the server applies an id at most once.**
     - Evaluated: server-assigned sequence numbers; client-generated UUIDv7 ids.
     - Rejected server sequence numbers: they need a round-trip before an op can be queued, impossible offline.
     - Chosen because: a retry after a lost response becomes idempotent (resolves Q-2).

Q-1: [assumption] Last-writer-wins or CRDT merge for concurrent edits of the same note?
    - Current assumption: paragraph-level merge with visible conflict markers (see D-5).
    - Impact if wrong: if technicians routinely co-edit the same paragraph, the markers become noise and a CRDT per note is needed.

F-5: [REFUTED] SQLite on the device cannot hold more than 10,000 queued ops without slowing down saves. (Source: forum post)
     Erratum: wrong. The `outbox-sqlite` spike wrote 50,000 ops with a p99 save latency of 4 ms. Corrected in F-6.

F-6: [verified] SQLite in WAL mode holds 50,000 queued ops with a p99 save latency of 4 ms on the reference device. (Source: spike `outbox-sqlite`, 2026-10-16)

D-4: [superseded-by D-5] **Last-writer-wins per note; the losing version goes to a conflicts inbox.**
     - Evaluated: LWW per note; paragraph merge.
     - Chosen because: the simplest server, and nothing is lost; F-4 says conflicts are rare.

Q-2: [assumption] What happens when the server applied a batch but the response was lost?
    - Current assumption: the client retries the whole batch.
    - Impact if wrong: duplicated notes.
    - Resolved: by D-3 (ids make the retry idempotent).

D-5: [accepted] **Merge concurrent edits at paragraph granularity and mark overlapping edits; last-writer-wins only inside one paragraph.** Supersedes D-4.
     - Evaluated: LWW per note (D-4); paragraph merge; a full CRDT (Yjs) per note.
     - Rejected the full CRDT: doubles the payload per op and needs a migration of 2 M existing notes.
     - Chosen because: the ops lead's requirement "neither should lose their text" rules out note-level LWW; a paragraph merge keeps both texts in the common case.

F-7: [verified] The API returns 412 when the base version is stale; the client keeps the ops and shows the conflict banner (spec §3, error table). (Source: API draft review with the backend team, 2026-10-20)

Q-3: [assumption] Must sync finish within 10 s of reconnecting for a full day of notes?
    - Current assumption: yes, for up to 120 notes (F-3 measured 2.8 s).
    - Impact if wrong: the 10 s goal in §1 must be stated per number of notes.

## Rejected Approaches
- **Full-document sync on reconnect**: re-sends every note on each reconnect (F-2: up to 120 notes × 2.1 KB, every time). Reconsider only if the outbox proves unreliable.
- **Server-assigned operation sequence numbers**: need connectivity before an op can be queued (F-1).
- **Live co-editing between technicians over WebSocket**: needs connectivity we do not have (D-2).
