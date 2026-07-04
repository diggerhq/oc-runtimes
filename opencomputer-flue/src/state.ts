// Durable per-session package state under <state_dir>/oc-flue/ (design 012 §11.9).
// THREE facts must survive attempt death (the adapter process dies; this brain process may
// also die with the box): the turn-map (contract 19 — our attempt-scoped idempotency key →
// flue's generated submissionId, written BEFORE admit so a crash between admit and settle
// is recoverable); the awaiting-flag (the ask marker that turns settled-aborted into
// done{awaiting_input} — §11.9 R3's drain row); and the SETTLE OUTCOME (finding 2 —
// `getSubmission` cannot distinguish completed/aborted/failed for a direct submission, all
// settle to error=NULL, and flue's durable settlement record is behind unexported internals;
// so on settle we persist our OWN {outcome, answerText} keyed by submissionId, read on
// re-attach in a FRESH process where the in-memory outcome Map is empty).

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface TurnMapEntry {
  submissionId: string;
  admittedAt: string;
}

export interface OutcomeRecord {
  outcome: "completed" | "failed" | "aborted";
  error?: string;
  /** the run's final assistant text — replayed on a fresh-process drain so a completed run
   *  whose events lived only in the dead process's buffer still delivers its answer. */
  answerText?: string;
}

const ANSWER_TEXT_CAP = 16 * 1024; // the OC log is the record; this is only the drain safety-net

export class PackageState {
  private readonly dir: string;
  private readonly mapPath: string;
  private readonly awaitingPath: string;

  private readonly outcomePath: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, "oc-flue");
    this.mapPath = join(this.dir, "turn-map.json");
    this.awaitingPath = join(this.dir, "awaiting.json");
    this.outcomePath = join(this.dir, "outcomes.json");
    mkdirSync(this.dir, { recursive: true });
  }

  private readJson<T>(path: string, fallback: T): T {
    try {
      if (!existsSync(path)) return fallback;
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return fallback; // a torn write loses the optimization, never the turn (idempotent admission)
    }
  }

  /** The turn-map: `rt:<turn_id>:<attempt>` → the flue submission this attempt admitted. */
  getSubmission(key: string): TurnMapEntry | null {
    const map = this.readJson<Record<string, TurnMapEntry>>(this.mapPath, {});
    return map[key] ?? null;
  }

  /** Written BEFORE admit (crash-safe: replay finds the mapping and re-attaches, not re-admits). */
  recordSubmission(key: string, submissionId: string): void {
    const map = this.readJson<Record<string, TurnMapEntry>>(this.mapPath, {});
    map[key] = { submissionId, admittedAt: new Date().toISOString() };
    writeFileSync(this.mapPath, JSON.stringify(map));
  }

  /** Any mapping for this TURN (any attempt) — the R3 "engine state for T" lookup. Returns
   *  the HIGHEST-attempt mapping. Sort by the numeric attempt, not lexicographically:
   *  `rt:T:10` must beat `rt:T:9` (a `.sort()` on the raw key ranks "10" < "9"). */
  findTurn(turnId: string): TurnMapEntry | null {
    const prefix = `rt:${turnId}:`;
    let best: { attempt: number; entry: TurnMapEntry } | null = null;
    const map = this.readJson<Record<string, TurnMapEntry>>(this.mapPath, {});
    for (const [key, entry] of Object.entries(map)) {
      if (!key.startsWith(prefix)) continue;
      const attempt = Number(key.slice(prefix.length));
      if (!Number.isFinite(attempt)) continue;
      if (!best || attempt > best.attempt) best = { attempt, entry };
    }
    return best ? best.entry : null;
  }

  /** Reverse lookup for the orphan sweep: which turn admitted this submission (null = unmapped,
   *  i.e. a crash landed between admit and record — treated as an orphan by the caller). */
  turnForSubmission(submissionId: string): string | null {
    const map = this.readJson<Record<string, TurnMapEntry>>(this.mapPath, {});
    for (const [key, entry] of Object.entries(map)) {
      if (entry.submissionId === submissionId) {
        const m = /^rt:(.+):\d+$/.exec(key);
        return m ? m[1] : null;
      }
    }
    return null;
  }

  /** Persist a run's settle outcome (finding 2). Written in the settle callback — durable so a
   *  fresh process classifies a prior run WITHOUT re-admitting a completed one (double spend). */
  recordOutcome(submissionId: string, rec: OutcomeRecord): void {
    const map = this.readJson<Record<string, OutcomeRecord>>(this.outcomePath, {});
    map[submissionId] = rec.answerText != null
      ? { ...rec, answerText: rec.answerText.slice(0, ANSWER_TEXT_CAP) }
      : rec;
    writeFileSync(this.outcomePath, JSON.stringify(map));
  }

  /** The durable settle outcome for a submission, or null if it never settled here. */
  getOutcome(submissionId: string): OutcomeRecord | null {
    const map = this.readJson<Record<string, OutcomeRecord>>(this.outcomePath, {});
    return map[submissionId] ?? null;
  }

  /** The persisted ask flag. Set by the ask tool BEFORE it aborts; cleared when consumed. */
  setAwaiting(turnId: string): void {
    writeFileSync(this.awaitingPath, JSON.stringify({ turnId, at: new Date().toISOString() }));
  }

  consumeAwaiting(turnId: string): boolean {
    const cur = this.readJson<{ turnId?: string }>(this.awaitingPath, {});
    if (cur.turnId !== turnId) return false;
    writeFileSync(this.awaitingPath, JSON.stringify({}));
    return true;
  }
}
