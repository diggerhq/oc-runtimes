import {
  normalizeUsage,
  type DurableEmitter,
  type RuntimeSpec,
  type TranslateCtx,
} from "@oc/adapter-core";

/** One Codex turn.completed event is the invocation total. Ignore duplicate snapshots. */
export function createCodexTranslator(): RuntimeSpec["translate"] {
  let resultEmitted = false;

  return async (emitter: DurableEmitter, msg: any, ctx: TranslateCtx): Promise<void> => {
    if (msg?.type === "item.completed" && msg.item?.type === "agent_message" && msg.item.text?.trim()) {
      ctx.noteAssistantText(msg.item.text);
      await emitter.emit({ type: "agent.message", level: "progress", body: { text: msg.item.text } });
      return;
    }

    if (msg?.type !== "turn.completed" || resultEmitted) return;
    resultEmitted = true;
    const raw = msg.usage;
    const usage = normalizeUsage(raw && typeof raw === "object" && !Array.isArray(raw) ? {
      // Codex/OpenAI's cached input is a subset of input_tokens, not an extra component.
      inputTokens: raw.input_tokens,
      outputTokens: raw.output_tokens,
      cacheReadInputTokens: raw.cached_input_tokens,
      inputIncludesCacheRead: true,
    } : undefined);

    await emitter.emit({
      type: "agent.result",
      level: "internal",
      body: {
        model: ctx.model,
        is_error: false,
        usage,
      },
    });
  };
}
