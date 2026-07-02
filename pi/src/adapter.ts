// The v3-pi ADAPTER — this runtime's RuntimeSpec on the shared adapter-core driver
// (design 011 §5.3). Pi's deltas from claude: bare tool names in the sources note (pi
// tools are unprefixed), the agentskills.io skills layout computed under the brain cwd
// (the host's OC_SKILLS_DIR carries the claude layout — ignored here), and pi's native
// AgentSessionEvent translation (message_end + the server's synthetic result step).

import { runAdapter, standardInputFilter, standardRenderInput, type TranslateCtx, type DurableEmitter } from "@oc/adapter-core";
import { join } from "node:path";

runAdapter({
  name: "pi",
  defaultModel: "anthropic/claude-opus-4-8",

  isInputForModel: standardInputFilter,
  renderInput: standardRenderInput,

  // Same checked-out-repos note as claude, with pi's bare tool names.
  sourcesNote(): string {
    try {
      const s = JSON.parse(process.env.OC_SOURCES ?? "[]") as { name: string; repo: string; ref: string }[];
      if (!s.length) return "";
      const list = s.map((x) => `${x.name} (${x.repo}@${x.ref})`).join(", ");
      return (
        `\n\nCHECKED-OUT REPOS in /workspace/sources: ${list}. ` +
        "Edit files there directly; to open a pull request call github_publish_pull_request with the source name (never raw git)."
      );
    } catch {
      return "";
    }
  },

  // Pi discovers skills at <cwd>/.agents/skills (the agentskills.io standard); the host's
  // OC_SKILLS_DIR carries the CLAUDE layout, so this adapter computes its own target under
  // the brain cwd. The version root still comes from the host (OC_SKILLS_ROOT gates skills).
  skillsDir: (stateDir: string) => join(stateDir, "journal", ".agents", "skills"),

  // Native pi session event → OC taxonomy. The brain streams pi's AgentSessionEvents
  // verbatim plus ONE synthetic {kind:"result"} aggregated before the done line. Assistant
  // text becomes agent.message@progress (say/ask/tool events come from the MCP host).
  async translate(emitter: DurableEmitter, msg: any, ctx: TranslateCtx): Promise<void> {
    if (msg?.type === "message_end" && msg.message?.role === "assistant") {
      const content = Array.isArray(msg.message.content) ? msg.message.content : [];
      for (const block of content) {
        if (block?.type === "text" && block.text?.trim()) {
          ctx.noteAssistantText(block.text);
          await emitter.emit({ type: "agent.message", level: "progress", body: { text: block.text } });
        }
      }
    } else if (msg?.type === "result") {
      const u = msg.usage ?? {};
      await emitter.emit({
        type: "agent.result", level: "internal",
        body: {
          num_steps: msg.num_steps, model: ctx.model, is_error: Boolean(msg.is_error),
          duration_ms: msg.duration_ms,
          usage: {
            input_tokens: u.input, output_tokens: u.output,
            cache_creation_input_tokens: u.cacheWrite, cache_read_input_tokens: u.cacheRead,
          },
        },
      });
    }
  },
});
