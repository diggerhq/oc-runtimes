import { deepStrictEqual, equal } from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.OC_API_URL = "http://127.0.0.1:1";
process.env.OC_SESSION_ID = "ses_claude_translate_test";
process.env.OC_TURN_TOKEN = "test-turn-token";
const { createClaudeTranslator } = await import("../dist/translate.js");

const golden = JSON.parse(readFileSync(new URL("./fixtures/agent-result.golden.json", import.meta.url), "utf8"));
const events = [];
const notes = [];
const emitter = { emit: async (event) => { events.push(event); } };
const ctx = { model: "anthropic/claude-opus-4-8", noteAssistantText: (text) => notes.push(text) };
const translate = createClaudeTranslator();

await translate(emitter, {
  type: "assistant",
  message: { content: [{ type: "text", text: "The alert is understood." }] },
}, ctx);
const result = {
  type: "result",
  subtype: "success",
  num_turns: 2,
  is_error: false,
  duration_ms: 1200,
  duration_api_ms: 1100,
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 7,
    cache_read_input_tokens: 5,
  },
};
await translate(emitter, result, ctx);
await translate(emitter, result, ctx);

deepStrictEqual(events, golden);
deepStrictEqual(notes, ["The alert is understood."]);

const errorEvents = [];
await createClaudeTranslator()({ emit: async (event) => errorEvents.push(event) }, {
  type: "result",
  subtype: "error",
  is_error: true,
  usage: { input_tokens: 3, output_tokens: 2 },
}, ctx);
equal(errorEvents[0]?.body?.is_error, true);
equal(errorEvents[0]?.body?.usage?.reported, true);
equal(errorEvents[0]?.body?.usage?.tokens, 5);

const invalidCostEvents = [];
await createClaudeTranslator()({ emit: async (event) => invalidCostEvents.push(event) }, {
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: Number.POSITIVE_INFINITY,
  usage: { input_tokens: 3, output_tokens: 2 },
}, ctx);
equal(invalidCostEvents[0]?.body?.usage?.reported, true);
equal(invalidCostEvents[0]?.body?.usage?.tokens, 5);
equal("total_cost_usd" in invalidCostEvents[0].body.usage, false);
equal("total_cost_usd" in invalidCostEvents[0].body, false);

const adapterSource = readFileSync(new URL("../src/adapter.ts", import.meta.url), "utf8");
equal(/isInputForModel:\s*standardInputFilter/.test(adapterSource), true);
equal(/renderInput:\s*standardRenderInput/.test(adapterSource), true);

console.log("claude normalized result golden passed");
