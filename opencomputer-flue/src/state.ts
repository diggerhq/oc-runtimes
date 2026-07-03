// Durable per-session package state under <state_dir>/oc-flue/ (design 012 §11.9).
// Two facts must survive attempt death (the adapter process dies; this brain process may
// also die with the box): the turn-map (contract 19 — our attempt-scoped idempotency key →
// flue's generated submissionId, written BEFORE admit so a crash between admit and settle
// is recoverable) and the awaiting-flag (the ask marker that turns settled-aborted into
// done{awaiting_input} — §11.9 R3's drain row).

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface TurnMapEntry {
  submissionId: string;
  admittedAt: string;
}

export class PackageState {
  private readonly dir: string;
  private readonly mapPath: string;
  private readonly awaitingPath: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, "oc-flue");
    this.mapPath = join(this.dir, "turn-map.json");
    this.awaitingPath = join(this.dir, "awaiting.json");
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

  /** Any mapping for this TURN (any attempt) — the R3 "engine state for T" lookup. */
  findTurn(turnId: string): TurnMapEntry | null {
    const map = this.readJson<Record<string, TurnMapEntry>>(this.mapPath, {});
    const keys = Object.keys(map).filter((k) => k.startsWith(`rt:${turnId}:`)).sort();
    const last = keys[keys.length - 1];
    return last ? map[last] : null;
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
