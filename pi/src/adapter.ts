// The v3-pi ADAPTER — this runtime's RuntimeSpec on the shared adapter-core driver
// (design 011 §5.3). Pi's deltas from claude: bare tool names in the sources note (pi
// tools are unprefixed), the agentskills.io skills layout computed under the brain cwd
// (the host's OC_SKILLS_DIR carries the claude layout — ignored here), and pi's native
// AgentSessionEvent translation (message_end + the server's synthetic result step).

import { runAdapter, textOf, type InEvent, type TranslateCtx, type DurableEmitter } from "@oc/adapter-core";
import { join } from "node:path";

/** Render a watch delivery (github.pr.*, design 010 §13) as a readable notification for the model
 *  — a concise, normalized summary (never the raw webhook), so the agent knows what happened and
 *  can react (or fetch more). */
function renderWatchEvent(type: string, body: any): string {
  const pr = body?.pr, url = body?.url;
  const head = `[PR #${pr} event] `;
  const why = body?.intent ? `\nYou are watching this PR to: ${body.intent}` : "";
  const msg = (() => {
    switch (type) {
      case "github.pr.comment":
        return `${head}New comment${body?.author ? ` by @${body.author}` : ""}:\n${body?.comment ?? ""}\n${body?.comment_url ?? url ?? ""}`;
      case "github.pr.checks_completed":
        return `${head}Checks ${body?.state}${Array.isArray(body?.failing) && body.failing.length ? ` — failing: ${body.failing.map((f: any) => f.name).join(", ")}` : ""}.\n${url ?? ""}`;
      case "github.pr.review_submitted":
        return `${head}A review was submitted${body?.by ? ` by @${body.by}` : ""}${body?.changes_requested ? " (changes requested)" : body?.approved ? " (approved)" : ""}.\n${url ?? ""}`;
      case "github.pr.merged": return `${head}The PR was merged.\n${url ?? ""}`;
      case "github.pr.closed": return `${head}The PR was closed.\n${url ?? ""}`;
      default: return `${head}${type}\n${url ?? ""}`;
    }
  })();
  return msg + why;
}

runAdapter({
  name: "pi",
  defaultModel: "anthropic/claude-opus-4-8",

  /** Human messages + watch deliveries. STRICT type allowlist — `agent.message` (the
   *  agent's own answers and asks) is ALSO user-level, so a ".message"-suffix match would
   *  re-feed the agent its own prior output as next-turn input. */
  isInputForModel(e: InEvent): boolean {
    return e.level === "user" && typeof e.type === "string" && (e.type === "user.message" || e.type.startsWith("github."));
  },
  renderInput(e: InEvent): string {
    return typeof e.type === "string" && e.type.startsWith("github.") ? renderWatchEvent(e.type, e.body) : textOf(e.body);
  },

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
