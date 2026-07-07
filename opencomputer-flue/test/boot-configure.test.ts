// §11.4/§11.7.7 eager configure (finding 7): /healthz must not report "ready" until the agent
// is validated (initialize runs, profile holds, sqlite opens, R4 runs). A bundle whose
// initialize() throws fails VERIFY (the probe waits for ready), not the paying user's first turn.
import { test, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function spawnBrain(fixture: string, port: number, stateDir: string): ChildProcess {
  const child = spawn(process.execPath, [join(HERE, "fixtures", fixture)], {
    cwd: join(HERE, ".."),
    env: { ...process.env, OC_BRAIN_PORT: String(port), OC_RUNTIME_STATE_DIR: stateDir, TEST_KEY: "k" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  return child;
}

async function healthz(port: number): Promise<{ status?: string; detail?: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
    return (await r.json()) as { status?: string; detail?: string };
  } catch { return null; }
}

test("a good bundle reaches /healthz ready (eager configure passed)", async () => {
  const brain = spawnBrain("brain-child.mjs", 19150, mkdtempSync(join(tmpdir(), "ocflue-boot-ok-")));
  try {
    let hz = null;
    for (let i = 0; i < 60 && hz?.status !== "ready"; i++) { await new Promise((r) => setTimeout(r, 250)); hz = await healthz(19150); }
    expect(hz?.status).toBe("ready");
  } finally { brain.kill("SIGKILL"); }
}, 30_000);

test("a bundle whose initialize() throws NEVER reports ready — it reports error", async () => {
  const brain = spawnBrain("brain-child-bad.mjs", 19151, mkdtempSync(join(tmpdir(), "ocflue-boot-bad-")));
  try {
    // give it ample time to (fail to) configure; it must resolve to error, never ready
    let hz = null;
    for (let i = 0; i < 40 && (hz === null || hz.status === "starting"); i++) { await new Promise((r) => setTimeout(r, 250)); hz = await healthz(19151); }
    expect(hz?.status).toBe("error");
    expect(hz?.detail).toMatch(/boom/i);
    // and a turn against it fails fast (503 not_configured), never admits the bad agent
    const res = await fetch("http://127.0.0.1:19151/turn", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contract_version: "1", turn_id: "T", attempt: 1, input: [{ role: "user", content: "hi" }], config: {} }),
    });
    expect(res.status).toBe(503);
  } finally { brain.kill("SIGKILL"); }
}, 30_000);
