// Bundle materialization (design 009 §8.2 / agent-revisions-v1.md §9) — the box side.
//
// The session snapshot pins a bundle digest (skill_bundle_digest or the framework artifact
// digest); the adapter fetches the .tar.gz from the control plane (signed R2 URL) and
// materializes it into place before the brain starts. Content-addressing is the integrity
// anchor: the digest is sha256 of the .tar.gz BYTES, so we verify the downloaded bytes against
// the pin and REFUSE to materialize on mismatch — no fileset recomputation, no canonical-format
// coupling with the writer. Bundles are fixed for a session's life, so this runs once per box
// per digest.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, renameSync, readdirSync, readlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

/** The bundle content address: sha256 of the .tar.gz bytes (matches the CLI + host, which hash
 *  the same object). Standard blob digest — nothing language-specific to reproduce. */
export function bundleDigest(tarGz: Buffer): string {
  return "sha256:" + createHash("sha256").update(tarGz).digest("hex");
}

export interface MaterializeArgs {
  tarGz: Buffer;          // the downloaded .tar.gz
  expectedDigest: string; // the snapshot's pinned digest
  skillsRoot: string;     // holds versioned <digest>/ dirs + the symlink
  skillsDir: string;      // the symlink the brain reads (→ <digest>/)
}

/**
 * Verify + unpack + atomically swap the bundle dir to the requested digest. Verifies
 * sha256(tarGz) equals `expectedDigest` BEFORE unpacking (integrity), then extracts with the
 * system tar (standard tool — the digest already authenticated the bytes; tar refuses absolute
 * and parent-escaping paths, and skill filesets are path-validated at deploy). The swap is a
 * symlink rename. Returns whether the live target changed. Throws on mismatch — caller fails the turn.
 */
export function materializeBundle(a: MaterializeArgs): { changed: boolean } {
  const got = bundleDigest(a.tarGz);
  if (got !== a.expectedDigest) throw new Error(`bundle digest mismatch: got ${got} expected ${a.expectedDigest}`);

  const versionDir = join(a.skillsRoot, a.expectedDigest.replace(/[^a-zA-Z0-9:._-]/g, "_"));
  // Fresh unpack (idempotent: clear a partial prior attempt for this digest).
  rmSync(versionDir, { recursive: true, force: true });
  mkdirSync(versionDir, { recursive: true });
  execFileSync("tar", ["-xzf", "-", "-C", versionDir], { input: a.tarGz, stdio: ["pipe", "ignore", "pipe"] });

  const changed = !existsSync(a.skillsDir) || safeReadlink(a.skillsDir) !== versionDir;
  if (changed) swapSymlink(a.skillsRoot, a.skillsDir, versionDir);
  gcOtherVersions(a.skillsRoot, versionDir);
  return { changed };
}

/** Atomically repoint the bundle-dir symlink at `target` (rename can't clobber a non-empty dir). */
function swapSymlink(skillsRoot: string, skillsDir: string, target: string): void {
  mkdirSync(dirname(skillsDir), { recursive: true }); // the symlink's parent (e.g. <cwd>/.claude) must exist
  const next = join(skillsRoot, ".next");
  rmSync(next, { force: true });
  symlinkSync(target, next);
  renameSync(next, skillsDir); // atomic symlink replace
}

/** No bundle: point the dir at an empty versioned dir (so a prior session's files are gone). */
export function emptySkills(a: { skillsRoot: string; skillsDir: string }): { changed: boolean } {
  const emptyDir = join(a.skillsRoot, "_empty");
  mkdirSync(emptyDir, { recursive: true });
  const changed = !existsSync(a.skillsDir) || safeReadlink(a.skillsDir) !== emptyDir;
  if (changed) swapSymlink(a.skillsRoot, a.skillsDir, emptyDir);
  gcOtherVersions(a.skillsRoot, emptyDir);
  return { changed };
}

function safeReadlink(p: string): string | null {
  try { return readlinkSync(p); } catch { return null; }
}

/** Remove versioned dirs no longer pointed-to (keep `keep` + the symlink + .next scratch). */
function gcOtherVersions(skillsRoot: string, keep: string): void {
  let entries: string[];
  try { entries = readdirSync(skillsRoot); } catch { return; }
  const keepBase = keep.split("/").pop();
  for (const e of entries) {
    if (e === ".next" || e === keepBase) continue;
    const full = join(skillsRoot, e);
    if (full === keep) continue;
    try {
      const isLink = safeReadlink(full) !== null;
      if (isLink) continue;
      rmSync(full, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
}
