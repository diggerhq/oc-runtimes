import {
  normalizeUsage,
  type DurableEmitter,
  type RuntimeSpec,
  type TranslateCtx,
} from "@oc/adapter-core";

/** One Codex terminal event is the invocation result. Ignore duplicate snapshots. */
export function createCodexTranslator(): RuntimeSpec["translate"] {
  let resultEmitted = false;

  return async (emitter: DurableEmitter, msg: any, ctx: TranslateCtx): Promise<void> => {
    if (msg?.type === "item.completed" && msg.item?.type === "agent_message" && msg.item.text?.trim()) {
      ctx.noteAssistantText(msg.item.text);
      await emitter.emit({ type: "agent.message", level: "progress", body: { text: msg.item.text } });
      return;
    }

    if ((msg?.type !== "turn.completed" && msg?.type !== "turn.failed") || resultEmitted) return;
    resultEmitted = true;
    if (msg.type === "turn.failed") {
      await emitter.emit({
        type: "agent.result",
        level: "internal",
        body: {
          model: ctx.model,
          is_error: true,
          error: typeof msg.error?.message === "string" ? msg.error.message : "Codex turn failed",
          usage: { reported: false },
        },
      });
      return;
    }
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
