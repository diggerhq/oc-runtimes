// The two injected OC tools (design 012 §11.4). `say` posts a user-visible message
// mid-run; `ask` asks and yields the session: the MCP host appends the agent.message with
// awaiting_input:true (the host's needs_input derivation is untouched), the persisted
// awaiting-flag is set (it must survive attempt death — §11.9), and the engine run is
// aborted — the pi ctx.abort() move, S0a-verified: the tool result lands durably BEFORE
// settle, and the next admission continues with full context.

import { defineTool } from "@flue/runtime";
import { mcpCall, activeTurn } from "./mcp-client.js";
import type { PackageState } from "./state.js";

export interface ToolWiring {
  state: PackageState;
  abortCurrentInstance: () => Promise<boolean>;
}

// Input schemas are plain JSON-schema-shaped objects via flue's schema-agnostic accept
// (StandardSchema/valibot/raw). We use valibot-free structural inputs: flue accepts raw
// JSON Schema for tool inputs per its ToolInputSchema union.
// W1 note: if the peer's defineTool rejects raw schema, swap to valibot (devDep present).

export function createOcTools(wiring: ToolWiring): unknown[] {
  const say = defineTool({
    name: "say",
    description:
      "Post a short user-visible progress message. Use sparingly for meaningful status; the final answer is delivered automatically.",
    input: {
      type: "object",
      properties: { text: { type: "string", description: "the message to show the user" } },
      required: ["text"],
    } as never,
    async run(ctx: { input?: { text?: string } }) {
      const text = ctx.input?.text ?? "";
      await mcpCall("say", { text });
      return "shown to the user";
    },
  });

  const ask = defineTool({
    name: "ask",
    description:
      "Ask the user a question and END this run — the session waits for their reply at zero cost and resumes with the answer as the next message. Use when you cannot proceed without input.",
    input: {
      type: "object",
      properties: { question: { type: "string", description: "the question for the user" } },
      required: ["question"],
    } as never,
    async run(ctx: { input?: { question?: string } }) {
      const question = ctx.input?.question ?? "";
      await mcpCall("ask", { question });
      if (activeTurn.turnId) wiring.state.setAwaiting(activeTurn.turnId);
      await wiring.abortCurrentInstance(); // recorded durably; the run settles after this tool returns
      return "asked — the run ends here; the user's reply arrives as the next message";
    },
  });

  return [say, ask];
}

export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash", "read", "write", "edit", "ls", "say", "ask",
]);
