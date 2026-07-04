// §11.9 R3 re-attach + R6 cursor + drain-settled (S3 grid): drop the socket mid-run —
// the engine keeps running (R1), the slot frees immediately, attempt 2 re-attaches from
// the offset cursor with NO second admit, and a post-settle attempt drains the tail.
import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error mjs fixture
import { startMock } from "./fixtures/mock-model.mjs";
// @ts-expect-error mjs fixture
import { startFakeMcp } from "./fixtures/fake-mcp.mjs";

const PORT = 18135;

interface Line { kind?: string; reason?: string; offset?: number; attach_mode?: string }

function postTurn(turn: string, attempt: number, extra: Record<string, unknown>, cfg: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${PORT}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      contract_version: "1", turn_id: turn, attempt,
      input: [{ role: "user", content: "Say READY." }], ...extra, config: cfg,
    }),
  });
}

test("detach frees the slot; attempt 2 re-attaches (one admit); attempt 3 drains settled", async () => {
  let modelRequests = 0;
  const { port: model } = await startMock({ onRequest: () => modelRequests++ });
  const { port: mcp } = await startFakeMcp();
  const stateDir = mkdtempSync(join(tmpdir(), "ocflue-reattach-"));
  process.env.OC_RUNTIME_STATE_DIR = stateDir;
  process.env.OC_BRAIN_PORT = String(PORT);
  process.env.TEST_KEY = "k";
  process.env.MOCK_DELAY_MS = "2500"; // keep the run alive across the detach window

  const { defineAgent } = await import("@flue/runtime");
  const { serveOC } = await import("../dist/index.js");
  serveOC(defineAgent(() => ({ model: "anthropic/claude-sonnet-5", tools: [], instructions: "t" })) as never);
  await new Promise((r) => setTimeout(r, 250));

  const cfg = {
    model: "anthropic/claude-sonnet-5", system_prompt: "t",
    mcp_endpoint: `http://127.0.0.1:${mcp}/mcp`, state_dir: stateDir, deadline_s: 120,
    endpoint_profile: { mode: "byo", auth_env: "TEST_KEY", base_url: `http://127.0.0.1:${model}` },
  };

  // Attempt 1: read the stream until the first offset-bearing step, then drop the socket.
  const ac = new AbortController();
  const res1 = await postTurn("TR", 1, {}, cfg, ac.signal);
  expect(res1.status).toBe(200);
  const reader = res1.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let lastOffset = -1;
  while (lastOffset < 0) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const raw of buf.split("\n")) {
      if (!raw.trim()) continue;
      try {
        const l = JSON.parse(raw) as Line;
        if (typeof l.offset === "number") lastOffset = Math.max(lastOffset, l.offset);
      } catch { /* partial line */ }
    }
  }
  expect(lastOffset).toBeGreaterThanOrEqual(0);
  ac.abort(); // detach — R1: the engine keeps running

  // Attempt 2 must be accepted promptly (released slot), not 409'd until settle.
  let res2: Response | null = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    res2 = await postTurn("TR", 2, { events_from_offset: lastOffset }, cfg);
    if (res2.status !== 409) break;
  }
  expect(res2!.status).toBe(200);
  const lines2 = (await res2!.text()).trim().split("\n").map((l) => JSON.parse(l) as Line);
  const done2 = lines2[lines2.length - 1];
  expect(done2.kind).toBe("done");
  expect(done2.reason).toBe("quiescent");
  expect(done2.attach_mode).toBe("reattach");
  // R6: replay starts past the cursor — no step at or before lastOffset is repeated
  expect(lines2.filter((l) => l.kind !== "done").every((l) => (l.offset ?? -1) > lastOffset)).toBe(true);
  // ONE admit total: the model ran the conversation once (no duplicated spend)
  expect(modelRequests).toBe(1);

  // Attempt 3 after settle: drain path, same terminal, still no new model spend.
  const res3 = await postTurn("TR", 3, { events_from_offset: lastOffset }, cfg);
  const lines3 = (await res3.text()).trim().split("\n").map((l) => JSON.parse(l) as Line);
  const done3 = lines3[lines3.length - 1];
  expect(done3.reason).toBe("quiescent");
  expect(done3.attach_mode).toBe("drain_settled");
  expect(modelRequests).toBe(1);
}, 60_000);
