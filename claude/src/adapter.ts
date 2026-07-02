// The v3-claude ADAPTER — this runtime's RuntimeSpec on the shared adapter-core driver
// (design 011 §5.3; the driver was extracted FROM this file, conformance goldens prove
// byte-equivalence). Everything OC-shaped lives in @oc/adapter-core; this file owns only
// what makes claude claude: which events are model input and how watch deliveries render,
// the Claude Agent SDK's native-step translation, the mcp__oc__-prefixed steering names,
// and the host-provided skills layout (<cwd>/.claude/skills via OC_SKILLS_DIR).

import { runAdapter, textOf, type InEvent, type TranslateCtx, type DurableEmitter } from "@oc/adapter-core";

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
  name: "claude",
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
  async translate(emitter: DurableEmitter, msg: any, ctx: TranslateCtx): Promise<void> {
    if (msg?.type === "assistant") {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
          ctx.noteAssistantText(block.text);
          await emitter.emit({ type: "agent.message", level: "progress", body: { text: block.text } });
        }
      }
    } else if (msg?.type === "result") {
      const u = msg.usage ?? {};
      await emitter.emit({
        type: "agent.result", level: "internal",
        body: {
          subtype: msg.subtype, num_turns: msg.num_turns, model: ctx.model.replace(/^anthropic\//, ""), is_error: msg.is_error,
          duration_ms: msg.duration_ms, duration_api_ms: msg.duration_api_ms, total_cost_usd: msg.total_cost_usd,
          usage: {
            input_tokens: u.input_tokens, output_tokens: u.output_tokens,
            cache_creation_input_tokens: u.cache_creation_input_tokens, cache_read_input_tokens: u.cache_read_input_tokens,
          },
        },
      });
    }
  },
});
