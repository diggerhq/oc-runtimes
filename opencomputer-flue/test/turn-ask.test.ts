// §11.9 ask flow (S2/S3): the injected ask tool posts the question over MCP, persists the
// awaiting flag, aborts the run — the turn settles done{awaiting_input}, not error.
import { test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error mjs fixture
import { startMock } from "./fixtures/mock-model.mjs";
// @ts-expect-error mjs fixture
import { startFakeMcp, calls } from "./fixtures/fake-mcp.mjs";

test("ask → MCP ask call + persisted flag + done{awaiting_input}", async () => {
  process.env.MOCK_TOOL = "1";
  process.env.MOCK_TOOL_NAME = "ask";
  process.env.MOCK_TOOL_INPUT = JSON.stringify({ question: "Which region?" });
  const { port: model } = await startMock({});
  const { port: mcp } = await startFakeMcp();
  const stateDir = mkdtempSync(join(tmpdir(), "ocflue-ask-"));
  process.env.OC_RUNTIME_STATE_DIR = stateDir;
  process.env.OC_BRAIN_PORT = "18133";
  process.env.TEST_KEY = "k";

  const { defineAgent } = await import("@flue/runtime");
  const { serveOC } = await import("../dist/index.js");
  serveOC(defineAgent(() => ({ model: "anthropic/claude-sonnet-5", tools: [], instructions: "t" })) as never);
  await new Promise((r) => setTimeout(r, 250));

  const res = await fetch("http://127.0.0.1:18133/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contract_version: "1",
      turn_id: "TASK1", attempt: 1,
      input: [{ role: "user", content: "Ask me something." }],
      config: {
        model: "anthropic/claude-sonnet-5", system_prompt: "t",
        mcp_endpoint: `http://127.0.0.1:${mcp}/mcp`, state_dir: stateDir, deadline_s: 120,
        endpoint_profile: { mode: "byo", auth_env: "TEST_KEY", base_url: `http://127.0.0.1:${model}` },
      },
    }),
  });
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const done = lines[lines.length - 1];
  expect(done.kind).toBe("done");
  expect(done.reason).toBe("awaiting_input");
  expect(done.attach_mode).toBe("fresh");
  // the question actually went to the host (needs_input derivation lives there)
  expect((calls as Array<{ name: string }>).some((c) => c.name === "ask")).toBe(true);
  // flag consumed by THIS delivered done line — a later attach must not see it again
  const { PackageState } = await import("../dist/state.js");
  expect(new PackageState(stateDir).consumeAwaiting("TASK1")).toBe(false);
}, 60_000);

test("awaiting flag persists across PackageState instances (attempt death)", async () => {
  const { PackageState } = await import("../dist/state.js");
  const dir = mkdtempSync(join(tmpdir(), "ocflue-flag-"));
  new PackageState(dir).setAwaiting("T9");
  // a NEW instance over the same state dir (fresh process semantics) still sees it — once
  expect(new PackageState(dir).consumeAwaiting("T9")).toBe(true);
  expect(new PackageState(dir).consumeAwaiting("T9")).toBe(false);
});
