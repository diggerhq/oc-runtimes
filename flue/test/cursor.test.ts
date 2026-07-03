// Offset-cursor helper tests (design 012 §11.9 R6, contract 12). The driver persists the flue
// stream offset at `<stateDir>/spool/turn-<T>.flue-offset` after each successful append, reads
// it at the next attempt (→ events_from_offset), and clears it on a clean terminal. These live
// in @oc/adapter-core (W2a); tested here since the flue package consumes them.
//
// Run: npx tsx test/cursor.test.ts

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @oc/adapter-core's oc.js reads OC_* config at module load (it's the runtime's substrate).
// The cursor helpers do NO network I/O, so dummy values let us import them in isolation.
// Set BEFORE the dynamic import (static imports evaluate before any statement runs).
process.env.OC_API_URL ??= "http://localhost";
process.env.OC_SESSION_ID ??= "test-session";
process.env.OC_TURN_TOKEN ??= "test-token";
const { readOffsetCursor, writeOffsetCursor, clearOffsetCursor } = await import("@oc/adapter-core");

let failed = 0;
const ok = (n: string, c: boolean, e = "") => { console.log(`${c ? "ok  " : "FAIL"} ${n}${c ? "" : "  <<< " + e}`); if (!c) failed++; };

const root = mkdtempSync(join(tmpdir(), "flue-cursor-"));
const T = "abc";

function run() {
  ok("absent cursor → undefined", readOffsetCursor(root, T) === undefined);

  writeOffsetCursor(root, T, 7);
  ok("write then read round-trips", readOffsetCursor(root, T) === 7);
  ok("cursor lives under spool/turn-<T>.flue-offset", existsSync(join(root, "spool", `turn-${T}.flue-offset`)));

  writeOffsetCursor(root, T, 42);
  ok("overwrite advances the cursor", readOffsetCursor(root, T) === 42);

  // Offset 0 is a real value (not falsy-coerced away).
  writeOffsetCursor(root, T, 0);
  ok("offset 0 round-trips (not treated as absent)", readOffsetCursor(root, T) === 0);

  clearOffsetCursor(root, T);
  ok("clear removes the cursor → undefined", readOffsetCursor(root, T) === undefined && !existsSync(join(root, "spool", `${T}.flue-offset`)));

  // Per-turn isolation: a different turn id has its own cursor.
  writeOffsetCursor(root, "turn-x", 3);
  writeOffsetCursor(root, "turn-y", 9);
  ok("cursors are per-turn-id", readOffsetCursor(root, "turn-x") === 3 && readOffsetCursor(root, "turn-y") === 9);

  clearOffsetCursor(root, "missing"); // clearing an absent cursor is a no-op, never throws
  ok("clear on absent cursor is a safe no-op", true);

  rmSync(root, { recursive: true, force: true });
  console.log(failed ? `\n${failed} FAILED` : "\nall cursor tests passed");
  process.exit(failed ? 1 : 0);
}

run();
