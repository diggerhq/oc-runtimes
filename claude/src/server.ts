// v3-claude BRAIN — the reshaped runtime (runtime.md §3). A resident, OC-UNAWARE
// HTTP server wrapping the Claude Agent SDK. It knows its SDK, MCP (tools), a model
// base-URL, and a state dir — and NOTHING about OpenComputer. The platform-provided
// ADAPTER (adapter.ts, separate process) drives turns over localhost and owns all
// OC-awareness (events API, taxonomy, idempotency, fencing, durability).
//
// Contract (runtime.md §3.7c), PRIVATE E1 for now:
//   GET  /healthz → 200 { status:"ready", contract_version, busy }
//   POST /turn    → NDJSON stream of the SDK's NATIVE messages, one JSON per line:
//                   { seq, kind:<msg.type>, msg }… then a terminal
//                   { kind:"done", reason:"quiescent"|"awaiting_input"|"error", error? }
//   request body: { contract_version, turn_id, input:[{role,content}], config:{ model,
//                   system_prompt, mcp_endpoint, resume, state_dir, max_turns?, deadline_s? } }
//   cancel/fence  : the adapter aborts the HTTP request → we abort the SDK query (§3.7b).
//   concurrency   : one turn at a time (busy → 409).
//
// This file imports NOTHING from ./oc.js — durability/translation live in the adapter.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

/** True when the materialized skills dir (a symlink → versioned dir) holds at least one entry. */
function hasSkillEntries(dir: string | undefined): boolean {
  if (!dir) return false;
  try { return readdirSync(dir).length > 0; } catch { return false; }
}

const CONTRACT_VERSION = "1";
const PORT = Number(process.env.OC_BRAIN_PORT ?? "8080");
const ALLOWED_TOOLS = ["mcp__oc__bash", "mcp__oc__read", "mcp__oc__write", "mcp__oc__ls", "mcp__oc__say", "mcp__oc__ask", "mcp__oc__github_publish_pull_request", "mcp__oc__add_source", "mcp__oc__watch_pull_request", "mcp__oc__unwatch_pull_request"];
const DISALLOWED_TOOLS = ["Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task"];

const TOOL_STEERING =
  "Your filesystem and shell are REMOTE. Use ONLY the mcp__oc__ tools: " +
  "mcp__oc__bash (shell), mcp__oc__read / mcp__oc__write (files), mcp__oc__ls. " +
  "The built-in Bash/Read/Write/Edit are unavailable; there is no local filesystem. " +
  "Anything the human should see — progress, findings, and especially your final ANSWER — MUST go through mcp__oc__say. " +
  "Use mcp__oc__ask (it pauses your turn until they reply) when you need a decision or missing info. " +
  "Working with GitHub repos: repos are checked out under /workspace/sources/<name> with NO git remote and NO credentials — `git push`, `git remote`, and manual branch/PR pushes WILL fail, so never use raw git to publish. To open a pull request, edit files under /workspace/sources/<name> and then call mcp__oc__github_publish_pull_request with that source name; it commits your changes to a fresh branch and opens the PR for you (you never handle git or tokens). To start working in another repo, call mcp__oc__add_source. After you open a PR, if you want to react to what happens on it (CI failing, a review or comment, a merge), call mcp__oc__watch_pull_request — you'll be woken with the event; it does not block, so finish your turn after calling it.";

interface TurnConfig {
  model?: string;
  system_prompt?: string;
  mcp_endpoint?: string;   // external MCP server (adapter-hosted): the hands + say/ask
  resume?: boolean;        // --continue the on-box journal
  state_dir?: string;      // OC_RUNTIME_STATE_DIR; journal lives under it
  max_turns?: number;
  deadline_s?: number;
  // Managed model access (token-billing §5.2): non-secret routing. mode:"managed"
  // → point the SDK at OpenRouter (base_url …/api, auth via the sealed
  // ANTHROPIC_AUTH_TOKEN). Absent / mode:"byo" → the direct Anthropic api-key path.
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
  // BYO strips the anthropic/ prefix (Anthropic's real id is dashed: claude-opus-4-8).
  // Managed keeps the full OpenRouter slug — the adapter already sent the dotted OR slug
  // (anthropic/claude-opus-4.8) and OR requires the provider prefix.
  const model = managed
    ? (cfg.model ?? "anthropic/claude-opus-4-8")
    : (cfg.model ?? "anthropic/claude-opus-4-8").replace(/^anthropic\//, "");
  const stateDir = cfg.state_dir ?? join(process.env.HOME ?? "/home/sandbox", ".oc/runtime-state");
  const cwd = join(stateDir, "journal");
  mkdirSync(cwd, { recursive: true });
  const prompt = (body.input ?? []).map((m) => m.content ?? "").filter(Boolean).join("\n\n") || "(no new input)";

  // The brain calls the model directly; the sealed key is swapped by the host egress
  // proxy on the outbound HTTPS call. Two paths (token-billing §5.2):
  //   BYO     → direct Anthropic, api-key auth (delete AUTH_TOKEN + BASE_URL).
  //   Managed → OpenRouter's Claude-Code path: set ANTHROPIC_BASE_URL=…/api and keep
  //             the sealed ANTHROPIC_AUTH_TOKEN (Bearer); the proxy swaps it on the
  //             call to openrouter.ai.
  const childEnv: Record<string, string | undefined> = { ...process.env };
  if (managed && cfg.endpoint_profile?.base_url) {
    childEnv.ANTHROPIC_BASE_URL = cfg.endpoint_profile.base_url;
    delete childEnv.ANTHROPIC_API_KEY; // force the auth-token path, not a stray api key
    // keep the sealed ANTHROPIC_AUTH_TOKEN in the env
  } else {
    delete childEnv.ANTHROPIC_AUTH_TOKEN;   // force the api-key path
    delete childEnv.ANTHROPIC_BASE_URL;     // SDK → api.anthropic.com (proxied)
  }
  childEnv.CLAUDE_CODE_MAX_RETRIES = process.env.CLAUDE_CODE_MAX_RETRIES ?? "2";
  childEnv.API_TIMEOUT_MS = process.env.API_TIMEOUT_MS ?? "120000";

  // Tools come from an EXTERNAL MCP server the adapter hosts (decoupling: the brain
  // never calls OC's sandbox API). HTTP transport (R7). The SDK supports external MCP
  // (McpHttpServerConfig). Without an endpoint the turn runs tool-less (degraded).
  // alwaysLoad: tools are present from turn 1, never deferred behind tool search —
  // matches the legacy in-process (type:"sdk") behavior, so the event log stays
  // byte-equivalent (no "let me fetch the tool schema" round-trip) and the localhost
  // connect is instant.
  const mcpServers: Record<string, { type: "http"; url: string; alwaysLoad: boolean }> = {};
  if (cfg.mcp_endpoint) mcpServers.oc = { type: "http", url: cfg.mcp_endpoint, alwaysLoad: true };

  // Agent Revisions skills (design 009 §8.2): the adapter materializes the session's skill bundle
  // into OC_SKILLS_DIR (= <cwd>/.claude/skills). The Claude Agent SDK discovers skills there only
  // when settingSources includes "project"; we opt in ONLY when skills are actually present, so a
  // no-skills turn keeps the original empty settingSources (no behavior change). NOTE: the SDK
  // skills-load mechanism is the one S3 item to confirm on a live snapshot build (009 §19.2).
  const skillsActive = hasSkillEntries(process.env.OC_SKILLS_DIR);
  const settingSources: Array<"project"> = skillsActive ? ["project"] : [];

  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  busy = true;
  let seq = 0;
  let awaiting = false;
  const ac = new AbortController();
  // Adapter aborts the request to cancel/fence (§3.7b) → abort the SDK query.
  req.on("close", () => { if (!res.writableEnded) ac.abort(); });

  try {
    const q = query({
      prompt,
      options: {
        model,
        cwd,
        continue: Boolean(cfg.resume),
        settingSources,
        systemPrompt: { type: "preset", preset: "claude_code", append: `${cfg.system_prompt ?? "You are a helpful background agent."}\n\n${TOOL_STEERING}` },
        permissionMode: "bypassPermissions",
        allowedTools: ALLOWED_TOOLS,
        disallowedTools: DISALLOWED_TOOLS,
        mcpServers,
        maxTurns: cfg.max_turns ?? 24,
        env: childEnv,
        abortController: ac,
      },
    });
    // `ask` is a user-facing tool that PAUSES the turn. With tools on an external MCP
    // server, we must let the SDK actually RUN the ask tool (it appends the question +
    // pauses) before ending the turn — so we break only after the ask tool's RESULT
    // appears (a user message with its tool_result), never on the tool_use alone.
    // Mirrors index.ts's break-after-result timing.
    const askIds = new Set<string>();
    for await (const msg of q) {
      // Stream the SDK's NATIVE message verbatim — the adapter translates it to the OC
      // taxonomy + appends durably. The brain emits no OC events.
      writeLine(res, { seq: seq++, kind: (msg as { type?: string }).type, msg });
      const m = msg as { type?: string; message?: { content?: Array<{ type?: string; name?: string; id?: string; tool_use_id?: string }> } };
      if (m.type === "assistant") {
        for (const b of m.message?.content ?? []) if (b.type === "tool_use" && b.name === "mcp__oc__ask" && b.id) askIds.add(b.id);
      } else if (m.type === "user") {
        for (const b of m.message?.content ?? []) if (b.type === "tool_result" && b.tool_use_id && askIds.has(b.tool_use_id)) awaiting = true;
      }
      if (awaiting) break;
    }
    writeLine(res, { kind: "done", reason: awaiting ? "awaiting_input" : "quiescent" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (ac.signal.aborted) { writeLine(res, { kind: "done", reason: "error", error: { type: "aborted", message } }); }
    else { writeLine(res, { kind: "done", reason: "error", error: { type: "turn_failed", message } }); }
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

server.listen(PORT, "127.0.0.1", () => console.log(`[v3-claude-brain] listening on 127.0.0.1:${PORT} (contract ${CONTRACT_VERSION})`));
