// Skill materialization (design 009 §8.2 / agent-revisions-v1.md §9) — the box side.
//
// The session snapshot pins skill_bundle_digest; the adapter fetches the canonical tar.gz from
// the control plane (signed R2 URL) and materializes it into OC_SKILLS_DIR before the brain
// starts. Content-addressing is the integrity anchor: we recompute the fileset digest from the
// unpacked entries and REFUSE to materialize on mismatch. Skills are fixed for a session's life
// (the digest never changes mid-session), so this runs once per box per digest.
//
// The fileset digest + canonical-tar format MUST match the writer in
// sessions-api/src/v3/core/skill-bundle-store.ts (deliberate cross-deployment-unit duplication —
// the runtime image is built + shipped separately). Keep the two in lockstep.

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync, renameSync, readdirSync, readlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

export interface UnpackedFile { path: string; mode: number; content: Buffer; }

/** The fileset digest: sha256 over the bytewise-sorted fixed-order {path,mode,sha256} entries. */
export function computeFilesetDigest(files: Array<{ path: string; mode: number; content: Buffer }>): string {
  const entries = files
    .map((f) => ({ path: f.path, mode: f.mode, sha256: createHash("sha256").update(f.content).digest("hex") }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  return "sha256:" + createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
}

/** Parse a (gunzipped) POSIX ustar tar buffer into regular-file entries. */
export function parseTar(tar: Buffer): UnpackedFile[] {
  const readStr = (o: number, len: number) => {
    const s = tar.subarray(o, o + len);
    const nul = s.indexOf(0);
    return s.subarray(0, nul < 0 ? len : nul).toString("ascii");
  };
  const out: UnpackedFile[] = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive
    const name = readStr(off + 0, 100);
    const prefix = readStr(off + 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const mode = parseInt(readStr(off + 100, 8).trim() || "0", 8) & 0o7777;
    const size = parseInt(readStr(off + 124, 12).trim() || "0", 8);
    const typeflag = tar[off + 156];
    off += 512;
    if (typeflag === 0x30 /* '0' */ || typeflag === 0x00 /* legacy regular */) {
      out.push({ path, mode, content: Buffer.from(tar.subarray(off, off + size)) });
    }
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Reject a path that could escape the skills root (defense-in-depth over the deploy-time check). */
function assertSafePath(p: string): void {
  if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\\") || /\0/.test(p)) throw new Error(`unsafe skill path: '${p}'`);
  if (p.split("/").some((seg) => seg === ".." || seg === ".")) throw new Error(`skill path traversal: '${p}'`);
}

export interface MaterializeArgs {
  tarGz: Buffer;        // the downloaded canonical tar.gz
  expectedDigest: string; // the snapshot's skill_bundle_digest
  skillsRoot: string;   // holds versioned <digest>/ dirs + the symlink
  skillsDir: string;    // the symlink Claude Code reads (→ <digest>/)
}

/**
 * Unpack + verify + atomically swap the skills dir to the requested digest. Verifies the unpacked
 * fileset digest equals `expectedDigest` BEFORE swapping (integrity). The swap is a symlink
 * rename (you can't rename over a non-empty dir). Returns whether the live target changed.
 * Throws on mismatch / unsafe path — the caller fails the turn.
 */
export function materializeBundle(a: MaterializeArgs): { changed: boolean } {
  const tar = gunzipSync(a.tarGz);
  const files = parseTar(tar);
  const got = computeFilesetDigest(files);
  if (got !== a.expectedDigest) throw new Error(`skill bundle digest mismatch: got ${got} expected ${a.expectedDigest}`);

  const versionDir = join(a.skillsRoot, a.expectedDigest.replace(/[^a-zA-Z0-9:._-]/g, "_"));
  // Fresh unpack (idempotent: clear a partial prior attempt for this digest).
  rmSync(versionDir, { recursive: true, force: true });
  mkdirSync(versionDir, { recursive: true });
  for (const f of files) {
    assertSafePath(f.path);
    const dest = join(versionDir, f.path);
    if (!dest.startsWith(versionDir + "/") && dest !== versionDir) throw new Error(`skill path escapes root: '${f.path}'`);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, f.content);
    chmodSync(dest, f.mode === 0o755 ? 0o755 : 0o644);
  }

  const changed = !existsSync(a.skillsDir) || safeReadlink(a.skillsDir) !== versionDir;
  if (changed) swapSymlink(a.skillsRoot, a.skillsDir, versionDir);
  gcOtherVersions(a.skillsRoot, versionDir);
  return { changed };
}

/** Atomically repoint the skills-dir symlink at `target` (rename can't clobber a non-empty dir). */
function swapSymlink(skillsRoot: string, skillsDir: string, target: string): void {
  mkdirSync(dirname(skillsDir), { recursive: true }); // OC_SKILLS_DIR's parent (e.g. <cwd>/.claude) must exist
  const next = join(skillsRoot, ".next");
  rmSync(next, { force: true });
  symlinkSync(target, next);
  renameSync(next, skillsDir); // atomic symlink replace
}

/** No skills: point the skills dir at an empty versioned dir (so a prior session's skills are gone). */
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
    // Don't remove the live symlink file itself (it's a symlink, not a version dir).
    if (full === keep) continue;
    try {
      const isLink = safeReadlink(full) !== null;
      if (isLink) continue;
      rmSync(full, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
}
