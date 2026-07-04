// Materialization test (blob digest + system-tar extract). Builds a .tar.gz with the system
// tar — a standard producer, exactly what the CLI / host emit — then drives materializeBundle
// end to end: happy path, idempotent re-materialize, digest-mismatch rejection, emptySkills.
// Run: npx -y tsx test-materialize.ts

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { materializeBundle, emptySkills, bundleDigest } from "./src/skills.js";

let failed = 0;
const check = (cond: boolean, msg: string) => { if (!cond) { console.error("FAIL:", msg); failed++; } };

// Build a bundle .tar.gz with the system tar.
const src = mkdtempSync(join(tmpdir(), "mat-src-"));
mkdirSync(join(src, "triage"), { recursive: true });
writeFileSync(join(src, "triage", "SKILL.md"), "---\nname: triage\n---\nhello\n");
writeFileSync(join(src, "run.sh"), "#!/bin/sh\necho hi\n");
chmodSync(join(src, "run.sh"), 0o755);
const tarGz = execFileSync("tar", ["-czf", "-", "-C", src, "triage", "run.sh"]);

const digest = bundleDigest(tarGz);
check(digest === "sha256:" + createHash("sha256").update(tarGz).digest("hex"), "digest is sha256 of the blob");

const root = mkdtempSync(join(tmpdir(), "mat-root-"));
const linkParent = mkdtempSync(join(tmpdir(), "mat-link-")); // the symlink lives OUTSIDE the version root
const dir = join(linkParent, ".claude", "live");

// Happy path: symlink points at the version dir, files present.
const r1 = materializeBundle({ tarGz, expectedDigest: digest, skillsRoot: root, skillsDir: dir });
check(r1.changed === true, "first materialize reports changed");
const live = readlinkSync(dir);
check(readFileSync(join(live, "triage", "SKILL.md"), "utf8").includes("triage"), "SKILL.md materialized");
check(existsSync(join(live, "run.sh")), "run.sh materialized");

// Idempotent: same digest again → no change.
const r2 = materializeBundle({ tarGz, expectedDigest: digest, skillsRoot: root, skillsDir: dir });
check(r2.changed === false, "re-materialize same digest is a no-op");

// Tamper: wrong digest throws BEFORE any unpack.
let threw = false;
try { materializeBundle({ tarGz, expectedDigest: "sha256:" + "0".repeat(64), skillsRoot: root, skillsDir: dir }); }
catch { threw = true; }
check(threw, "digest mismatch throws");

// emptySkills repoints at an empty dir.
const r3 = emptySkills({ skillsRoot: root, skillsDir: dir });
check(r3.changed === true, "emptySkills changes the target");

rmSync(src, { recursive: true, force: true });
rmSync(root, { recursive: true, force: true });
rmSync(linkParent, { recursive: true, force: true });
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("materialize: all checks passed");
