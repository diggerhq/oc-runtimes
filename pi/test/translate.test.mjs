import { deepStrictEqual, equal } from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.OC_API_URL = "http://127.0.0.1:1";
process.env.OC_SESSION_ID = "ses_pi_translate_test";
process.env.OC_TURN_TOKEN = "test-turn-token";
const { createPiTranslator } = await import("../dist/translate.js");

const golden = JSON.parse(readFileSync(new URL("./fixtures/agent-result.golden.json", import.meta.url), "utf8"));
const events = [];
const notes = [];
const emitter = { emit: async (event) => { events.push(event); } };
const ctx = { model: "anthropic/claude-opus-4-8", noteAssistantText: (text) => notes.push(text) };
const translate = createPiTranslator();

await translate(emitter, {
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "I inspected the request." }] },
}, ctx);
const result = {
  type: "result",
  num_steps: 3,
  is_error: false,
  duration_ms: 900,
  usage: { input: 11, output: 13, cacheWrite: 17, cacheRead: 19 },
};
await translate(emitter, result, ctx);
await translate(emitter, result, ctx);

deepStrictEqual(events, golden);
deepStrictEqual(notes, ["I inspected the request."]);

const invalidEvents = [];
await createPiTranslator()({ emit: async (event) => invalidEvents.push(event) }, {
  type: "result",
  is_error: true,
  usage: { input: -1 },
}, ctx);
equal(invalidEvents[0]?.body?.is_error, true);
deepStrictEqual(invalidEvents[0]?.body?.usage, { reported: false });

console.log("pi normalized result golden passed");
