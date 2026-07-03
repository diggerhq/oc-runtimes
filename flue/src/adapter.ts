// The v3-flue ADAPTER — this runtime's RuntimeSpec on the shared adapter-core driver
// (design 011 §5.3, 012 §11.6). Unlike claude/codex/pi the brain is NOT baked into the
// image: the driver spawns dist/server.js (the launcher), which imports the user's
// materialized artifact whose entry calls @opencomputer/flue's serveOC (the brain).
//
// Flue's deltas from pi:
//   - skillsDir: null — flue does NOT use the OC skill-bundle mechanism. Its own skills ride
//     the artifact and are placed by the aggregated-skills-mount step (skills-mount.ts,
//     contracts 16+17), not by the driver's materializeSkills. Returning null makes
//     materializeSkills a no-op for this runtime.
//   - mcpTools: the codex-style subset {bash,read,write,ls,say,ask} — platform GitHub tools
//     (publish/watch/add_source) are NOT reachable for flue agents in v0 (012 §11.13, §6.2).
//   - busyPolicy: "reattach" — flue's engine is admit-and-detach, so a ready+busy brain at
//     turn start is a run in flight, NOT an orphan to reap; the R3 attach protocol governs
//     (012 §11.9). This field is a W2a adapter-core delta.
//   - sourcesNote: repos are checked out under /workspace/sources/<name>; v0 flue agents have
//     NO github_publish_pull_request tool, so the note does not reference it (contrast pi).

import { runAdapter, standardInputFilter, standardRenderInput, type RuntimeSpec } from "@oc/adapter-core";
import { translateFlueEvent } from "./translate.js";

// W2a: `busyPolicy` is not yet on adapter-core's RuntimeSpec (contract 13). Declare it here
// so the flue spec is authored against the frozen contract; the coordinator adds the field +
// its ensureBrain behavior to adapter-core/src/driver.ts. Passing extra props to
// runAdapter() is harmless at runtime (ignored until the driver reads it); typing the spec
// as a superset keeps this compile-clean without a cast.
type FlueRuntimeSpec = RuntimeSpec & { busyPolicy?: "kill" | "reattach" };

const spec: FlueRuntimeSpec = {
  name: "flue",
  defaultModel: "anthropic/claude-sonnet-5",

  isInputForModel: standardInputFilter,
  renderInput: standardRenderInput,

  // Checked-out-repos note. v0 flue has no publish tool (012 §11.13) — steer to the files,
  // do not reference a github_* tool the agent lacks.
  sourcesNote(): string {
    try {
      const s = JSON.parse(process.env.OC_SOURCES ?? "[]") as { name: string; repo: string; ref: string }[];
      if (!s.length) return "";
      const list = s.map((x) => `${x.name} (${x.repo}@${x.ref})`).join(", ");
      return `\n\nCHECKED-OUT REPOS in /workspace/sources: ${list}. Edit files there directly.`;
    } catch {
      return "";
    }
  },

  // Flue's skills ride the artifact + attached sources and are placed by skills-mount.ts, not
  // by the driver's skill-bundle materialization. null ⇒ materializeSkills is a no-op here.
  skillsDir: () => null,

  // The MCP host subset the flue brain (serveOC) is given (contract 9).
  mcpTools: ["bash", "read", "write", "ls", "say", "ask"],

  translate: translateFlueEvent,

  // W2a (contract 13): admit-and-detach ⇒ do not reap a ready+busy brain at turn start.
  busyPolicy: "reattach",
};

runAdapter(spec);
