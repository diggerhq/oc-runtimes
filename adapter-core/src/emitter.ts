// The adapter's single, durable, serialized append path (runtime.md §3.2/§3.7d).
//
// Both the turn-stream translator AND the MCP host (say/ask, tool.call/exec.completed)
// emit through ONE DurableEmitter so OC events get monotonic idempotency keys and a
// single, ordered spool — the adapter is the single writer the platform's fence
// already assumes (§3.5).
//
// Durability (§3.7d) — append-before-ack spool, independent of native-replay
// determinism (V4 is a separate gate; the spool is the safe default + fallback):
//   1. assign the stable key  rt:<turn>:<base+n>  (base = host-seeded OC_EVENT_KEY_BASE)
//   2. write {key, ev} to the append-only spool  (the durable "this step happened")
//   3. POST the event to the OC log with that key  (oc.ts appendEvent — dedups by key)
//   4. record the key in the ack log
// On restart the adapter calls recover() FIRST: it re-appends every spooled-but-unacked
// entry with its ORIGINAL key (idempotent — the single writer dedups), then seeds the
// fresh counter ABOVE every spooled index so new steps can't collide with a replayed key.
//
// Keys: oc.ts appendEvent honours an explicit idempotencyKey and throws Error("fenced")
// on a 401 — so this owns key sequencing without touching oc.ts or the legacy index.ts.

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, type OutEvent } from "./oc.js";

const keyBase = Number(process.env.OC_EVENT_KEY_BASE ?? "0") || 0;

interface SpoolLine {
  key: string;
  ev: OutEvent;
}

export class DurableEmitter {
  private seq = 0;
  private tail: Promise<void> = Promise.resolve();   // serializes appends (monotonic keys + ordered spool)
  private readonly spoolPath: string;
  private readonly ackPath: string;

  constructor(stateDir: string, private readonly turnId: string) {
    const dir = join(stateDir, "spool");
    mkdirSync(dir, { recursive: true });
    // Per-turn files (the turn id is the natural attempt-stable scope: a crash-restart
    // re-runs the SAME turn id, so recover() finds this turn's prior spool).
    this.spoolPath = join(dir, `turn-${turnId}.ndjson`);
    this.ackPath = join(dir, `turn-${turnId}.acked`);
  }

  /**
   * Flush spooled-but-unacked steps from a prior crashed attempt BEFORE the brain
   * re-runs (§3.7d). Idempotent: re-appends with the ORIGINAL key, so the OC single
   * writer dedups anything already committed. Then seeds the fresh key counter above
   * every spooled index so a new step never reuses a replayed absolute key (the
   * collision hazard of a host-bumped base meeting a stale uncommitted spool entry).
   * Returns the number of entries re-appended (0 = clean start).
   */
  async recover(): Promise<number> {
    if (!existsSync(this.spoolPath)) return 0;
    const spooled = readLines(this.spoolPath).map(parseSpoolLine).filter((x): x is SpoolLine => x != null);
    const acked = new Set(existsSync(this.ackPath) ? readLines(this.ackPath) : []);

    let flushed = 0;
    let maxIndex = -1;
    for (const line of spooled) {
      maxIndex = Math.max(maxIndex, indexOfKey(line.key));
      if (acked.has(line.key)) continue;
      await appendEvent({ ...line.ev, idempotencyKey: line.key });   // throws "fenced" on 401 — adapter handles
      appendFileSync(this.ackPath, line.key + "\n");
      flushed++;
    }
    // Fresh keys = rt:<turn>:<keyBase + seq>. Push seq up so (keyBase + seq) exceeds
    // every spooled index. keyBase is already above every COMMITTED key (host bumps it
    // pre-restart); this also clears any uncommitted spooled key.
    if (maxIndex >= 0) this.seq = Math.max(this.seq, maxIndex - keyBase + 1);
    if (this.seq < 0) this.seq = 0;
    return flushed;
  }

  /** Enqueue an event on the serialized tail. Resolves once committed (or rejects "fenced"). */
  emit(ev: OutEvent): Promise<void> {
    const p = this.tail.then(() => this.emitOne(ev));
    // Keep the chain alive even if a link rejects, so ordering holds; the rejection
    // still propagates to this caller's returned promise.
    this.tail = p.catch(() => {});
    return p;
  }

  /** Wait for all enqueued appends to settle (flush-before-quiescent, §3.5). */
  async drain(): Promise<void> {
    await this.tail;
  }

  private async emitOne(ev: OutEvent): Promise<void> {
    const key = `rt:${this.turnId}:${keyBase + this.seq++}`;
    // Spool BEFORE the network append: the durable record that this step happened.
    appendFileSync(this.spoolPath, JSON.stringify({ key, ev } satisfies SpoolLine) + "\n");
    await appendEvent({ ...ev, idempotencyKey: key });
    appendFileSync(this.ackPath, key + "\n");
  }
}

function readLines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
}

function parseSpoolLine(line: string): SpoolLine | null {
  try {
    const o = JSON.parse(line) as SpoolLine;
    return o && typeof o.key === "string" && o.ev ? o : null;
  } catch {
    return null;   // a torn final line from a crash mid-write — skip (it was never acked)
  }
}

function indexOfKey(key: string): number {
  const n = Number(key.slice(key.lastIndexOf(":") + 1));
  return Number.isFinite(n) ? n : -1;
}
