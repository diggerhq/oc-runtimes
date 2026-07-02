// The v3-codex ADAPTER — this runtime's RuntimeSpec on the shared adapter-core driver
// (design 011 §5.3). Codex is the leanest consumer: no skills, no sources note, no watch
// rendering (github.* input rendering unifies with claude's at the S3b renderer pass),
// and the pre-drift MCP tool subset (the platform/GitHub tools were never in this brain's
// steering — exposing them without prompt support would be a behavior change; they arrive
// deliberately, with steering, as their own canary).

import { runAdapter, textOf, type InEvent, type TranslateCtx, type DurableEmitter } from "@oc/adapter-core";

runAdapter({
  name: "codex",
  defaultModel: "openai/gpt-5-codex",

  /** Human messages only. STRICT type match — `agent.message` (the agent's own answers
   *  and asks) is ALSO user-level; a ".message"-suffix match would re-feed the agent its
   *  own prior output as next-turn input. */
  isInputForModel(e: InEvent): boolean {
    return e.level === "user" && e.type === "user.message";
  },
  renderInput(e: InEvent): string {
    return textOf(e.body);
  },

  sourcesNote: () => "",
  skillsDir: () => null,   // skills unsupported on the codex family in v1 (009 §1)
  mcpTools: ["bash", "read", "write", "ls", "say", "ask"],

  // Native Codex SDK step → OC taxonomy. Tool events come from the MCP host, not here.
  async translate(emitter: DurableEmitter, msg: any, ctx: TranslateCtx): Promise<void> {
    if (msg?.type === "item.completed" && msg.item?.type === "agent_message" && msg.item.text?.trim()) {
      ctx.noteAssistantText(msg.item.text);
      await emitter.emit({ type: "agent.message", level: "progress", body: { text: msg.item.text } });
    }
  },
});
