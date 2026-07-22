import { deepStrictEqual, equal } from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { InEvent } from "./src/index.js";

process.env.OC_API_URL = "http://127.0.0.1:1";
process.env.OC_SESSION_ID = "ses_contract_test";
process.env.OC_TURN_TOKEN = "test-turn-token";

const {
  canonicalJson,
  normalizeUsage,
  standardInputFilter,
  standardRenderInput,
} = await import("./src/index.js");

const golden = JSON.parse(readFileSync(new URL("./testdata/contracts.golden.json", import.meta.url), "utf8"));
const event = (type: string, body: unknown, level: InEvent["level"] = "user"): InEvent => ({
  seq: 1,
  id: "evt_1",
  type,
  level,
  actor: { type: "trigger" },
  body,
  refs: {},
  ts: "2026-07-21T00:00:00Z",
});

const httpObject = event("http.request", {
  payload: {
    source: "sentry",
    nested: { z: 2, a: 1 },
    tags: ["payments", null],
    event_url: "https://sentry.example/events/123",
  },
});
equal(standardInputFilter(httpObject), true);
equal(standardRenderInput(httpObject), golden.http_object);
equal(standardRenderInput(event("http.request", { payload: 42 })), golden.http_scalar);
equal(standardRenderInput(event("http.request", {})), golden.http_fallback);

const hookEvent = event("http.request", { payload: { status: "firing", service: "checkout" } });
hookEvent.actor = { id: "hk_a4c92e8f17b64d03a9510c7e", type: "trigger", display: "grafana-prod" };
hookEvent.refs = {
  http: {
    request_id: "req_89b711af7bc94b61b893aa10",
    hook_id: "hk_a4c92e8f17b64d03a9510c7e",
  },
};
equal(standardRenderInput(hookEvent), golden.http_hook);
hookEvent.body = { payload: null };
equal(standardRenderInput(hookEvent), golden.http_hook_empty);
hookEvent.actor = { ...hookEvent.actor as Record<string, unknown>, id: "hk_000000000000000000000000" };
equal(standardRenderInput(hookEvent), golden.http_fallback);

equal(standardInputFilter(event("user.message", { text: "hello" })), true);
equal(standardInputFilter(event("github.pr.comment", {})), true);
equal(standardInputFilter(event("agent.message", { text: "do not replay me" })), false);
equal(standardInputFilter(event("http.request", { payload: null }, "internal")), false);

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;
equal(canonicalJson(cyclic), "null");
equal(
  canonicalJson(JSON.parse('{"__proto__":"value","constructor":"plain"}')),
  "{\"__proto__\":\"value\",\"constructor\":\"plain\"}",
);

deepStrictEqual(normalizeUsage({
  inputTokens: 100,
  outputTokens: 20,
  cacheCreationInputTokens: 7,
  cacheReadInputTokens: 5,
  totalCostUsd: 0.0123,
}), golden.claude_usage);
deepStrictEqual(normalizeUsage({
  inputTokens: 100,
  outputTokens: 20,
  cacheReadInputTokens: 30,
  inputIncludesCacheRead: true,
}), golden.codex_usage);
deepStrictEqual(normalizeUsage({
  inputTokens: 11,
  outputTokens: 13,
  cacheCreationInputTokens: 17,
  cacheReadInputTokens: 19,
}), golden.pi_usage);
deepStrictEqual(normalizeUsage({}), golden.unreported);
deepStrictEqual(normalizeUsage(undefined), golden.unreported);
deepStrictEqual(normalizeUsage({ inputTokens: -1 }), golden.unreported);
deepStrictEqual(normalizeUsage({ inputTokens: 2, cacheReadInputTokens: 3, inputIncludesCacheRead: true }), golden.unreported);
deepStrictEqual(normalizeUsage({ outputTokens: Number.NaN }), golden.unreported);
deepStrictEqual(normalizeUsage({ cacheCreationInputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }), golden.unreported);
deepStrictEqual(normalizeUsage({ totalCostUsd: Number.POSITIVE_INFINITY }), golden.unreported);
deepStrictEqual(normalizeUsage({ inputTokens: 4, totalCostUsd: Number.POSITIVE_INFINITY }), {
  reported: true,
  input_tokens: 4,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  tokens: 4,
});

console.log("adapter-core HTTP input and usage contract goldens passed");
