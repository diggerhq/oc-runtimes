import {
  normalizeUsage,
  type DurableEmitter,
  type RuntimeSpec,
  type TranslateCtx,
} from "@oc/adapter-core";

/** Pi's synthetic result is already the invocation total. Ignore duplicate snapshots. */
export function createPiTranslator(): RuntimeSpec["translate"] {
  let resultEmitted = false;

  return async (emitter: DurableEmitter, msg: any, ctx: TranslateCtx): Promise<void> => {
    if (msg?.type === "message_end" && msg.message?.role === "assistant") {
      const content = Array.isArray(msg.message.content) ? msg.message.content : [];
      for (const block of content) {
        if (block?.type === "text" && block.text?.trim()) {
          ctx.noteAssistantText(block.text);
          await emitter.emit({ type: "agent.message", level: "progress", body: { text: block.text } });
        }
      }
      return;
    }

    if (msg?.type !== "result" || resultEmitted) return;
    resultEmitted = true;
    const raw = msg.usage;
    const usage = normalizeUsage(raw && typeof raw === "object" && !Array.isArray(raw) ? {
      inputTokens: raw.input,
      outputTokens: raw.output,
      cacheCreationInputTokens: raw.cacheWrite,
      cacheReadInputTokens: raw.cacheRead,
    } : undefined);

    await emitter.emit({
      type: "agent.result",
      level: "internal",
      body: {
        num_steps: msg.num_steps,
        model: ctx.model,
        is_error: Boolean(msg.is_error),
        duration_ms: msg.duration_ms,
        usage,
      },
    });
  };
}
