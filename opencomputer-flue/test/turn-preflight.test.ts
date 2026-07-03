// A dead MCP host must fail the turn LOUDLY (P0: it otherwise wedges flue's claim in
// silent queued-retry via init-time env probes).
import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error mjs fixture
import { startMock } from "./fixtures/mock-model.mjs";

test("unreachable MCP host → fast done{error}, not a wedge", async () => {
  const { port: model } = await startMock({});
  const stateDir = mkdtempSync(join(tmpdir(), "ocflue-"));
  process.env.OC_RUNTIME_STATE_DIR = stateDir;
  process.env.OC_BRAIN_PORT = "18132";
  process.env.TEST_KEY = "k";
  const { defineAgent } = await import("@flue/runtime");
  const { serveOC } = await import("../dist/index.js");
  serveOC(defineAgent(() => ({ model: "anthropic/claude-sonnet-5", tools: [], instructions: "t" })) as never);
  await new Promise((r) => setTimeout(r, 250));

  const t0 = Date.now();
  const res = await fetch("http://127.0.0.1:18132/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contract_version: "1", turn_id: "T1", attempt: 1,
      input: [{ role: "user", content: "x" }],
      config: {
        model: "anthropic/claude-sonnet-5", system_prompt: "t",
        mcp_endpoint: "http://127.0.0.1:1/mcp", state_dir: stateDir, deadline_s: 120,
        endpoint_profile: { mode: "byo", auth_env: "TEST_KEY", base_url: `http://127.0.0.1:${model}` },
      },
    }),
  });
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { kind?: string; reason?: string; error?: { message?: string } });
  const done = lines[lines.length - 1];
  expect(done.kind).toBe("done");
  expect(done.reason).toBe("error");
  expect(done.error?.message ?? "").toMatch(/MCP host unreachable/);
  expect(Date.now() - t0).toBeLessThan(15_000);
}, 30_000);
