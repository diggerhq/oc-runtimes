// The aggregated skills mount (design 012 §11.2.4/§11.6, contracts 16+17). Flue discovers
// workspace skills at `${cwd}/.agents/skills` (flue context.ts:skillsDirIn), and this
// runtime pins cwd = /workspace (contract 17), so ONE mount at /workspace/.agents/skills is
// what the agent sees. This helper builds it from two populations:
//
//   1. the ARTIFACT's own skills — authored at src/skills/** and collected verbatim into the
//      bundle under skills/**; they live on the ADAPTER's local fs (<state_dir>/artifact/skills)
//      and must be PUSHED to the hands box (two-box topology).
//   2. each attached source's .agents/skills/** — already on the hands box under
//      /workspace/sources/<name> (that repo-level convention keeps its meaning: skills for
//      agents working ON that repo); copied within hands.
//
// Invariants (contracts 16+17):
//   - The APP (artifact) skill wins a name collision — the one collision point. We write the
//     artifact skills FIRST, then copy source skills with no-clobber (`cp -n`).
//   - Direct sandbox calls only — NO MCP tool events (this runs outside the model's tool loop;
//     an evented write here would pollute the OC log).
//   - NEVER write inside /workspace/sources/<repo> — only READ from it. So a later
//     publish_pull_request can never drag injected SKILL.mds into a user's PR.
//   - Marker-guarded (artifact digest + source set): rebuild only on a fresh hands box or a
//     change. Idempotent per box.
//
// Wiring: the flue RuntimeSpec's prepareWorkspace hook (adapter.ts) calls this. The driver
// (adapter-core) runs prepareWorkspace AFTER the brain/hands are up and the artifact is
// materialized, BEFORE POST /turn, and injects a HandsProxy backed by mcp-host's exported
// sandboxCall — the raw POST /v3/sessions/:id/sandbox/{op} path, NOT the MCP tools, so no
// tool.call/exec.completed events are emitted.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, posix } from "node:path";

/** The mount dir the agent sees — flue resolves `${cwd}/.agents/skills` with cwd = /workspace. */
export const MOUNT_DIR = "/workspace/.agents/skills";
const MARKER_PATH = posix.join(MOUNT_DIR, ".oc-mount");
const SOURCES_ROOT = "/workspace/sources";

/** Minimal hands surface (the driver's sandboxCall proxy, key ops only). Errors ride {error}. */
export interface HandsSandbox {
  exec(command: string): Promise<{ exitCode?: number; stdout?: string; stderr?: string; error?: string }>;
  write(path: string, content: string): Promise<{ error?: string }>;
  read(path: string): Promise<{ content?: string; error?: string }>;
}

/** Stable marker over the artifact digest + the sorted source-name set (contract: rebuild on change). */
export function computeMountMarker(artifactDigest: string, sourceNames: readonly string[]): string {
  const h = createHash("sha256");
  h.update(artifactDigest);
  h.update("\0");
  h.update([...sourceNames].sort().join(","));
  return "flue-skills-mount:" + h.digest("hex").slice(0, 16);
}

/** Recursively list regular files under a local dir as POSIX-relative paths (artifact skills). */
function listLocalFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const ent of readdirSync(root, { recursive: true, withFileTypes: true }) as Array<{ name: string; parentPath?: string; path?: string; isFile(): boolean }>) {
    if (!ent.isFile()) continue;
    // node's recursive Dirent carries parentPath (>=20.12); path is the older alias.
    const parent = ent.parentPath ?? ent.path ?? root;
    const abs = join(parent, ent.name);
    out.push(posix.normalize(abs.slice(root.length).replace(/^[/\\]/, "").split(/[/\\]/).join("/")));
  }
  return out;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export interface BuildSkillsMountOpts {
  /** Local fs path to the artifact's skills dir, e.g. <state_dir>/artifact/skills. */
  artifactSkillsDir: string;
  /** Attached sources (from OC_SOURCES); only `name` is used (their checkout dir). */
  sources: ReadonlyArray<{ name: string }>;
  /** The hands proxy. */
  sandbox: HandsSandbox;
  /** Marker value from computeMountMarker(artifactDigest, sourceNames). */
  markerValue: string;
}

export interface BuildSkillsMountResult {
  /** true = mount (re)built this call; false = marker matched, nothing to do. */
  mounted: boolean;
  /** files pushed from the artifact. */
  artifactFilesWritten: number;
  /** sources whose .agents/skills/** were copied in. */
  sourcesCopied: string[];
}

/**
 * Build /workspace/.agents/skills from the artifact's skills plus each source's
 * .agents/skills, app wins collisions. Marker-guarded and idempotent. Throws only on a hard
 * sandbox failure (the caller fails the turn, mirroring materializeSkills).
 */
export async function buildSkillsMount(opts: BuildSkillsMountOpts): Promise<BuildSkillsMountResult> {
  const { sandbox, markerValue } = opts;

  // Marker check: same box + same {digest, source set} ⇒ already mounted.
  const existing = await sandbox.read(MARKER_PATH);
  if (!existing.error && (existing.content ?? "").trim() === markerValue) {
    return { mounted: false, artifactFilesWritten: 0, sourcesCopied: [] };
  }

  // Fresh build. rm -rf ONLY the mount dir (never sources/), then recreate. A digest/source
  // change must not leave stale skills behind.
  const reset = await sandbox.exec(`rm -rf ${shellQuote(MOUNT_DIR)} && mkdir -p ${shellQuote(MOUNT_DIR)}`);
  if (reset.error) throw new Error(`skills mount reset failed: ${reset.error}`);

  // 1) Artifact skills FIRST (app wins). Pushed adapter→hands via write (creates parents).
  const files = listLocalFiles(opts.artifactSkillsDir);
  for (const rel of files) {
    const content = readFileSync(join(opts.artifactSkillsDir, rel), "utf8");
    const w = await sandbox.write(posix.join(MOUNT_DIR, rel), content);
    if (w.error) throw new Error(`skills mount write ${rel} failed: ${w.error}`);
  }

  // 2) Each source's .agents/skills/** copied in with NO-CLOBBER so the app skills stay
  //    authoritative. Read-only w.r.t. sources/<name>; writes land only in MOUNT_DIR.
  const sourcesCopied: string[] = [];
  for (const src of opts.sources) {
    const srcSkills = posix.join(SOURCES_ROOT, src.name, ".agents", "skills");
    // `cp -Rn <src>/. <dst>/` merges without clobbering existing (app) files; the `[ -d ]`
    // guard keeps a source without skills a clean no-op.
    const cp = await sandbox.exec(`[ -d ${shellQuote(srcSkills)} ] && cp -Rn ${shellQuote(srcSkills + "/.")} ${shellQuote(MOUNT_DIR + "/")} || true`);
    if (cp.error) throw new Error(`skills mount copy from source ${src.name} failed: ${cp.error}`);
    sourcesCopied.push(src.name);
  }

  const marker = await sandbox.write(MARKER_PATH, markerValue);
  if (marker.error) throw new Error(`skills mount marker write failed: ${marker.error}`);

  return { mounted: true, artifactFilesWritten: files.length, sourcesCopied };
}
