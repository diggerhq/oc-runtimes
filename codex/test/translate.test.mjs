import { deepStrictEqual, equal } from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.OC_API_URL = "http://127.0.0.1:1";
process.env.OC_SESSION_ID = "ses_codex_translate_test";
process.env.OC_TURN_TOKEN = "test-turn-token";
const { createCodexTranslator } = await import("../dist/translate.js");

const golden = JSON.parse(readFileSync(new URL("./fixtures/agent-result.golden.json", import.meta.url), "utf8"));
const events = [];
const notes = [];
const emitter = { emit: async (event) => { events.push(event); } };
const ctx = { model: "openai/gpt-5-codex", noteAssistantText: (text) => notes.push(text) };
const translate = createCodexTranslator();

await translate(emitter, {
  type: "item.completed",
  item: { type: "agent_message", text: "I inspected the request." },
}, ctx);
const result = {
  type: "turn.completed",
  usage: {
    input_tokens: 100,
    cached_input_tokens: 30,
    output_tokens: 20,
    reasoning_output_tokens: 8,
  },
};
await translate(emitter, result, ctx);
await translate(emitter, result, ctx);

deepStrictEqual(events, golden);
deepStrictEqual(notes, ["I inspected the request."]);

const failedEvents = [];
const failedTranslate = createCodexTranslator();
await failedTranslate({ emit: async (event) => failedEvents.push(event) }, {
  type: "turn.failed",
  error: { message: "provider request failed" },
}, ctx);
await failedTranslate({ emit: async (event) => failedEvents.push(event) }, result, ctx);
deepStrictEqual(failedEvents, [{
  type: "agent.result",
  level: "internal",
  body: {
    model: "openai/gpt-5-codex",
    is_error: true,
    error: "provider request failed",
    usage: { reported: false },
  },
}]);

const adapterSource = readFileSync(new URL("../src/adapter.ts", import.meta.url), "utf8");
equal(/isInputForModel:\s*standardInputFilter/.test(adapterSource), true);
equal(/renderInput:\s*standardRenderInput/.test(adapterSource), true);

console.log("codex normalized result golden passed");
