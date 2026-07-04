// Golden translation tests for the flue RuntimeSpec (design 012 §11.6). Fixtures are
// hand-authored FlueEvents (v:3) built from flue's own union (types.ts@ffbe3595) — the real
// fixture ARTIFACT lands after W1; these pin the wire-shape → OC-taxonomy mapping now.
//
// Run: npx tsx test/translate.test.ts

import { translateFlueEvent } from "../src/translate.js";
import type { DurableEmitter, TranslateCtx } from "@oc/adapter-core";

let failed = 0;
const ok = (n: string, c: boolean, e = "") => { console.log(`${c ? "ok  " : "FAIL"} ${n}${c ? "" : "  <<< " + e}`); if (!c) failed++; };

interface Emitted { type: string; level?: string; body?: any }

function harness() {
  const events: Emitted[] = [];
  const notes: string[] = [];
  const emitter = { emit: async (ev: Emitted) => { events.push(ev); }, drain: async () => {} } as unknown as DurableEmitter;
  const ctx: TranslateCtx = { model: "anthropic/claude-sonnet-5", noteAssistantText: (t: string) => { notes.push(t); } };
  return { events, notes, emitter, ctx };
}

async function run() {
  // 1. assistant message_end → agent.message@progress + noteAssistantText
  {
    const { events, notes, emitter, ctx } = harness();
    await translateFlueEvent(emitter, {
      v: 3, type: "message_end", turnId: "t1",
      message: { role: "assistant", content: [{ type: "text", text: "Here is your answer." }] },
    }, ctx);
    ok("message_end → one agent.message@progress", events.length === 1 && events[0].type === "agent.message" && events[0].level === "progress", JSON.stringify(events));
    ok("message_end → body.text carried", events[0]?.body?.text === "Here is your answer.");
    ok("message_end → noted for safety-net", notes.length === 1 && notes[0] === "Here is your answer.");
  }

  // 1b. multiple text blocks → one event each, last noted last (driver promotes the last)
  {
    const { events, notes, emitter, ctx } = harness();
    await translateFlueEvent(emitter, {
      v: 3, type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "first" }, { type: "thinking", text: "ignored" }, { type: "text", text: "second" }] },
    }, ctx);
    ok("two text blocks → two events", events.length === 2 && events.every((e) => e.type === "agent.message"), JSON.stringify(events));
    ok("non-text blocks skipped", events[0]?.body?.text === "first" && events[1]?.body?.text === "second");
    ok("both noted in order (last wins host-side)", notes.length === 2 && notes[1] === "second");
  }

  // 1c. non-assistant / empty-text message_end → nothing
  {
    const { events, emitter, ctx } = harness();
    await translateFlueEvent(emitter, { v: 3, type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } }, ctx);
    await translateFlueEvent(emitter, { v: 3, type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "   " }] } }, ctx);
    ok("user message + blank assistant → dropped", events.length === 0, JSON.stringify(events));
  }

  // 2. turn → agent.result@internal with mapped usage
  {
    const { events, emitter, ctx } = harness();
    await translateFlueEvent(emitter, {
      v: 3, type: "turn", turnId: "t1", purpose: "agent", durationMs: 1234, isError: false,
      response: { usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 7, totalTokens: 132 } },
    }, ctx);
    ok("turn → one agent.result@internal", events.length === 1 && events[0].type === "agent.result" && events[0].level === "internal", JSON.stringify(events));
    const u = events[0]?.body?.usage;
    ok("turn usage mapped (cacheWrite→creation, cacheRead→read)",
      u?.input_tokens === 100 && u?.output_tokens === 20 && u?.cache_creation_input_tokens === 7 && u?.cache_read_input_tokens === 5, JSON.stringify(u));
    ok("turn body carries model + purpose", events[0]?.body?.model === "anthropic/claude-sonnet-5" && events[0]?.body?.purpose === "agent");
  }

  // 2b. turn without usage → dropped
  {
    const { events, emitter, ctx } = harness();
    await translateFlueEvent(emitter, { v: 3, type: "turn", turnId: "t1", purpose: "agent", durationMs: 5, isError: false, response: {} }, ctx);
    ok("turn without usage → dropped", events.length === 0);
  }

  // 3. tool-event dedup: custom tool_start → tool.call; proxied tools + `tool` completion → dropped
  {
    const { events, emitter, ctx } = harness();
    await translateFlueEvent(emitter, { v: 3, type: "tool_start", toolName: "lookup_order", toolCallId: "c1", args: { orderId: "A-99" } }, ctx);
    ok("custom tool_start → tool.call@progress", events.length === 1 && events[0].type === "tool.call" && events[0].level === "progress", JSON.stringify(events));
    ok("tool.call body has tool + args_summary", events[0]?.body?.tool === "lookup_order" && events[0]?.body?.args_summary?.includes("A-99"));

    for (const name of ["bash", "read", "write", "edit", "ls", "say", "ask"]) {
      const h = harness();
      await translateFlueEvent(h.emitter, { v: 3, type: "tool_start", toolName: name, toolCallId: "x", args: {} }, h.ctx);
      ok(`proxied tool_start '${name}' → dropped (dedup)`, h.events.length === 0, JSON.stringify(h.events));
    }

    const h2 = harness();
    await translateFlueEvent(h2.emitter, { v: 3, type: "tool", toolName: "lookup_order", toolCallId: "c1", isError: false, result: {}, durationMs: 3 }, h2.ctx);
    ok("`tool` completion event → dropped (no double-event)", h2.events.length === 0, JSON.stringify(h2.events));
  }

  // 4. dropped classes: deltas / thinking / log / idle / operation / compaction / task / settled
  {
    const dropped = [
      { v: 3, type: "text_delta", text: "x" },
      { v: 3, type: "thinking_delta", delta: "y" },
      { v: 3, type: "log", level: "info", message: "z" },
      { v: 3, type: "idle" },
      { v: 3, type: "operation_start", operationId: "o", operationKind: "prompt" },
      { v: 3, type: "compaction_start", reason: "threshold", estimatedTokens: 1 },
      { v: 3, type: "task_start", taskId: "k", prompt: "p" },
      { v: 3, type: "agent_start" },
      { v: 3, type: "agent_end", messages: [] },
      { v: 3, type: "submission_settled", submissionId: "s", outcome: "completed" },
      { v: 3, type: "message_start", message: { role: "assistant", content: [] }, turnId: "t" },
    ];
    let total = 0;
    for (const ev of dropped) { const h = harness(); await translateFlueEvent(h.emitter, ev, h.ctx); total += h.events.length; }
    ok("all noise/coarser-covered events dropped", total === 0, `emitted ${total}`);
  }

  // 5. malformed / unknown shapes never throw (driver keeps the turn alive)
  {
    const h = harness();
    let threw = false;
    for (const bad of [null, undefined, {}, { type: "message_end" }, { type: "turn" }, { type: "tool_start" }, 42, "str"]) {
      try { await translateFlueEvent(h.emitter, bad as unknown, h.ctx); } catch { threw = true; }
    }
    ok("malformed events never throw", !threw && h.events.length === 0);
  }

  // 6. fence propagates: an emit that throws Error('fenced') must surface to the driver
  {
    let threw: unknown;
    const emitter = { emit: async () => { throw new Error("fenced"); }, drain: async () => {} } as unknown as DurableEmitter;
    const ctx: TranslateCtx = { model: "m", noteAssistantText: () => {} };
    try {
      await translateFlueEvent(emitter, { v: 3, type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }] } }, ctx);
    } catch (e) { threw = e; }
    ok("fence from emit propagates", threw instanceof Error && (threw as Error).message === "fenced");
  }

  console.log(failed ? `\n${failed} FAILED` : "\nall translate tests passed");
  process.exit(failed ? 1 : 0);
}

run();
