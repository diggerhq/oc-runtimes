// §11.9 R3 orphan-abort (S3 grid, DoD row 16): a NEW turn arriving while a fenced
// predecessor's run is still unsettled aborts it, then admits fresh — and says so on the
// done line (runtime.orphan_abort feedstock).
import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error mjs fixture
import { startMock } from "./fixtures/mock-model.mjs";
// @ts-expect-error mjs fixture
import { startFakeMcp } from "./fixtures/fake-mcp.mjs";

const PORT = 18137;

test("new turn orphan-aborts the previous turn's live run, then runs clean", async () => {
  const { port: model } = await startMock({});
  const { port: mcp } = await startFakeMcp();
  const stateDir = mkdtempSync(join(tmpdir(), "ocflue-orphan-"));
  process.env.OC_RUNTIME_STATE_DIR = stateDir;
  process.env.OC_BRAIN_PORT = String(PORT);
  process.env.TEST_KEY = "k";
  process.env.MOCK_DELAY_MS = "8000"; // turn A's model call hangs well past the test's fast path

  const { defineAgent } = await import("@flue/runtime");
  const { serveOC } = await import("../dist/index.js");
  serveOC(defineAgent(() => ({ model: "anthropic/claude-sonnet-5", tools: [], instructions: "t" })) as never);
  await new Promise((r) => setTimeout(r, 250));

  const cfg = {
    model: "anthropic/claude-sonnet-5", system_prompt: "t",
    mcp_endpoint: `http://127.0.0.1:${mcp}/mcp`, state_dir: stateDir, deadline_s: 120,
    endpoint_profile: { mode: "byo", auth_env: "TEST_KEY", base_url: `http://127.0.0.1:${model}` },
  };
  const post = (turn: string, signal?: AbortSignal): Promise<Response> =>
    fetch(`http://127.0.0.1:${PORT}/turn`, {
      method: "POST", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({ contract_version: "1", turn_id: turn, attempt: 1, input: [{ role: "user", content: "Say READY." }], config: cfg }),
    });

  // Turn A: admitted, mid-run (model pending). Read one step so it is claimed, then detach.
  const ac = new AbortController();
  const resA = await post("TA", ac.signal);
  const reader = resA.body!.getReader();
  await reader.read(); // first chunk = the run is live
  await new Promise((r) => setTimeout(r, 400));
  ac.abort();

  // Turn B: the fence successor. Its attach must abort A's run and admit fresh.
  process.env.MOCK_DELAY_MS = ""; // B's own model call answers immediately
  let resB: Response | null = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    resB = await post("TB");
    if (resB.status !== 409) break;
  }
  expect(resB!.status).toBe(200);
  const lines = (await resB!.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const done = lines[lines.length - 1] as { kind?: string; reason?: string; attach_mode?: string; orphan_abort?: { aborted?: number } };
  expect(done.kind).toBe("done");
  expect(done.reason).toBe("quiescent");
  expect(done.attach_mode).toBe("fresh");
  expect(done.orphan_abort?.aborted).toBe(1);

  // The engine is quiescent afterwards — nothing left running or queued.
  const hz = (await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()) as { busy: boolean };
  expect(hz.busy).toBe(false);
}, 60_000);
