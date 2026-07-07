// Happy path over the REAL brain contract: healthz → POST /turn → NDJSON → done{quiescent}.
import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error mjs fixture
import { startMock } from "./fixtures/mock-model.mjs";
// @ts-expect-error mjs fixture
import { startFakeMcp, calls } from "./fixtures/fake-mcp.mjs";

test("turn streams events and settles quiescent; sandbox probes flow over MCP", async () => {
  const { port: model } = await startMock({});
  const { port: mcp } = await startFakeMcp();
  const stateDir = mkdtempSync(join(tmpdir(), "ocflue-"));
  process.env.OC_RUNTIME_STATE_DIR = stateDir;
  process.env.OC_BRAIN_PORT = "18131";
  process.env.TEST_KEY = "k";

  const { defineAgent } = await import("@flue/runtime");
  const { serveOC } = await import("../dist/index.js");
  const agent = defineAgent(() => ({ model: "anthropic/claude-sonnet-5", tools: [], instructions: "t" }));
  serveOC(agent as never);
  await new Promise((r) => setTimeout(r, 250));

  const hz = (await (await fetch("http://127.0.0.1:18131/healthz")).json()) as { status: string; busy: boolean };
  expect(hz.status).toBe("ready");
  expect(hz.busy).toBe(false);

  const res = await fetch("http://127.0.0.1:18131/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contract_version: "1",
      turn_id: "T1", attempt: 1,
      input: [{ role: "user", content: "Say READY." }],
      config: {
        model: "anthropic/claude-sonnet-5", system_prompt: "t",
        mcp_endpoint: `http://127.0.0.1:${mcp}/mcp`, state_dir: stateDir, deadline_s: 120,
        endpoint_profile: { mode: "byo", auth_env: "TEST_KEY", base_url: `http://127.0.0.1:${model}` },
      },
    }),
  });
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { kind?: string; reason?: string; offset?: number });
  const done = lines[lines.length - 1];
  expect(done.kind).toBe("done");
  expect(done.reason).toBe("quiescent");
  expect(lines.map((l) => l.kind)).toContain("message_end");
  // init-time workspace probes went through the MCP host (the P0 mechanism, now healthy)
  expect((calls as Array<{ name: string }>).some((c) => c.name === "bash" || c.name === "ls")).toBe(true);
  // steps carry offsets for the driver's cursor (contract 7/12)
  expect(lines.filter((l) => l.kind !== "done").every((l) => typeof l.offset === "number")).toBe(true);
}, 60_000);
