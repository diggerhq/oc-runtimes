// Launcher tests (design 012 §11.6, fork-verify sentinel §11.7.5 / W3.5). Importing
// server.js must be side-effect-free (main-module guard); bootFlueBrain() must reject with
// ArtifactMissingError when no artifact is materialized (the fork-verify probe), accept a
// conformant profile_version, and reject an unsupported one.
//
// Run: npx tsx test/launcher.test.ts

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootFlueBrain, ArtifactMissingError } from "../src/server.js";

let failed = 0;
const ok = (n: string, c: boolean, e = "") => { console.log(`${c ? "ok  " : "FAIL"} ${n}${c ? "" : "  <<< " + e}`); if (!c) failed++; };

const root = mkdtempSync(join(tmpdir(), "flue-launch-"));

async function bootIn(dir: string): Promise<unknown> {
  process.env.OC_RUNTIME_STATE_DIR = dir;
  try { await bootFlueBrain(); return null; } catch (e) { return e; }
}

async function run() {
  // 1. No artifact at all → ArtifactMissingError (the fork-verify sentinel).
  {
    const dir = join(root, "no-artifact");
    mkdirSync(dir, { recursive: true });
    const err = await bootIn(dir);
    ok("no artifact → ArtifactMissingError", err instanceof ArtifactMissingError, String(err));
    ok("error carries code artifact_missing", (err as ArtifactMissingError)?.code === "artifact_missing");
  }

  // 2. Manifest present, profile_version supported, but entry file missing → ArtifactMissingError.
  {
    const dir = join(root, "no-entry");
    mkdirSync(join(dir, "artifact"), { recursive: true });
    writeFileSync(join(dir, "artifact", "artifact.json"), JSON.stringify({ entry: "oc.js", profile_version: 1 }));
    const err = await bootIn(dir);
    ok("manifest ok but entry missing → ArtifactMissingError", err instanceof ArtifactMissingError, String(err));
  }

  // 3. Unsupported profile_version → Error (NOT ArtifactMissingError) — deploy should have caught it.
  {
    const dir = join(root, "bad-profile");
    mkdirSync(join(dir, "artifact"), { recursive: true });
    writeFileSync(join(dir, "artifact", "artifact.json"), JSON.stringify({ entry: "oc.js", profile_version: 2 }));
    const err = await bootIn(dir);
    ok("unsupported profile_version → Error", err instanceof Error && !(err instanceof ArtifactMissingError), String(err));
    ok("profile error message names the version", /profile_version 2/.test((err as Error)?.message ?? ""));
  }

  // 4. Conformant artifact whose entry is importable → bootFlueBrain imports it (entry runs).
  {
    const dir = join(root, "good");
    mkdirSync(join(dir, "artifact"), { recursive: true });
    writeFileSync(join(dir, "artifact", "artifact.json"), JSON.stringify({ entry: "oc.js", profile_version: 1 }));
    // A stand-in entry: sets a global marker instead of really binding a port (the real entry
    // calls serveOC). Proves resolve → import happens on the happy path.
    writeFileSync(join(dir, "artifact", "oc.js"), "globalThis.__flueEntryImported = true;\n");
    const err = await bootIn(dir);
    ok("conformant artifact → entry imported, no throw", err === null && (globalThis as any).__flueEntryImported === true, String(err));
  }

  // 5. Malformed artifact.json → a clear Error (not a silent success).
  {
    const dir = join(root, "bad-json");
    mkdirSync(join(dir, "artifact"), { recursive: true });
    writeFileSync(join(dir, "artifact", "artifact.json"), "{ not json");
    const err = await bootIn(dir);
    ok("unreadable artifact.json → Error", err instanceof Error, String(err));
  }

  rmSync(root, { recursive: true, force: true });
  console.log(failed ? `\n${failed} FAILED` : "\nall launcher tests passed");
  process.exit(failed ? 1 : 0);
}

run();
