// Launcher tests (design 012 §11.6; contract 18 launcher-probe token, frozen by PR #57).
// Boot runs at module top level, so BOTH import and spawn trigger it — that is what the
// snapshot fork-verify probe relies on: it does `import(dist/server.js)` against an empty
// state dir and matches the rejection against /artifact/i. So the critical test (Test A) is
// an in-process import; the rest spawn a fresh process per scenario (fresh module cache +
// controlled env + a controlled artifact dir).
//
// Run: npx tsx test/launcher.test.ts

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let failed = 0;
const ok = (n: string, c: boolean, e = "") => { console.log(`${c ? "ok  " : "FAIL"} ${n}${c ? "" : "  <<< " + e}`); if (!c) failed++; };

const serverSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts");
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "flue-launch-"));

function mkArtifact(name: string, manifest: string | object | null, entry?: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "artifact"), { recursive: true });
  if (manifest !== null) {
    writeFileSync(join(dir, "artifact", "artifact.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  }
  if (entry !== undefined) writeFileSync(join(dir, "artifact", "oc.js"), entry);
  return dir;
}

/** Spawn `tsx src/server.ts` as a fresh process with OC_RUNTIME_STATE_DIR set. */
function spawnLauncher(stateDir: string): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync("npx", ["tsx", serverSrc], {
    cwd: pkgDir,
    env: { ...process.env, OC_RUNTIME_STATE_DIR: stateDir },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function run() {
  // ── Test A (CONTRACT 18, the literal probe): import server.ts against an empty state dir;
  //    the top-level boot must REJECT the import with an /artifact/i-matching message. ──
  {
    const emptyDir = join(root, "empty");
    mkdirSync(emptyDir, { recursive: true });
    process.env.OC_RUNTIME_STATE_DIR = emptyDir;
    let rejection: unknown;
    try {
      await import(pathToFileURL(serverSrc).href);
    } catch (e) {
      rejection = e;
    }
    const msg = rejection instanceof Error ? rejection.message : String(rejection);
    ok("contract 18: import() rejects when no artifact", rejection !== undefined, "import resolved — probe would see no failure");
    ok("contract 18: rejection message matches /artifact/i", /artifact/i.test(msg), msg);
  }

  // ── Spawn-based scenarios (fresh process each) ──
  {
    // Missing artifact → non-zero, /artifact/i in stderr.
    const dir = join(root, "no-artifact"); mkdirSync(dir, { recursive: true });
    const r = spawnLauncher(dir);
    ok("spawn: missing artifact → non-zero exit", r.code !== 0, `code=${r.code}`);
    ok("spawn: missing artifact → stderr matches /artifact/i", /artifact/i.test(r.stderr), r.stderr.slice(0, 200));
  }
  {
    // Manifest present + supported profile, but entry file absent → non-zero, /artifact/i.
    const dir = mkArtifact("no-entry", { entry: "oc.js", profile_version: 1 });
    const r = spawnLauncher(dir);
    ok("spawn: entry missing → non-zero exit", r.code !== 0, `code=${r.code}`);
    ok("spawn: entry missing → stderr matches /artifact/i", /artifact/i.test(r.stderr), r.stderr.slice(0, 200));
  }
  {
    // Unsupported profile_version → non-zero; names the version AND still contains "artifact".
    const dir = mkArtifact("bad-profile", { entry: "oc.js", profile_version: 2 });
    const r = spawnLauncher(dir);
    ok("spawn: unsupported profile_version → non-zero exit", r.code !== 0, `code=${r.code}`);
    ok("spawn: profile error names the version", /profile_version 2/.test(r.stderr), r.stderr.slice(0, 200));
    ok("spawn: profile error still contains 'artifact' (probe-safe)", /artifact/i.test(r.stderr), r.stderr.slice(0, 200));
  }
  {
    // Malformed artifact.json → non-zero, clear "artifact" in the message.
    const dir = mkArtifact("bad-json", "{ not json");
    const r = spawnLauncher(dir);
    ok("spawn: unreadable artifact.json → non-zero exit", r.code !== 0, `code=${r.code}`);
    ok("spawn: unreadable artifact.json → stderr matches /artifact/i", /artifact/i.test(r.stderr), r.stderr.slice(0, 200));
  }
  {
    // Conformant artifact whose entry is importable → boot resolves + imports it (entry runs).
    // The stand-in entry prints a marker and exits 0 (the real entry calls serveOC + binds).
    const dir = mkArtifact("good", { entry: "oc.js", profile_version: 1 }, "console.log('ENTRY_OK'); process.exit(0);\n");
    const r = spawnLauncher(dir);
    ok("spawn: conformant artifact → entry imported (exit 0)", r.code === 0, `code=${r.code} stderr=${r.stderr.slice(0, 200)}`);
    ok("spawn: conformant artifact → entry actually ran", r.stdout.includes("ENTRY_OK"), r.stdout.slice(0, 200));
  }

  rmSync(root, { recursive: true, force: true });
  console.log(failed ? `\n${failed} FAILED` : "\nall launcher tests passed");
  process.exit(failed ? 1 : 0);
}

run();
