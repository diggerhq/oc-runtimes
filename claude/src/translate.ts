import {
  normalizeUsage,
  type DurableEmitter,
  type RuntimeSpec,
  type TranslateCtx,
} from "@oc/adapter-core";

/** One Claude SDK result is already the invocation total. Ignore duplicate terminal snapshots. */
export function createClaudeTranslator(): RuntimeSpec["translate"] {
  let resultEmitted = false;

  return async (emitter: DurableEmitter, msg: any, ctx: TranslateCtx): Promise<void> => {
    if (msg?.type === "assistant") {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
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
      inputTokens: raw.input_tokens,
      outputTokens: raw.output_tokens,
      cacheCreationInputTokens: raw.cache_creation_input_tokens,
      cacheReadInputTokens: raw.cache_read_input_tokens,
      totalCostUsd: msg.total_cost_usd,
    } : undefined);

    await emitter.emit({
      type: "agent.result",
      level: "internal",
      body: {
        subtype: msg.subtype,
        num_turns: msg.num_turns,
        model: ctx.model.replace(/^anthropic\//, ""),
        is_error: msg.is_error,
        duration_ms: msg.duration_ms,
        duration_api_ms: msg.duration_api_ms,
        ...(usage.reported && usage.total_cost_usd !== undefined
          ? { total_cost_usd: usage.total_cost_usd }
          : {}),
        usage,
      },
    });
  };
}
