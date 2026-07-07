// §11.9 R4 (S3 grid, DoD row 19 feedstock): SIGKILL a brain mid-run — the row stays
// `running` in flue.db. A fresh brain over the same state dir settles it at boot (fast
// path, no 30s lease wait), reports it on its first done line, and serves cleanly.
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

function spawnBrain(port: number, stateDir: string): ChildProcess {
  const child = spawn(process.execPath, [CHILD], {
    cwd: join(HERE, ".."),
    env: { ...process.env, OC_BRAIN_PORT: String(port), OC_RUNTIME_STATE_DIR: stateDir, TEST_KEY: "k" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  return child;
}

async function waitReady(port: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`brain on :${port} never became ready`);
}

test("killed-mid-run brain leaves a running row; next boot R4-settles and reports it", async () => {
  const { port: model } = await startMock({});
  const { port: mcp } = await startFakeMcp();
  const stateDir = mkdtempSync(join(tmpdir(), "ocflue-r4-"));
  const cfg = {
    model: "anthropic/claude-sonnet-5", system_prompt: "t",
    mcp_endpoint: `http://127.0.0.1:${mcp}/mcp`, state_dir: stateDir, deadline_s: 120,
    endpoint_profile: { mode: "byo", auth_env: "TEST_KEY", base_url: `http://127.0.0.1:${model}` },
  };
  const post = (port: number, turn: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/turn`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contract_version: "1", turn_id: turn, attempt: 1, input: [{ role: "user", content: "Say READY." }], config: cfg }),
    });

  // Life 1: start a turn whose model call hangs, confirm it is live, SIGKILL the brain.
  process.env.MOCK_DELAY_MS = "15000";
  const brain1 = spawnBrain(18139, stateDir);
  try {
    await waitReady(18139);
    const resA = await post(18139, "TR4");
    const reader = resA.body!.getReader();
    await reader.read(); // stream started — the submission is claimed and running
    await new Promise((r) => setTimeout(r, 700));
  } finally {
    brain1.kill("SIGKILL");
  }
  await new Promise((r) => setTimeout(r, 300));

  // Life 2: same state dir. Boot must reconcile-to-quiescence — NOT resume the stale run —
  // and the first turn's done line carries the R4 count.
  process.env.MOCK_DELAY_MS = "";
  const brain2 = spawnBrain(18140, stateDir);
  try {
    await waitReady(18140);
    const res = await post(18140, "TNEW");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const done = lines[lines.length - 1] as { kind?: string; reason?: string; attach_mode?: string; stale_runs_settled?: number };
    expect(done.kind).toBe("done");
    expect(done.reason).toBe("quiescent");
    expect(done.attach_mode).toBe("fresh");
    expect(done.stale_runs_settled).toBeGreaterThanOrEqual(1);

    // quiescent after: the stale run was settled, not resumed
    const hz = (await (await fetch("http://127.0.0.1:18140/healthz")).json()) as { busy: boolean };
    expect(hz.busy).toBe(false);
  } finally {
    brain2.kill("SIGKILL");
  }
}, 90_000);
