// Committed FIXTURE brain (design 012 §11.10 "permanent smoke"). A stand-in for a real
// @opencomputer/flue serveOC artifact: it implements the brain wire contract with NO
// @flue/runtime dependency, so the launcher + translate + adapter path can be driven in CI
// without npm or a user build. It emits a canned FlueEvent (v:3) stream in serveOC's exact
// NDJSON shape — `{ seq, kind: <event.type>, offset: <eventIndex>, msg: <FlueEvent> }` — then
// the terminal `{ kind:"done", reason }`. The real serveOC (opencomputer-flue/) replaces this;
// the fixture only proves the runtime IMAGE (launcher + RuntimeSpec) hosts an artifact.
import { createServer } from "node:http";

const PORT = Number(process.env.OC_BRAIN_PORT ?? "8080");
const CONTRACT_VERSION = "1";
let busy = false;

// A canned FlueEvent stream that exercises every translate branch (012 §11.6):
//   message_end (assistant text) → agent.message@progress + safety-net note
//   tool_start "bash" (proxied)  → DROPPED (MCP host already events it — dedup)
//   tool_start "lookup_order"    → tool.call@progress (custom, in-process)
//   turn (usage)                 → agent.result@internal
//   text_delta                   → DROPPED (noise)
// eventIndex is the flue stream offset the driver persists as the R6 cursor.
const STREAM = [
  { v: 3, type: "message_end", eventIndex: 1, timestamp: "1970-01-01T00:00:00Z", turnId: "t", message: { role: "assistant", content: [{ type: "text", text: "Fixture brain answer." }] } },
  { v: 3, type: "tool_start", eventIndex: 2, timestamp: "1970-01-01T00:00:00Z", toolName: "bash", toolCallId: "b1", args: { command: "uname" } },
  { v: 3, type: "tool_start", eventIndex: 3, timestamp: "1970-01-01T00:00:00Z", toolName: "lookup_order", toolCallId: "c1", args: { orderId: "A-99" } },
  { v: 3, type: "text_delta", eventIndex: 4, timestamp: "1970-01-01T00:00:00Z", text: "ignored" },
  { v: 3, type: "turn", eventIndex: 5, timestamp: "1970-01-01T00:00:00Z", turnId: "t", purpose: "agent", durationMs: 12, isError: false, response: { usage: { input: 10, output: 3, cacheRead: 1, cacheWrite: 2, totalTokens: 16 } } },
];

const srv = createServer((req, res) => {
  if (req.method === "GET" && req.url && req.url.startsWith("/healthz")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ready", contract_version: CONTRACT_VERSION, busy }));
    return;
  }
  if (req.method === "POST" && req.url && req.url.startsWith("/turn")) {
    if (busy) { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "busy" } })); return; }
    busy = true;
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
    let seq = 0;
    for (const ev of STREAM) res.write(JSON.stringify({ seq: seq++, kind: ev.type, offset: ev.eventIndex, msg: ev }) + "\n");
    res.write(JSON.stringify({ kind: "done", reason: "quiescent" }) + "\n");
    res.end();
    busy = false;
    return;
  }
  res.writeHead(404); res.end();
});

srv.listen(PORT, "127.0.0.1", () => console.log(`[flue-fixture-brain] listening on 127.0.0.1:${PORT}`));
