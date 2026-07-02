// v3-pi BRAIN — a resident, OC-UNAWARE HTTP server wrapping the pi coding agent SDK
// (earendil-works/pi, design 011 §5.4/§11.3). Same wire contract as the claude brain:
//   GET  /healthz → 200 { status:"ready", contract_version, busy }
//   POST /turn    → NDJSON: pi's NATIVE AgentSessionEvents, one JSON per line
//                   ({ seq, kind:<event.type>, msg:<event> }), then ONE synthetic
//                   { kind:"result", msg:{ type:"result", usage, num_steps, duration_ms } },
//                   then the terminal { kind:"done", reason:"quiescent"|"awaiting_input"|"error" }.
//   cancel/fence  : the adapter aborts the HTTP request → we abort the pi session.
//   concurrency   : one turn at a time (busy → 409).
//
// The pi session is RESIDENT: held open across turns on a warm box, and persisted as pi's
// native JSONL session tree under state_dir (the host checkpoints the box at turn
// boundaries, so a box recreate resumes from the file — SessionManager.open()).
//
// Tools: pi has NO built-in MCP client, so OC tools ship in this build as a programmatic
// pi extension (DefaultResourceLoader.extensionFactories). read/bash/write are SAME-NAME
// REPLACEMENTS of pi's built-ins (the registry override path — extension tools win by
// .set() over built-ins); say/ask + the platform tools register alongside. Every execute
// calls the adapter's localhost MCP host — the brain performs NO local side effects, and
// pi core never knows. `edit` is deliberately NOT active in the tracer (O6 lands S3b):
// the model edits via write/bash, exactly like the claude brain today.
//
// This file imports NOTHING from ./oc.js — durability/translation live in the adapter.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

// pi SDK — EVERYTHING through pi-coding-agent's surface (§5.4 instance discipline: a second
// pi-ai instance registers providers into a parallel registry the session never sees).
import {
  AuthStorage, ModelRegistry, SessionManager, createAgentSession, DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import { fetch as undiciFetch, EnvHttpProxyAgent } from "undici";

// The box's KEY-SWAPPING egress proxy is env-configured (HTTPS_PROXY + the CA bundle in
// NODE_EXTRA_CA_CERTS). Node's built-in fetch ignores proxy env vars, so pi's model calls
// would go out DIRECT with the sealed placeholder unswapped → provider 401s (hit live on
// the first canary turn). Route ALL fetch through the env proxy; NO_PROXY keeps localhost
// (the adapter's MCP host) direct.
const envProxy = new EnvHttpProxyAgent();
globalThis.fetch = ((input: any, init?: any) => undiciFetch(input, { ...init, dispatcher: envProxy })) as unknown as typeof fetch;

// The SDK path does NOT propagate these itself (CLI-only) — set before any pi call.
process.env.PI_OFFLINE = process.env.PI_OFFLINE ?? "1";
process.env.PI_TELEMETRY = process.env.PI_TELEMETRY ?? "0";
process.env.PI_SKIP_VERSION_CHECK = process.env.PI_SKIP_VERSION_CHECK ?? "1";

const CONTRACT_VERSION = "1";
const PORT = Number(process.env.OC_BRAIN_PORT ?? "8080");

// Active tool set (pi `tools:` allowlist — REQUIRED: names outside pi's default four are
// registered but not exposed to the model unless explicitly activated).
const ACTIVE_TOOLS = [
  "read", "bash", "write", "ls",
  "say", "ask",
  "github_publish_pull_request", "watch_pull_request", "unwatch_pull_request", "add_source",
];

const TOOL_STEERING =
  "Your filesystem and shell are REMOTE (a sandbox reached through your tools) — read/bash/write/ls all operate there, never on a local machine. " +
  "Anything the human should see — progress, findings, and especially your final ANSWER — MUST go through the say tool; your ordinary text output is NOT shown to them. " +
  "Use ask (it pauses your turn until they reply) when you need a decision or missing info. " +
  "Working with GitHub repos: repos are checked out under /workspace/sources/<name> with NO git remote and NO credentials — never use raw git to publish. " +
  "To open a pull request, edit files under /workspace/sources/<name> and call github_publish_pull_request with that source name. " +
  "To start working in another repo, call add_source. After opening a PR, call watch_pull_request to be woken when something happens on it (it does not block — finish your turn after calling it).";

interface TurnConfig {
  model?: string;
  system_prompt?: string;
  mcp_endpoint?: string;
  resume?: boolean;         // advisory; the server self-decides from its own session file
  state_dir?: string;
  max_turns?: number;
  deadline_s?: number;
  endpoint_profile?: { mode?: string; base_url?: string; auth_env?: string };
}
interface TurnRequest {
  contract_version?: string;
  turn_id?: string;
  input?: Array<{ role?: string; content?: string }>;
  config?: TurnConfig;
}

let busy = false;

// ── MCP client (per tool call, stateless — mirrors the host's per-request transport) ──

async function mcpCall(endpoint: string, name: string, args: Record<string, unknown>): Promise<string> {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  const client = new Client({ name: "pi-brain", version: "0.0.1" });
  await client.connect(transport);
  try {
    const r = (await client.callTool({ name, arguments: args })) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
    const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (r.isError) throw new Error(text || `tool ${name} failed`);
    return text;
  } finally {
    await client.close().catch(() => {});
  }
}

// ── The OC extension (programmatic; registered via extensionFactories) ─────────────────

// Mutable per-turn wiring the tools close over. mcp_endpoint is turn-invariant per box
// (contract), but we refresh it every turn anyway; `awaiting` is reset per turn.
// skillsDir: pi's skill announcement points the model at BRAIN-local SKILL.md paths
// (agentskills.io progressive disclosure = the model READS the skill body via its read
// tool) — but our read tool is remoted to the hands box, where skills don't exist. The
// read tool serves paths under the skills dir from the brain's own fs (hit live: leg F).
const bridge = { mcpEndpoint: "", awaiting: false, skillsDir: "" };

function ocExtension(pi: ExtensionAPI): void {
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} as Record<never, never> });
  const remote = (name: string) => async (_id: string, params: Record<string, unknown>): Promise<ReturnType<typeof text>> =>
    text(await mcpCall(bridge.mcpEndpoint, name, params));

  // Same-name replacements of pi built-ins (read/bash/write) + ls: all proxy to the hands
  // box via the MCP host. Tool/exec/message EVENTS are emitted by the host, not here.
  pi.registerTool({
    name: "bash", label: "bash (remote sandbox)",
    description: "Run a shell command in your remote sandbox — the ONLY place commands run. Returns exit code + stdout/stderr.",
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    execute: remote("bash"),
  });
  pi.registerTool({
    name: "read", label: "read (remote sandbox)",
    description: "Read a file from the remote sandbox (skill files resolve locally).",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, params: { path: string }) => {
      const p = resolvePath(params.path);
      if (bridge.skillsDir && (p === bridge.skillsDir || p.startsWith(bridge.skillsDir + "/"))) {
        return text(readFileSync(p, "utf8"));
      }
      return text(await mcpCall(bridge.mcpEndpoint, "read", params));
    },
  });
  pi.registerTool({
    name: "write", label: "write (remote sandbox)",
    description: "Create or overwrite a file in the remote sandbox (parent dirs created).",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: remote("write"),
  });
  pi.registerTool({
    name: "ls", label: "ls (remote sandbox)",
    description: "List a directory in the remote sandbox.",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    execute: remote("ls"),
  });

  pi.registerTool({
    name: "say", label: "say",
    description: "Say something to the human you're working with — a deliberate, user-facing message (a finding, a summary, your final ANSWER). Your ordinary output is NOT shown to them. Markdown ok.",
    parameters: Type.Object({ text: Type.String() }),
    execute: remote("say"),
  });
  pi.registerTool({
    name: "ask", label: "ask",
    description: "Ask the human a question and PAUSE. Use only when you need a decision or missing info you cannot safely assume. Your turn ends now and resumes when they reply.",
    parameters: Type.Object({ text: Type.String() }),
    // Stop-after-ask (F9): pi's loop would otherwise continue past the tool result. The
    // agent loop RECORDS the tool result (and emits tool_execution_end) BEFORE it checks
    // the abort signal, so ctx.abort() here ends the turn with the ask durably recorded;
    // session.prompt() then RESOLVES (an aborted turn is not an error).
    execute: async (_id, params: { text: string }, _signal, _onUpdate, ctx) => {
      const out = await mcpCall(bridge.mcpEndpoint, "ask", params);
      bridge.awaiting = true;
      ctx.abort();
      return text(out);
    },
  });

  pi.registerTool({
    name: "github_publish_pull_request", label: "publish PR",
    description: "Open a GitHub pull request from your changes to a checked-out repo. The platform commits your edits to a fresh branch and opens the PR — you never handle git or tokens. Call AFTER you've made and verified your edits under /workspace/sources/<source>. Returns the PR URL.",
    parameters: Type.Object({ source: Type.String(), title: Type.String(), body: Type.Optional(Type.String()), base: Type.Optional(Type.String()), draft: Type.Optional(Type.Boolean()) }),
    execute: remote("github_publish_pull_request"),
  });
  pi.registerTool({
    name: "watch_pull_request", label: "watch PR",
    description: "Get notified when something happens on a PR you opened — CI finishes, a review or comment lands, or it merges. Your session is woken with the event. Does NOT block: call it, then finish your turn.",
    parameters: Type.Object({ wake_on: Type.Optional(Type.String()), repo: Type.Optional(Type.String()), pr: Type.Optional(Type.Number()), intent: Type.Optional(Type.String()) }),
    execute: remote("watch_pull_request"),
  });
  pi.registerTool({
    name: "unwatch_pull_request", label: "unwatch PR",
    description: "Stop watching a PR you previously subscribed to.",
    parameters: Type.Object({ repo: Type.Optional(Type.String()), pr: Type.Optional(Type.Number()) }),
    execute: remote("unwatch_pull_request"),
  });
  pi.registerTool({
    name: "add_source", label: "add source",
    description: "Check out an ADDITIONAL GitHub repo into your workspace under /workspace/sources/<name> so you can edit it and open PRs. Only repos the OpenComputer App is installed on can be added.",
    parameters: Type.Object({ repo: Type.String(), ref: Type.String(), name: Type.Optional(Type.String()) }),
    execute: remote("add_source"),
  });
}

// ── Resident session (config-invariant per box; recreate only if identity changes) ─────

let resident: { session: AgentSession; key: string } | null = null;

function newestSessionFile(sessionDir: string): string | null {
  try {
    const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).sort();
    return files.length ? join(sessionDir, files[files.length - 1]) : null;
  } catch { return null; }
}

async function ensureSession(cfg: TurnConfig): Promise<AgentSession> {
  const stateDir = cfg.state_dir ?? join(process.env.HOME ?? "/home/sandbox", ".oc/runtime-state");
  const managed = cfg.endpoint_profile?.mode === "managed";
  const key = JSON.stringify([stateDir, cfg.model, cfg.mcp_endpoint, managed, cfg.endpoint_profile?.base_url]);
  if (resident && resident.key === key) return resident.session;
  if (resident) { resident.session.dispose?.(); resident = null; }

  const agentDir = join(stateDir, "pi");
  const cwd = join(stateDir, "journal");          // skills materialize at <cwd>/.agents/skills
  const sessionDir = join(agentDir, "sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  bridge.skillsDir = resolvePath(cwd, ".agents", "skills");

  // Model route. BYO: extend pi's built-in anthropic provider with the exact configured id
  // (models.json entries MERGE into the catalog → correct base URL + dialect even for ids
  // the shipped catalog doesn't know); the sealed ANTHROPIC_API_KEY is swapped by the host
  // egress proxy on the outbound call. Managed: a custom provider at the profile's base_url
  // (anthropic-messages dialect at OpenRouter's Claude path) keyed by the sealed auth-env.
  const rawModel = cfg.model ?? "anthropic/claude-opus-4-8";
  const provider = managed ? "oc-managed" : "anthropic";
  const modelId = managed ? rawModel : rawModel.replace(/^anthropic\//, "");
  const providers: Record<string, unknown> = {
    anthropic: { models: [{ id: modelId, name: modelId, contextWindow: 200000, maxTokens: 32000 }] },
  };
  if (managed) {
    providers["oc-managed"] = {
      name: "oc-managed",
      baseUrl: cfg.endpoint_profile?.base_url,
      api: "anthropic-messages",
      apiKey: `$${cfg.endpoint_profile?.auth_env ?? "ANTHROPIC_AUTH_TOKEN"}`,
      models: [{ id: modelId, name: modelId, contextWindow: 200000, maxTokens: 32000 }],
    };
  }
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers }, null, 2));

  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  // The env var carries the SEALED value; pi resolves runtime overrides first, so this is
  // the injection point either way. Non-empty placeholder keeps request construction sane.
  authStorage.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY ?? "sealed");
  const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  const model = modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`model '${provider}/${modelId}' did not resolve from models.json`);

  const loader = new DefaultResourceLoader({
    cwd, agentDir,
    extensionFactories: [ocExtension],
    // APPEND to pi's native system prompt (which documents the active tools + skills) —
    // replacing it would strip pi's own tool guidance.
    appendSystemPromptOverride: (base) => [...base, cfg.system_prompt ?? "You are a helpful background agent.", TOOL_STEERING],
  });
  await loader.reload();

  const prior = newestSessionFile(sessionDir);
  const sessionManager = prior ? SessionManager.open(prior) : SessionManager.create(cwd, sessionDir);

  const { session } = await createAgentSession({
    cwd, agentDir, authStorage, modelRegistry, model,
    resourceLoader: loader,
    sessionManager,
    tools: ACTIVE_TOOLS,
  });
  resident = { session, key };
  return session;
}

// ── HTTP plumbing ───────────────────────────────────────────────────────────────────────

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
  const prompt = (body.input ?? []).map((m) => m.content ?? "").filter(Boolean).join("\n\n") || "(no new input)";

  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  busy = true;
  bridge.mcpEndpoint = cfg.mcp_endpoint ?? bridge.mcpEndpoint;
  bridge.awaiting = false;

  let seq = 0;
  let clientGone = false;
  const t0 = Date.now();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let numSteps = 0;
  let errorMessage: string | undefined;
  let unsubscribe: (() => void) | undefined;

  try {
    const session = await ensureSession(cfg);
    req.on("close", () => {
      if (!res.writableEnded) { clientGone = true; void session.abort(); }
    });

    unsubscribe = session.subscribe((e: any) => {
      writeLine(res, { seq: seq++, kind: e?.type, msg: e });
      if (e?.type === "message_end" && e.message?.role === "assistant") {
        numSteps++;
        const u = e.message.usage ?? {};
        usage.input += u.input ?? 0; usage.output += u.output ?? 0;
        usage.cacheRead += u.cacheRead ?? 0; usage.cacheWrite += u.cacheWrite ?? 0;
        if (e.message.stopReason === "error" && e.message.errorMessage) errorMessage = e.message.errorMessage;
      }
    });

    // Aborts (fence, stop-after-ask) RESOLVE prompt() — pi records an assistant message
    // with stopReason:"aborted" instead of rejecting.
    await session.prompt(prompt);

    writeLine(res, { kind: "result", msg: { type: "result", usage, num_steps: numSteps, duration_ms: Date.now() - t0, is_error: Boolean(errorMessage) } });
    if (errorMessage) {
      writeLine(res, { kind: "done", reason: "error", error: { type: "model_error", message: errorMessage } });
    } else {
      writeLine(res, { kind: "done", reason: bridge.awaiting ? "awaiting_input" : "quiescent" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeLine(res, { kind: "done", reason: "error", error: { type: clientGone ? "aborted" : "turn_failed", message } });
  } finally {
    unsubscribe?.();
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

server.listen(PORT, "127.0.0.1", () => console.log(`[v3-pi-brain] listening on 127.0.0.1:${PORT} (contract ${CONTRACT_VERSION})`));
