// FlueEvent (v:3) → OC taxonomy translation (design 012 §11.6). This is the flue
// RuntimeSpec's translate(): the driver hands it each NDJSON step's `.msg` (a decorated
// FlueEvent that serveOC forwarded verbatim) and it appends the OC-taxonomy events.
//
// The image NEVER links @flue/runtime (012 §7 "the image knows Flue's wire shapes, not
// its code" — that is why it can host whichever artifact lands in it). So the event shapes
// below are a LOCAL, structural mirror of the fields we read from flue's `FlueEventVariant`
// union (packages/runtime/src/types.ts@ffbe3595, `v: 3`) — not an import. Re-verify against
// that union when bumping the tested flue range (§6.5 exact-pin discipline).
//
// Two rules carry the section:
//   1. Assistant text → agent.message@progress + noteAssistantText (the safety-net answer,
//      exactly as pi's brain surfaces assistant text — the driver promotes the LAST one if
//      no say/ask ran).
//   2. TOOL-EVENT DEDUP: tool_start/tool → OC tool.call ONLY for in-process CUSTOM tools
//      (names OUTSIDE the proxied set {bash,read,write,edit,ls,say,ask}). The sandbox tools
//      + say/ask are already evented by the adapter's MCP host at execution time, so
//      re-eventing them here would double every call. `edit` is in the suppressed set even
//      though it is NOT an MCP tool: flue's `edit` built-in composes over SandboxApi
//      read/write, so its effects already surface as read/write MCP tool events (no
//      observability hole). The reserved-name rule (012 §11.2.8) keeps user custom tools
//      out of this set, so a custom tool can never be silently suppressed.
//
// Everything else — text/thinking deltas, log, idle, operation*/compaction*/task*,
// message_start, turn_start/turn_request/turn_messages — is dropped (noise or covered by a
// coarser event). `submission_settled` is consumed by serveOC (it drives the `done` line),
// not translated, and never reaches here as a step; we drop it defensively.

import type { DurableEmitter, TranslateCtx } from "@oc/adapter-core";

// The tools whose calls the MCP host already events (012 §11.6 dedup rule). `edit` is
// suppressed here despite not being an MCP tool — see the header. Frozen so a future edit
// keeps it a value check, not an accidental widening.
const PROXIED_TOOLS: ReadonlySet<string> = new Set(["bash", "read", "write", "edit", "ls", "say", "ask"]);

// ── The subset of the FlueEvent (v:3) union we consume (structural, not imported). ──

interface TextBlock { type?: string; text?: string }
interface FlueMessage { role?: string; content?: unknown }

interface FluePromptUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

interface FlueStepEvent {
  type?: string;
  // message_start / message_end
  message?: FlueMessage;
  // tool_start / tool
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  isError?: boolean;
  result?: unknown;
  durationMs?: number;
  // turn (carries per-model-call usage)
  purpose?: string;
  response?: { usage?: FluePromptUsage; finishReason?: string };
}

/** Read assistant text blocks out of a message_end message. Defensive: array-only, skips blanks. */
function assistantTextBlocks(message: FlueMessage | undefined): string[] {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const out: string[] = [];
  for (const block of message.content as TextBlock[]) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) out.push(block.text);
  }
  return out;
}

/** A compact, bounded summary of a custom tool's args for the OC tool.call body. */
function argsSummary(args: unknown): string {
  if (args == null) return "";
  try {
    return (typeof args === "string" ? args : JSON.stringify(args)).slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * Translate one FlueEvent into OC events. Mirrors pi's translate contract: awaits every
 * emit so a fence (401 → Error("fenced")) propagates to the driver's ladder; throws NOTHING
 * else (unknown/malformed shapes are dropped, never fatal — the driver keeps the turn alive).
 */
export async function translateFlueEvent(emitter: DurableEmitter, msg: unknown, ctx: TranslateCtx): Promise<void> {
  const e = (msg ?? {}) as FlueStepEvent;

  switch (e.type) {
    case "message_end": {
      // Assistant text → user-visible-progress + safety-net note (last one wins host-side).
      for (const text of assistantTextBlocks(e.message)) {
        ctx.noteAssistantText(text);
        await emitter.emit({ type: "agent.message", level: "progress", body: { text } });
      }
      return;
    }

    case "turn": {
      // Per-model-call usage → internal telemetry (flight recorder; NOT the billing path —
      // spend is metered at the egress proxy/gateway, 012 §11.10). One per model turn,
      // including compaction turns. agent_end carries no usage, so `turn` is the source.
      const u = e.response?.usage;
      if (!u) return;
      await emitter.emit({
        type: "agent.result",
        level: "internal",
        body: {
          model: ctx.model,
          purpose: e.purpose,
          is_error: Boolean(e.isError),
          duration_ms: e.durationMs,
          usage: {
            input_tokens: u.input,
            output_tokens: u.output,
            cache_creation_input_tokens: u.cacheWrite,
            cache_read_input_tokens: u.cacheRead,
          },
        },
      });
      return;
    }

    case "tool_start": {
      // §6.4 stream-translation observability: a CUSTOM (in-process) tool's call becomes
      // visible in the OC log with no proxy. Proxied tools are dropped (the MCP host already
      // evented them at execution — dedup rule). tool_start carries the args; the completion
      // `tool` event is dropped to avoid double-eventing a single custom-tool invocation.
      const name = e.toolName ?? "";
      if (!name || PROXIED_TOOLS.has(name)) return;
      await emitter.emit({
        type: "tool.call",
        level: "progress",
        body: { tool: name, args_summary: argsSummary(e.args) },
      });
      return;
    }

    // Dropped: message_start, text_delta, thinking_*, log, idle, operation*, compaction*,
    // task*, run_*, turn_start/turn_request/turn_messages, agent_start/agent_end, and the
    // `tool` completion event (its tool_start already evented custom tools). submission_settled
    // is consumed by serveOC's done line and should never arrive as a step.
    default:
      return;
  }
}
