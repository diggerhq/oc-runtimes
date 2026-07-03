// Permanent smoke (design 012 §11.10): drive the runtime image's launcher + translate against
// the COMMITTED fixture artifact (testdata/artifact) — no npm, no user build, no @flue/runtime.
// It proves the full adapter-side path: bootFlueBrain resolves + imports the artifact entry →
// the (stand-in) brain binds and speaks the /healthz + /turn NDJSON contract → the driver's
// step shape {seq,kind,offset,msg} carries FlueEvents → translateFlueEvent maps them to OC
// events with the §11.6 dedup rule. When W1's real serveOC replaces the stand-in, this same
// test drives it unchanged.
//
// Run: npx tsx test/fixture-smoke.test.ts

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootFlueBrain } from "../src/server.js";
import { translateFlueEvent } from "../src/translate.js";
import type { DurableEmitter, TranslateCtx } from "@oc/adapter-core";

let failed = 0;
const ok = (n: string, c: boolean, e = "") => { console.log(`${c ? "ok  " : "FAIL"} ${n}${c ? "" : "  <<< " + e}`); if (!c) failed++; };

const testDir = dirname(fileURLToPath(import.meta.url));
const stateDir = join(testDir, "..", "testdata"); // <stateDir>/artifact = testdata/artifact
const PORT = 8791;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(deadlineMs: number): Promise<{ status?: string; busy?: boolean } | null> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return (await r.json()) as any;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return null;
}

async function run() {
  process.env.OC_RUNTIME_STATE_DIR = stateDir;
  process.env.OC_BRAIN_PORT = String(PORT);

  // 1. Launcher resolves + imports the committed artifact entry → the brain binds.
  await bootFlueBrain();
  const health = await waitHealthy(10_000);
  ok("launcher booted the fixture artifact → /healthz ready", health?.status === "ready", JSON.stringify(health));

  // 2. Drive /turn and read the NDJSON stream (the driver's contract).
  const res = await fetch(`http://127.0.0.1:${PORT}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contract_version: "1", turn_id: "t1", attempt: 1, input: [{ role: "user", content: "hi" }], config: { model: "anthropic/claude-sonnet-5", state_dir: stateDir } }),
  });
  ok("POST /turn → 200 NDJSON", res.ok && (res.headers.get("content-type") ?? "").includes("ndjson"), `${res.status} ${res.headers.get("content-type")}`);

  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const steps = lines.filter((l) => l.kind !== "done");
  const done = lines.find((l) => l.kind === "done");

  ok("terminal done{quiescent}", done?.reason === "quiescent", JSON.stringify(done));
  ok("every step carries {seq,kind,offset,msg}", steps.every((s) => typeof s.seq === "number" && typeof s.kind === "string" && typeof s.offset === "number" && s.msg), JSON.stringify(steps.map((s) => ({ kind: s.kind, offset: s.offset }))));
  ok("offsets are the flue eventIndex sequence (R6 cursor input)", JSON.stringify(steps.map((s) => s.offset)) === JSON.stringify([1, 2, 3, 4, 5]), JSON.stringify(steps.map((s) => s.offset)));

  // 3. Translate the stream exactly as the driver does → assert OC taxonomy + the dedup rule.
  const events: Array<{ type: string; level?: string; body?: any }> = [];
  const notes: string[] = [];
  const emitter = { emit: async (ev: any) => { events.push(ev); }, drain: async () => {} } as unknown as DurableEmitter;
  const ctx: TranslateCtx = { model: "anthropic/claude-sonnet-5", noteAssistantText: (t) => notes.push(t) };
  for (const step of steps) await translateFlueEvent(emitter, step.msg, ctx);

  ok("message_end → agent.message@progress", events.some((e) => e.type === "agent.message" && e.level === "progress" && e.body?.text === "Fixture brain answer."), JSON.stringify(events));
  ok("safety-net note captured", notes.includes("Fixture brain answer."));
  ok("custom tool 'lookup_order' → tool.call", events.some((e) => e.type === "tool.call" && e.body?.tool === "lookup_order"), JSON.stringify(events));
  ok("proxied tool 'bash' → NO tool.call (dedup)", !events.some((e) => e.type === "tool.call" && e.body?.tool === "bash"));
  ok("turn usage → agent.result@internal", events.some((e) => e.type === "agent.result" && e.level === "internal" && e.body?.usage?.input_tokens === 10));
  ok("text_delta dropped (no stray event)", events.filter((e) => e.type === "agent.message").length === 1);

  console.log(failed ? `\n${failed} FAILED` : "\nall fixture-smoke tests passed");
  process.exit(failed ? 1 : 0);
}

run();
