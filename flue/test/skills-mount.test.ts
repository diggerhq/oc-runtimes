// Unit tests for the aggregated skills mount (design 012 §11.2.4/§11.6, contracts 16+17).
// A fake HandsSandbox records every op so we can assert: app-wins-collision ordering, no
// writes into sources/<repo>, marker-guarded idempotency, and the fresh-build reset.
//
// Run: npx tsx test/skills-mount.test.ts

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillsMount, computeMountMarker, MOUNT_DIR, type HandsSandbox } from "../src/skills-mount.js";

let failed = 0;
const ok = (n: string, c: boolean, e = "") => { console.log(`${c ? "ok  " : "FAIL"} ${n}${c ? "" : "  <<< " + e}`); if (!c) failed++; };

interface Op { op: "exec" | "write" | "read"; arg: string }

// The mount now pushes skill files as RAW BYTES via base64-over-exec (#13), not sandbox.write
// (which is utf8-only and used only for the marker). The fake emulates the exact command set
// buildSkillsMount emits so `files` reflects what actually lands on the hands box:
//   rm -rf 'M' && mkdir -p 'M'                      → clear the M/ prefix
//   mkdir -p 'D' && : > 'P.b64'                     → start a base64 accumulator for P
//   printf %s 'CHUNK' >> 'P.b64'                    → append a chunk
//   base64 -d 'P.b64' > 'P' && rm -f 'P.b64' && …   → decode into P (the real file content)
//   [ -d 'S' ] && cp -Rpn 'S/.' 'M/' || true        → source copy (no-clobber, mode-preserving)
function fakeSandbox(seed: Record<string, string> = {}): { sandbox: HandsSandbox; ops: Op[]; files: Record<string, string> } {
  const ops: Op[] = [];
  const files: Record<string, string> = { ...seed };
  const b64: Record<string, string> = {};
  const q = (cmd: string): string[] => Array.from(cmd.matchAll(/'((?:[^']|'\\'')*)'/g)).map((m) => m[1].replace(/'\\''/g, "'"));
  const sandbox: HandsSandbox = {
    async exec(command: string) {
      ops.push({ op: "exec", arg: command });
      const args = q(command);
      if (/^rm -rf /.test(command)) { const pfx = args[0]; for (const k of Object.keys(files)) if (k === pfx || k.startsWith(pfx + "/")) delete files[k]; }
      else if (/: > /.test(command)) { b64[args[args.length - 1]] = ""; }
      else if (/^printf %s /.test(command)) { const dst = args[args.length - 1]; b64[dst] = (b64[dst] ?? "") + args[0]; }
      else if (/^base64 -d /.test(command)) { const src = args[0], dst = args[1]; files[dst] = Buffer.from(b64[src] ?? "", "base64").toString("utf8"); delete b64[src]; }
      // cp -Rpn from a (nonexistent-in-fake) source dir is a no-op on `files`; the ops record proves it ran.
      return { exitCode: 0, stdout: "" };
    },
    async write(path: string, content: string) { ops.push({ op: "write", arg: path }); files[path] = content; return {}; },
    async read(path: string) { ops.push({ op: "read", arg: path }); return path in files ? { content: files[path] } : { error: "not found" }; },
  };
  return { sandbox, ops, files };
}

const root = mkdtempSync(join(tmpdir(), "flue-mount-"));

async function run() {
  // Local artifact skills fixture: two files under a skill dir.
  const artifactSkillsDir = join(root, "artifact", "skills");
  mkdirSync(join(artifactSkillsDir, "triage"), { recursive: true });
  writeFileSync(join(artifactSkillsDir, "triage", "SKILL.md"), "# Triage (app)\n");
  writeFileSync(join(artifactSkillsDir, "triage", "helper.txt"), "app-helper\n");

  const marker = computeMountMarker("sha256:abc", ["repo"]);

  // 1. Fresh build: reset, artifact files pushed, source copied, marker written.
  {
    const { sandbox, ops, files } = fakeSandbox();
    const res = await buildSkillsMount({ artifactSkillsDir, sources: [{ name: "repo" }], sandbox, markerValue: marker });
    ok("fresh build → mounted", res.mounted && res.artifactFilesWritten === 2 && res.sourcesCopied.length === 1, JSON.stringify(res));

    const resetIdx = ops.findIndex((o) => o.op === "exec" && o.arg.includes("rm -rf") && o.arg.includes(MOUNT_DIR));
    ok("resets ONLY the mount dir before building", resetIdx === 1, JSON.stringify(ops[resetIdx])); // after the initial marker read

    // Skill files land as RAW bytes (base64-over-exec), decoded into MOUNT_DIR — assert on the
    // reconstructed file tree, not on write ops (only the marker uses write now).
    ok("artifact SKILL.md pushed under mount dir", files[join(MOUNT_DIR, "triage/SKILL.md")] === "# Triage (app)\n", JSON.stringify(Object.keys(files)));
    ok("artifact helper.txt pushed under mount dir", files[join(MOUNT_DIR, "triage/helper.txt")] === "app-helper\n");

    // App writes happen BEFORE the source cp (app wins collisions). The artifact "write" is the
    // `base64 -d … > MOUNT/…` decode exec; the source copy is the `cp -Rpn` exec.
    const lastArtifactWrite = ops.map((o) => o.op === "exec" && /^base64 -d /.test(o.arg) && o.arg.includes(MOUNT_DIR)).lastIndexOf(true);
    const srcCp = ops.findIndex((o) => o.op === "exec" && o.arg.includes("/workspace/sources/repo/.agents/skills"));
    ok("artifact writes precede source copy (app wins)", lastArtifactWrite >= 0 && lastArtifactWrite < srcCp, `artifactWrite@${lastArtifactWrite} cp@${srcCp}`);
    ok("source copy uses no-clobber + mode-preserve (cp -Rpn)", ops[srcCp]?.arg.includes("cp -Rpn"), ops[srcCp]?.arg);

    // NEVER write inside sources/<repo>: no write/decode op targets it; the cp DESTINATION is
    // always the mount dir (sources appear only as the read-only cp source `<src>/.agents/skills/.`).
    const wroteIntoSource = ops.some((o) => (o.op === "write" || (o.op === "exec" && /^base64 -d /.test(o.arg))) && o.arg.includes("/workspace/sources/"));
    const cpDestNotMount = ops.some((o) => o.op === "exec" && o.arg.includes("cp -Rpn") && !o.arg.includes(`${MOUNT_DIR}/'`));
    ok("never writes into sources/<repo>",
      !wroteIntoSource && !cpDestNotMount && !Object.keys(files).some((f) => f.startsWith("/workspace/sources/")),
      JSON.stringify({ ops: ops.map((o) => o.arg), files: Object.keys(files) }));

    ok("marker written last with the marker value", files[join(MOUNT_DIR, ".oc-mount")] === marker);
  }

  // 2. Idempotent: marker already matches → nothing happens (no exec/write).
  {
    const { sandbox, ops } = fakeSandbox({ [join(MOUNT_DIR, ".oc-mount")]: marker });
    const res = await buildSkillsMount({ artifactSkillsDir, sources: [{ name: "repo" }], sandbox, markerValue: marker });
    ok("marker match → not mounted", !res.mounted, JSON.stringify(res));
    ok("marker match → only the marker read, no writes/execs", ops.length === 1 && ops[0].op === "read", JSON.stringify(ops));
  }

  // 3. Marker changes when the source set changes → rebuild.
  {
    const marker2 = computeMountMarker("sha256:abc", ["repo", "other"]);
    ok("different source set → different marker", marker !== marker2);
    const { sandbox, ops } = fakeSandbox({ [join(MOUNT_DIR, ".oc-mount")]: marker });
    const res = await buildSkillsMount({ artifactSkillsDir, sources: [{ name: "repo" }, { name: "other" }], sandbox, markerValue: marker2 });
    ok("stale marker → rebuild", res.mounted && ops.some((o) => o.op === "exec" && o.arg.includes("rm -rf")));
  }

  // 4. No sources → app skills only, still a clean mount.
  {
    const { sandbox, files } = fakeSandbox();
    const res = await buildSkillsMount({ artifactSkillsDir, sources: [], sandbox, markerValue: computeMountMarker("sha256:abc", []) });
    ok("no sources → app skills mounted", res.mounted && res.sourcesCopied.length === 0 && files[join(MOUNT_DIR, "triage/SKILL.md")] === "# Triage (app)\n");
  }

  // 5. Empty artifact skills dir → clean no-op build (marker still written).
  {
    const empty = join(root, "empty-skills");
    mkdirSync(empty, { recursive: true });
    const { sandbox, files } = fakeSandbox();
    const res = await buildSkillsMount({ artifactSkillsDir: empty, sources: [], sandbox, markerValue: "m" });
    ok("empty artifact skills → 0 files, marker written", res.mounted && res.artifactFilesWritten === 0 && files[join(MOUNT_DIR, ".oc-mount")] === "m");
  }

  rmSync(root, { recursive: true, force: true });
  console.log(failed ? `\n${failed} FAILED` : "\nall skills-mount tests passed");
  process.exit(failed ? 1 : 0);
}

run();
