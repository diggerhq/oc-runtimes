// FS unit test for the box-side skill materialization (runtimes/v3-claude/src/skills.ts), driven
// by the REAL writer (src/v3/core/skill-bundle-store.ts) — proves the writer ↔ parser/digest are
// byte-compatible across the two deployment units. Run: npx tsx scripts/v3-skills-materialize-unit.ts
import { mkdtempSync, rmSync, readFileSync, statSync, readlinkSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCanonicalTarGz, computeFilesetDigest as writerDigest } from "../src/v3/core/skill-bundle-store.js";
import { materializeBundle, emptySkills, parseTar, computeFilesetDigest as boxDigest } from "./src/skills.js";
import { gunzipSync } from "node:zlib";

let failed = 0;
const ok = (n: string, c: boolean, e = "") => { console.log(`${c ? "ok  " : "FAIL"} ${n}${c ? "" : "  <<< " + e}`); if (!c) failed++; };

const root = mkdtempSync(join(tmpdir(), "oc-skills-"));
const skillsRoot = join(root, "skills-versions");
const skillsDir = join(root, "journal/.claude/skills");

try {
  const files = [
    { path: "triage/SKILL.md", content: "# Triage\nMarker: ZX42\n", mode: 0o644 },
    { path: "triage/run.sh", content: "#!/bin/sh\necho ZX42\n", mode: 0o755 },
  ];
  const tgz = buildCanonicalTarGz(files);
  // Writer digest (sessions-api) must equal the box digest over the parsed entries (runtime pkg).
  const wDig = writerDigest(files);
  const parsed = parseTar(gunzipSync(tgz));
  ok("writer digest == box digest (cross-unit compatible)", wDig === boxDigest(parsed), `${wDig} vs ${boxDigest(parsed)}`);

  // Materialize.
  const m1 = materializeBundle({ tarGz: tgz, expectedDigest: wDig, skillsRoot, skillsDir });
  ok("first materialize → changed", m1.changed);
  ok("skillsDir is a symlink", readlinkSync(skillsDir).length > 0);
  ok("SKILL.md materialized with content", readFileSync(join(skillsDir, "triage/SKILL.md"), "utf8").includes("Marker: ZX42"));
  ok("run.sh mode 0755", (statSync(join(skillsDir, "triage/run.sh")).mode & 0o777) === 0o755);
  ok("SKILL.md mode 0644", (statSync(join(skillsDir, "triage/SKILL.md")).mode & 0o777) === 0o644);

  // Idempotent re-materialize (same digest) → no symlink change.
  const m2 = materializeBundle({ tarGz: tgz, expectedDigest: wDig, skillsRoot, skillsDir });
  ok("re-materialize same digest → unchanged", !m2.changed);

  // Tamper: wrong expected digest → throws (integrity).
  let tampered = false;
  try { materializeBundle({ tarGz: tgz, expectedDigest: "sha256:deadbeef", skillsRoot, skillsDir }); }
  catch { tampered = true; }
  ok("digest mismatch rejected", tampered);

  // New bundle (different content) → new digest → changed, old version GC'd.
  const files2 = [{ path: "review/SKILL.md", content: "# Review\n", mode: 0o644 }];
  const tgz2 = buildCanonicalTarGz(files2);
  const dig2 = writerDigest(files2);
  const m3 = materializeBundle({ tarGz: tgz2, expectedDigest: dig2, skillsRoot, skillsDir });
  ok("new digest → changed", m3.changed);
  ok("new content present", existsSync(join(skillsDir, "review/SKILL.md")));
  ok("old content gone (symlink repointed)", !existsSync(join(skillsDir, "triage/SKILL.md")));
  const verDirs = readdirSync(skillsRoot).filter((e) => e.startsWith("sha256"));
  ok("old version dir GC'd (only current kept)", verDirs.length === 1, verDirs.join(","));

  // No skills → empty dir.
  const me = emptySkills({ skillsRoot, skillsDir });
  ok("emptySkills → changed", me.changed);
  ok("skills dir now empty", readdirSync(skillsDir).length === 0);
} catch (e) {
  console.error("ERROR:", e instanceof Error ? e.stack : e);
  failed++;
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${failed === 0 ? "PASS" : "FAIL (" + failed + ")"}`);
process.exit(failed === 0 ? 0 : 1);
