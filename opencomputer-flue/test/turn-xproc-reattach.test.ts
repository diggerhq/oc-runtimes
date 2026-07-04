// §11.9 CROSS-PROCESS re-attach (findings 2 + 3, the box-recreation cells no test pinned —
// which is why 2/3/4 survived). A brain settles a run durably in life 1; a FRESH brain over
// the same state dir (new process → empty in-memory buffers/outcomes Maps) must classify the
// prior run's outcome from Flue's DURABLE store, not process memory:
//   - a durably COMPLETED run must NOT re-run (no double model spend) — finding 2
//   - its answer must still reach the OC log from durable events, not the dead buffer
//   - a durably settled-AWAITING run must drain to done{awaiting_input}, not re-run
import { test, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error mjs fixture
import { startMock } from "./fixtures/mock-model.mjs";
// @ts-expect-error mjs fixture
import { startFakeMcp } from "./fixtures/fake-mcp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, "fixtures", "brain-child.mjs");

function spawnBrain(port: number, stateDir: string, extraEnv: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, [CHILD], {
    cwd: join(HERE, ".."),
    env: { ...process.env, OC_BRAIN_PORT: String(port), OC_RUNTIME_STATE_DIR: stateDir, TEST_KEY: "k", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  return child;
}

async function waitReady(port: number): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { const j = (await r.json()) as { status?: string }; if (j.status === "ready") return; }
    } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`brain on :${port} never became ready`);
}

interface Line { kind?: string; reason?: string; offset?: number; attach_mode?: string }

function post(port: number, turn: string, attempt: number, cfg: Record<string, unknown>, extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/turn`, {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ contract_version: "1", turn_id: turn, attempt, input: [{ role: "user", content: "Say READY." }], ...extra, config: cfg }),
  });
}

test("durably completed run: fresh brain drains it, does NOT re-run (finding 2)", async () => {
  let modelRequests = 0;
  const { port: model } = await startMock({ onRequest: () => modelRequests++ });
  const { port: mcp } = await startFakeMcp();
  const stateDir = mkdtempSync(join(tmpdir(), "ocflue-xproc-"));
  const cfg = {
    model: "anthropic/claude-sonnet-5", system_prompt: "t",
    mcp_endpoint: `http://127.0.0.1:${mcp}/mcp`, state_dir: stateDir, deadline_s: 120,
    endpoint_profile: { mode: "byo", auth_env: "TEST_KEY", base_url: `http://127.0.0.1:${model}` },
  };

  // Life 1: run T to a clean completion, then kill the brain (box recreation after settle).
  const brain1 = spawnBrain(19140, stateDir);
  try {
    await waitReady(19140);
    const res = await post(19140, "TX", 1, cfg);
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Line);
    expect(lines[lines.length - 1].reason).toBe("quiescent");
    expect(lines.map((l) => l.kind)).toContain("message_end");
  } finally { brain1.kill("SIGKILL"); }
  await new Promise((r) => setTimeout(r, 300));
  const afterLife1 = modelRequests;
  expect(afterLife1).toBeGreaterThanOrEqual(1);

  // Life 2: a FRESH brain (empty buffers/outcomes Maps) must read the DURABLE outcome =
  // completed → drain, NOT re-admit. modelRequests must not increase.
  const brain2 = spawnBrain(19141, stateDir);
  try {
    await waitReady(19141);
    const res = await post(19141, "TX", 2, cfg, { events_from_offset: 0 });
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Line);
    const done = lines[lines.length - 1];
    expect(done.reason).toBe("quiescent");
    expect(done.attach_mode).toBe("drain_settled");
    expect(modelRequests).toBe(afterLife1); // NO second run — the durably-completed run was drained
    // the answer reaches the log from durable events, not the dead in-memory buffer
    expect(lines.map((l) => l.kind)).toContain("message_end");
  } finally { brain2.kill("SIGKILL"); }
}, 90_000);

test("durably settled-awaiting run: fresh brain drains to awaiting_input, no re-run", async () => {
  // The tool_use decision is the mock MODEL's (parent process) — set it here, not in the
  // brain child's env (the mock reads process.env at request time, in this process).
  process.env.MOCK_TOOL = "1";
  process.env.MOCK_TOOL_NAME = "ask";
  process.env.MOCK_TOOL_INPUT = JSON.stringify({ question: "Which region?" });
  try {
    let modelRequests = 0;
    const { port: model } = await startMock({ onRequest: () => modelRequests++ });
    const { port: mcp } = await startFakeMcp();
    const stateDir = mkdtempSync(join(tmpdir(), "ocflue-xproc-ask-"));
    const cfg = {
      model: "anthropic/claude-sonnet-5", system_prompt: "t",
      mcp_endpoint: `http://127.0.0.1:${mcp}/mcp`, state_dir: stateDir, deadline_s: 120,
      endpoint_profile: { mode: "byo", auth_env: "TEST_KEY", base_url: `http://127.0.0.1:${model}` },
    };

    // Life 1: DETACH before done (adapter died before delivering awaiting_input). The engine
    // keeps running (R1): the ask fires server-side, sets the durable flag, settles — but the
    // flag is NOT consumed (no live subscriber). Then the box is recreated (kill).
    const brain1 = spawnBrain(19142, stateDir);
    try {
      await waitReady(19142);
      const ac = new AbortController();
      const res = await post(19142, "TA", 1, cfg, {}, ac.signal);
      await res.body!.getReader().read(); // one event → the run is live
      ac.abort();                          // detach before done
      await new Promise((r) => setTimeout(r, 600)); // let the ask fire + settle server-side
    } finally { brain1.kill("SIGKILL"); }
    await new Promise((r) => setTimeout(r, 300));
    const afterLife1 = modelRequests;

    const brain2 = spawnBrain(19143, stateDir);
    try {
      await waitReady(19143);
      const res = await post(19143, "TA", 2, cfg, { events_from_offset: 0 });
      const done = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Line).pop();
      expect(done?.reason).toBe("awaiting_input"); // durable awaiting flag survived the process
      expect(done?.attach_mode).toBe("drain_settled");
      expect(modelRequests).toBe(afterLife1); // no re-run
    } finally { brain2.kill("SIGKILL"); }
  } finally {
    delete process.env.MOCK_TOOL;
    delete process.env.MOCK_TOOL_NAME;
    delete process.env.MOCK_TOOL_INPUT;
  }
}, 90_000);
