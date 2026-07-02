// v3-codex BRAIN — the reshaped codex runtime (runtime.md §3/§4). A resident, OC-UNAWARE
// HTTP server wrapping the OpenAI Codex SDK. Same contract as the claude brain
// (server.ts): GET /healthz + POST /turn streaming the SDK's NATIVE events as NDJSON;
// the platform ADAPTER (adapter.ts) owns all OC-awareness (events/taxonomy/durability).
//
// Codex specifics (vs claude):
//   - wraps @openai/codex-sdk: new Codex() → startThread / resumeThread → runStreamed.
//   - RESUME is a SERVER-SIDE THREAD: persist thread.id to OC_RUNTIME_STATE_DIR/codex-thread-id
//     (checkpointed with the box) and resumeThread(id) next turn (★O2b mechanism).
//   - tools come from the adapter-hosted MCP endpoint (codex MCP shape: {type:"mcp",name,url}).
//   - model is openai/… ; the sealed OPENAI_API_KEY in env is swapped by the host egress proxy.
//
// Streams { seq, kind:<event.type>, msg:<event> } so the codex adapter's translate() reads
// `msg` exactly like the claude adapter — only the per-SDK translation differs.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";

const CONTRACT_VERSION = "1";
const PORT = Number(process.env.OC_BRAIN_PORT ?? "8080");

const TOOL_STEERING =
  "Your filesystem and shell are REMOTE — use ONLY the OpenComputer MCP tools (oc): " +
  "bash (shell), read / write / ls (files). There is no local filesystem. " +
  "Anything the human should see — progress, findings, and especially your final ANSWER — MUST go through the say tool. " +
  "Use the ask tool when you need a decision or missing info; after asking, STOP.";

interface TurnConfig {
  model?: string;
  system_prompt?: string;
  mcp_endpoint?: string;   // adapter-hosted MCP server: the hands + say/ask
  state_dir?: string;      // OC_RUNTIME_STATE_DIR; the codex thread id lives under it
  resume?: boolean;        // ignored — codex resumes via the persisted thread id, not a flag
  deadline_s?: number;
  // Managed model access (token-billing §5.2): non-secret routing. mode:"managed"
  // → point the OpenAI provider block at OpenRouter (base_url …/api/v1, key from the
  // sealed OPENAI_API_KEY). Absent / mode:"byo" → direct OpenAI.
  endpoint_profile?: { mode?: string; base_url?: string; auth_env?: string };
}
interface TurnRequest {
  contract_version?: string;
  turn_id?: string;
  input?: Array<{ role?: string; content?: string }>;
  config?: TurnConfig;
}

let busy = false;

async function readBody(req: IncomingMessage): Promise<TurnRequest> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function writeLine(res: ServerResponse, obj: unknown): void {
  res.write(JSON.stringify(obj) + "\n");
}

async function runTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (busy) { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "busy", message: "a turn is in flight" } })); return; }

  let body: TurnRequest;
  try { body = await readBody(req); }
  catch { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "invalid", message: "bad JSON" } })); return; }

  if (body.contract_version && body.contract_version !== CONTRACT_VERSION) {
    res.writeHead(426, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "version", message: `brain speaks contract ${CONTRACT_VERSION}` } }));
    return;
  }

  const cfg = body.config ?? {};
  const managed = cfg.endpoint_profile?.mode === "managed";
  // BYO strips the openai/ prefix; Managed keeps the full OpenRouter slug (OR needs it).
  const model = managed
    ? (cfg.model ?? "openai/gpt-5-codex")
    : (cfg.model ?? "openai/gpt-5-codex").replace(/^openai\//, "");
  const stateDir = cfg.state_dir ?? join(process.env.HOME ?? "/home/sandbox", ".oc/runtime-state");
  mkdirSync(stateDir, { recursive: true });
  const threadFile = join(stateDir, "codex-thread-id");
  const savedThreadId = existsSync(threadFile) ? readFileSync(threadFile, "utf8").trim() : "";

  const prompt = [
    cfg.system_prompt ?? "You are a helpful background agent.",
    TOOL_STEERING,
    (body.input ?? []).map((m) => `${m.role ?? "user"}: ${m.content ?? ""}`).filter(Boolean).join("\n\n") || "(no new input)",
  ].filter(Boolean).join("\n\n");

  // BRAIN/HANDS SEPARATION — codex must run shell + files in the REMOTE hands box via the
  // adapter-hosted `oc` MCP server, NOT its built-in exec (which runs in THIS brain box →
  // no tool.call event, no isolation). Register the MCP server with auto-approval; the
  // native exec is disabled below so the model is forced onto the oc tools. Without an
  // endpoint the turn runs tool-less (degraded — but the adapter always provides one).
  const mcpServers = cfg.mcp_endpoint
    ? { oc: { url: cfg.mcp_endpoint, default_tools_approval_mode: "auto" } }
    : {};

  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  busy = true;
  let seq = 0;
  const ac = new AbortController();
  req.on("close", () => { if (!res.writableEnded) ac.abort(); });

  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    // Force the HTTP/SSE responses transport, NOT codex's experimental WebSocket: the OC
    // sealed-key egress proxy swaps the key on HTTPS requests but NOT on the wss handshake
    // (→ 401). A custom provider with supports_websockets:false routes over HTTPS, which the
    // egress proxy handles. The SDK flattens `config` into `codex exec --config k=v`.
    const codex = new Codex({
      env,
      config: {
        model_provider: "openai-http",
        model_providers: {
          "openai-http": {
            name: "OpenAI HTTP/SSE",
            // Managed → OpenRouter's Responses surface (base …/api/v1, Bearer auth via the
            // sealed OPENAI_API_KEY). The §9.7 spike validated the Responses API + tool
            // calls + cost echo through OR; requires_openai_auth:false uses the env_key
            // Bearer directly rather than OpenAI's auth flow. BYO → direct OpenAI.
            base_url: managed && cfg.endpoint_profile?.base_url ? cfg.endpoint_profile.base_url : "https://api.openai.com/v1",
            env_key: "OPENAI_API_KEY",
            wire_api: "responses",
            requires_openai_auth: !managed,
            supports_websockets: false,
          },
        },
        // Force codex off its built-in shell so it runs everything through the `oc` hands
        // tools: shell_tool/unified_exec = codex's native local exec (→ disable). The
        // fallback model metadata (codex doesn't ship gpt-5-codex metadata for a custom
        // provider) also injects image_generation, which gpt-5-codex REJECTS turn-fatally —
        // so disable it too. (Verified locally: with these off + oc registered, codex routes
        // bash/say/ask through MCP and never touches a local shell.)
        features: { shell_tool: false, unified_exec: false, image_generation: false },
        mcp_servers: mcpServers,
      },
    } as never);
    // sandbox danger-full-access + approval never: with the native shell gone nothing runs
    // locally, so codex's OS sandbox/approval is moot — but if left restrictive it CANCELS
    // the remote MCP tool calls ("sandbox cancelled each command invocation"). The brain box
    // is itself an isolated OC sandbox; the only side effects are remote oc tool calls.
    const threadOpts = { skipGitRepoCheck: true, sandboxMode: "danger-full-access", approvalPolicy: "never" } as never;
    const thread = savedThreadId
      ? codex.resumeThread(savedThreadId, threadOpts)
      : codex.startThread({ model, ...(threadOpts as object) } as never);

    const { events } = await thread.runStreamed(prompt);
    let awaiting = false;
    for await (const event of events) {
      if (ac.signal.aborted) throw new Error("aborted");
      // Stream the NATIVE codex event; the adapter translates + appends durably.
      writeLine(res, { seq: seq++, kind: (event as { type?: string }).type, msg: event });
      // `ask` pauses the turn: detect the ask MCP tool call. Codex emits these as
      // mcp_tool_call items (server:"oc", tool:"ask"); fall back to name for safety. The
      // adapter's MCP host is the authoritative needs_input signal — this just sets done.reason.
      const e = event as { type?: string; item?: { type?: string; name?: string; tool?: string } };
      if (e.type === "item.completed" && /(^|[._])ask$/.test(e.item?.tool ?? e.item?.name ?? "")) awaiting = true;
    }
    if (thread.id) writeFileSync(threadFile, thread.id);   // ★O2b: persist for resume
    writeLine(res, { kind: "done", reason: awaiting ? "awaiting_input" : "quiescent" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (ac.signal.aborted) writeLine(res, { kind: "done", reason: "error", error: { type: "aborted", message } });
    else writeLine(res, { kind: "done", reason: "error", error: { type: "turn_failed", message } });
  } finally {
    busy = false;
    if (!res.writableEnded) res.end();
  }
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ready", contract_version: CONTRACT_VERSION, busy }));
    return;
  }
  if (req.method === "POST" && req.url === "/turn") { void runTurn(req, res); return; }
  res.writeHead(404); res.end();
});

server.listen(PORT, "127.0.0.1", () => console.log(`[v3-codex-brain] listening on 127.0.0.1:${PORT} (contract ${CONTRACT_VERSION})`));
