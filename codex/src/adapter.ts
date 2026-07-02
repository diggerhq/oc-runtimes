// The v3-codex ADAPTER — this runtime's RuntimeSpec on the shared adapter-core driver
// (design 011 §5.3). Codex is the leanest consumer: no skills, no sources note, and the
// pre-drift MCP tool subset (the platform/GitHub tools were never in this brain's
// steering — exposing them without prompt support would be a behavior change; they arrive
// deliberately, with steering, as their own canary). Input filtering/rendering is the
// shared standard INCLUDING github.* watch deliveries: the watches API has no per-runtime
// gate, so the old user.message-only filter silently ATE deliveries (review finding) —
// a rendered notification any model can act on beats a consumed-and-lost wakeup.

import { runAdapter, standardInputFilter, standardRenderInput, type TranslateCtx, type DurableEmitter } from "@oc/adapter-core";

runAdapter({
  name: "codex",
  defaultModel: "openai/gpt-5-codex",
  isInputForModel: standardInputFilter,
  renderInput: standardRenderInput,

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
