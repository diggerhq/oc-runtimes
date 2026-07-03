// Build-time profile checks ride --describe (012 §11.2.3): the docs promise `sandbox:` set
// fails the DEPLOY, so the describe path must reject it — not the first turn.
import { test, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const madeDirs: string[] = [];
afterAll(() => { for (const d of madeDirs) rmSync(d, { recursive: true, force: true }); });

function describeAgent(agentBody: string): { status: number | null; out: string; stdout: string } {
  // Inside the package tree so the bare `@flue/runtime` specifier resolves up to our node_modules.
  const dir = mkdtempSync(join(PKG, "test", ".desc-"));
  madeDirs.push(dir);
  writeFileSync(
    join(dir, "app.mjs"),
    `import { defineAgent } from "@flue/runtime";\n` +
      `import { serveOC } from "../../dist/index.js";\n` +
      `serveOC(defineAgent(() => (${agentBody})));\n`,
  );
  const r = spawnSync(process.execPath, [join(dir, "app.mjs"), "--describe"], { encoding: "utf8", timeout: 30_000 });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "" };
}

test("--describe rejects a sandbox: setting (build-time, not first-turn)", () => {
  const r = describeAgent(`{ model: "anthropic/claude-sonnet-5", instructions: "t", sandbox: { kind: "local" } }`);
  expect(r.status).not.toBe(0);
  expect(r.out).toMatch(/sandbox.*must be unset/i);
});

test("--describe passes a conformant agent", () => {
  const r = describeAgent(`{ model: "anthropic/claude-sonnet-5", instructions: "t" }`);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}").model).toBe("anthropic/claude-sonnet-5");
});
