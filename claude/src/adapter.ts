// The v3-claude ADAPTER — this runtime's RuntimeSpec on the shared adapter-core driver
// (design 011 §5.3; the driver was extracted FROM this file, conformance goldens prove
// byte-equivalence). Everything OC-shaped lives in @oc/adapter-core; this file owns only
// what makes claude claude: the Claude Agent SDK's native-step translation, the
// mcp__oc__-prefixed steering names, and the host-provided skills layout
// (<cwd>/.claude/skills via OC_SKILLS_DIR). Input filtering/rendering is the shared
// standard (user.message + github.* watch deliveries).

import {
  runAdapter, standardInputFilter, standardRenderInput,
} from "@oc/adapter-core";
import { createClaudeTranslator } from "./translate.js";

runAdapter({
  name: "claude",
  defaultModel: "anthropic/claude-opus-4-8",
  isInputForModel: standardInputFilter,
  renderInput: standardRenderInput,

  // Session-specific context injected ONLY when the session has checked-out repos (design 010 §2):
  // name them so the agent knows exactly what it can edit + publish (via the tool, never raw git).
  // turn.ts sets OC_SOURCES per turn, so this stays fresh (a mid-session add_source shows up next turn).
  sourcesNote(): string {
    try {
      const s = JSON.parse(process.env.OC_SOURCES ?? "[]") as { name: string; repo: string; ref: string }[];
      if (!s.length) return "";
      const list = s.map((x) => `${x.name} (${x.repo}@${x.ref})`).join(", ");
      return (
        `\n\nCHECKED-OUT REPOS in /workspace/sources: ${list}. ` +
        "Edit files there directly; to open a pull request call mcp__oc__github_publish_pull_request with the source name (never raw git)."
      );
    } catch {
      return "";
    }
  },

  // The host materializes into OC_SKILLS_DIR (<cwd>/.claude/skills) — the Claude Agent SDK
  // discovers skills there via settingSources:["project"]. Unset ⇒ skills-unaware image.
  skillsDir: () => process.env.OC_SKILLS_DIR || null,

  // Native Claude Agent SDK step → OC taxonomy. tool_use blocks (incl. say/ask) emit their
  // own events from the MCP host, not here.
  translate: createClaudeTranslator(),
});
