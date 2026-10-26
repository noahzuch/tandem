// Durable agent event queue — the minimal part of spike 01's server, ported into the per-document server.
//
//   .collab/<doc>.events.jsonl   append-only, one event per line, monotonic `seq` (survives restarts)
//   .collab/<doc>.cursors.json   per-consumer cursor; `collab wait` prints first and ACKs afterwards → at-least-once
//
//   GET  /api/wait?consumer=agent&timeout=540&settle=400[&takeover=1]   long-poll; headers + whitespace heartbeat at once
//   POST /api/ack   {consumer, seq}
//   GET  /api/peek?consumer=agent                                       non-blocking (hooks)
//   POST /api/event {type, …}                                           inject an event (tests / curl)
//
// One listener per consumer (409 listener_active, takeover replaces); a killed `wait` drops its waiter (nothing acked).
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'

export type Ev = { seq: number; ts: string; type: string; [k: string]: unknown }

interface Waiter {
  consumer: string
  res: http.ServerResponse
  settleMs: number
  timer?: NodeJS.Timeout
  settleTimer?: NodeJS.Timeout
  heartbeat?: NodeJS.Timeout
  done: boolean
}

const HEARTBEAT_MS = 15_000

function readJsonl<T>(file: string): T[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T)
  } catch {
    return []
  }
}

export class EventQueue {
  readonly eventsFile: string
  readonly cursorsFile: string
  private events: Ev[]
  private seq: number
  private cursors: Record<string, number> = {}
  private waiters = new Map<string, Waiter>()
  /** called whenever the set of listening consumers changes (→ "agent: listening" badge) */
  onPresence: (listening: string[]) => void = () => {}

  constructor(dir: string, name: string, private log: (m: string) => void = () => {}) {
    fs.mkdirSync(dir, { recursive: true })
    this.eventsFile = path.join(dir, `${name}.events.jsonl`)
    this.cursorsFile = path.join(dir, `${name}.cursors.json`)
    this.events = readJsonl<Ev>(this.eventsFile)
    this.seq = this.events.at(-1)?.seq ?? 0
    try {
      this.cursors = JSON.parse(fs.readFileSync(this.cursorsFile, 'utf8'))
    } catch {
      /* fresh */
    }
  }

  get lastSeq() {
    return this.seq
  }

  /** the seq the NEXT event will get (callers store it on the thread in the same breath) */
  add(type: string, data: Record<string, unknown>): Ev {
    const ev: Ev = { seq: ++this.seq, ts: new Date().toISOString(), type, ...data }
    this.events.push(ev)
    fs.appendFileSync(this.eventsFile, JSON.stringify(ev) + '\n')
    this.log(`event #${ev.seq} ${type}`)
    for (const w of this.waiters.values()) this.scheduleDelivery(w)
    return ev
  }

  pending(consumer: string): Ev[] {
    const after = this.cursors[consumer] ?? 0
    return this.events.filter((e) => e.seq > after)
  }

  listening(): string[] {
    return [...this.waiters.keys()].filter((c) => c !== 'terminal')
  }

  ack(consumer: string, seq: number) {
    this.cursors[consumer] = Math.max(this.cursors[consumer] ?? 0, Number(seq) || 0)
    fs.writeFileSync(this.cursorsFile, JSON.stringify(this.cursors))
    return this.cursors[consumer]
  }

  private finish(w: Waiter, payload: Record<string, unknown>) {
    if (w.done) return
    w.done = true
    clearTimeout(w.timer)
    clearTimeout(w.settleTimer)
    clearInterval(w.heartbeat)
    if (this.waiters.get(w.consumer) === w) this.waiters.delete(w.consumer)
    if (!w.res.writableEnded) w.res.end(JSON.stringify(payload))
    this.onPresence(this.listening())
  }

  /** small settle window: a burst (several comments in a row) arrives as one batch */
  private scheduleDelivery(w: Waiter) {
    if (w.done || w.settleTimer) return
    w.settleTimer = setTimeout(() => {
      const evs = this.pending(w.consumer)
      if (evs.length) this.finish(w, { status: 'events', events: evs, ack: evs.at(-1)!.seq })
      else w.settleTimer = undefined
    }, w.settleMs)
  }

  close(reason: string) {
    for (const w of [...this.waiters.values()]) this.finish(w, { status: 'server_stopped', reason })
  }

  /** returns true if the request was handled */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, readBody: () => Promise<string>): Promise<boolean> {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/api/wait' && req.method === 'GET') {
      const consumer = url.searchParams.get('consumer') || 'agent'
      const timeoutS = Math.max(0, Number(url.searchParams.get('timeout') ?? 540))
      const settleMs = Math.max(0, Number(url.searchParams.get('settle') ?? 400))
      const existing = this.waiters.get(consumer)
      if (existing && url.searchParams.get('takeover') !== '1') {
        json(409, { status: 'listener_active', consumer, hint: 'another wait is already listening; pass --takeover to replace it' })
        return true
      }
      if (existing) this.finish(existing, { status: 'replaced' })
      const now = this.pending(consumer)
      if (now.length) {
        json(200, { status: 'events', events: now, ack: now.at(-1)!.seq })
        return true
      }
      // headers at once + whitespace heartbeat (lavish's trick): no header/idle timeout on either side
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.write(' ')
      const w: Waiter = { consumer, res, settleMs, done: false }
      w.heartbeat = setInterval(() => !res.writableEnded && res.write(' '), HEARTBEAT_MS)
      w.timer = setTimeout(() => this.finish(w, { status: 'timeout' }), timeoutS * 1000)
      this.waiters.set(consumer, w)
      res.on('close', () => {
        if (!w.done) this.finish(w, { status: 'abandoned' }) // killed wait: nothing acked, events stay queued
      })
      this.onPresence(this.listening())
      return true
    }
    if (url.pathname === '/api/ack' && req.method === 'POST') {
      const { consumer = 'agent', seq } = JSON.parse((await readBody()) || '{}')
      json(200, { ok: true, cursor: this.ack(consumer, seq) })
      return true
    }
    if (url.pathname === '/api/peek' && req.method === 'GET') {
      const evs = this.pending(url.searchParams.get('consumer') || 'agent')
      json(200, { status: evs.length ? 'events' : 'empty', events: evs, ack: evs.at(-1)?.seq })
      return true
    }
    if (url.pathname === '/api/event' && req.method === 'POST') {
      const { type = 'feedback', ...rest } = JSON.parse((await readBody()) || '{}')
      const ev = this.add(String(type), { ...rest, source: 'http' })
      json(200, { ok: true, seq: ev.seq })
      return true
    }
    return false
  }
}
