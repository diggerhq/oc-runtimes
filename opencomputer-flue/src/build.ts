#!/usr/bin/env node
// oc-flue-build — build the OpenComputer artifact for a Flue app (design 012 §11.5).
// Emits dist-oc/{oc.js, artifact.json, skills/**}. `oc agent deploy` runs this, hashes
// dist-oc/ (fileset digest, contract 4), uploads, and deploys. Build-time profile checks
// fail HERE with clear messages — never at turn time.

import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const PROFILE_VERSION = 1;
const RESERVED = new Set(["bash", "read", "write", "edit", "ls", "say", "ask"]);
const ENTRY_CANDIDATES = ["src/opencomputer.ts", "src/oc.ts", "oc.ts"];

function fail(msg: string): never {
  process.stderr.write(`oc-flue-build: ${msg}\n`);
  process.exit(1);
}

function findEntry(root: string, explicit?: string): string {
  if (explicit) {
    const p = resolve(root, explicit);
    if (!existsSync(p)) fail(`--entry ${explicit} not found`);
    return p;
  }
  for (const c of ENTRY_CANDIDATES) {
    const p = join(root, c);
    if (existsSync(p)) return p;
  }
  fail(`no entry found — expected one of: ${ENTRY_CANDIDATES.join(", ")} (see docs: agent-sessions/flue)`);
}

/** Packaged skill imports are a build error in profile v1 (012 §11.13). */
function rejectPackagedSkillImports(root: string): void {
  const srcRoot = existsSync(join(root, "src")) ? join(root, "src") : root;
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|mts|js|mjs|tsx)$/.test(ent.name)) files.push(p);
    }
  };
  walk(srcRoot);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (/with\s*\{\s*type\s*:\s*['"]skill['"]\s*\}/.test(text)) {
      fail(`packaged skill import in ${f} — not supported on OpenComputer yet; put skills in src/skills/<name>/SKILL.md instead`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const entryFlag = args.includes("--entry") ? args[args.indexOf("--entry") + 1] : undefined;
  const root = process.cwd();
  const outDir = join(root, "dist-oc");
  const entry = findEntry(root, entryFlag);
  rejectPackagedSkillImports(root);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // S5 HARD REQUIREMENT: the createRequire banner — without it the ESM bundle crashes on
  // first boot (`Dynamic require of "child_process"` via pi's transitive cross-spawn).
  const banner = [
    `import { createRequire as __ocCreateRequire } from 'node:module';`,
    `const require = __ocCreateRequire(import.meta.url);`,
  ].join("\n");

  await build({
    entryPoints: [entry],
    outfile: join(outDir, "oc.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: banner },
    logLevel: "warning",
  });

  // The app's own skills ride the artifact (contract 16).
  const skillsSrc = join(root, "src", "skills");
  if (existsSync(skillsSrc)) cpSync(skillsSrc, join(outDir, "skills"), { recursive: true });

  // --describe on the BUILT bundle: the deploy-triangle inputs come from what actually ships.
  const desc = spawnSync(process.execPath, [join(outDir, "oc.js"), "--describe"], { encoding: "utf8", timeout: 30_000 });
  if (desc.status !== 0) {
    fail(`the built bundle failed --describe (it would not boot on OpenComputer):\n${(desc.stderr || desc.stdout || "").slice(0, 800)}`);
  }
  let described: { model?: string | null; profile_version?: number; tools?: string[] };
  try {
    described = JSON.parse(desc.stdout.trim().split("\n").pop() ?? "{}") as never;
  } catch {
    fail(`--describe emitted unparseable output: ${desc.stdout.slice(0, 200)}`);
  }
  if (!described.model || !/^anthropic\//.test(described.model)) {
    fail(`model must be 'anthropic/<id>' — the built agent declares '${String(described.model)}'`);
  }
  for (const t of described.tools ?? []) {
    if (RESERVED.has(t)) fail(`custom tool name '${t}' is reserved (${[...RESERVED].join(", ")})`);
  }

  const appRequire = createRequire(join(root, "package.json"));
  let flueVersion = "unknown";
  try {
    flueVersion = (appRequire("@flue/runtime/package.json") as { version: string }).version;
  } catch { /* lockfile-less installs — recorded as unknown, deploy still validates the triangle */ }
  const self = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

  const manifest = {
    entry: "oc.js",
    profile_version: described.profile_version ?? PROFILE_VERSION,
    model: described.model,
    flue_version: flueVersion,
    oc_flue_version: self.version,
    node_range: ">=22.19",
  };
  writeFileSync(join(outDir, "artifact.json"), JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(`oc-flue-build: dist-oc ready (model ${manifest.model}, flue ${flueVersion})\n`);
}

void main();
