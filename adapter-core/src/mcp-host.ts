// The adapter-hosted MCP server (runtime.md §3.3 "MCP hands", R4 interim).
//
// The reshaped brain (server.ts) is OC-unaware: it gets its tools from an EXTERNAL
// MCP server over localhost HTTP (McpHttpServerConfig), NOT an in-process SDK server.
// The adapter hosts that server here. v1 = the adapter PROXIES the tools to the OC
// sandbox (R4: "adapter-proxies the sandbox" interim, vs a first-class OC sandbox MCP
// server). The tool set is byte-identical to the legacy in-process oc-tools.ts:
//   bash / read / write / ls  → proxy to the remote hands box (turn-token authed)
//   say / ask                 → user-facing OC events via the durable emitter
//
// say/ask append through the SAME DurableEmitter as the turn-stream translator, so the
// adapter stays the single ordered writer (§3.5). The brain owns "ask pauses the turn"
// (it ends the stream awaiting_input); the host reads needs_input from the awaiting_input
// marker on the event this appends (turn.ts:359).
//
// Transport: stateless StreamableHTTPServerTransport with JSON responses (no SSE) — the
// simplest framing for a single-client server-to-server pipe (R7). A fresh server +
// transport per request avoids cross-request id collisions.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config } from "./oc.js";
import type { DurableEmitter } from "./emitter.js";

const MCP_PATH = "/mcp";

const TOOLS_COMING_SOON =
  "Remote sandbox tools are not available in this runtime version yet. " +
  "Answer from what you know and your conversation; do not attempt local file or shell access.";

// Mutable per-turn signals the adapter reads after the stream ends.
export interface HostContext {
  sawUserFacing: boolean;   // did say/ask run? (gates the safety-net answer)
  awaitingInput: boolean;   // did ask run? (belt-and-suspenders vs the brain's done:awaiting_input)
}

// Proxy a tool to the remote hands box (NEVER local exec). Mirrors oc-tools.ts: probe;
// a 404 means the hands endpoints aren't live yet → a clear coming-soon error.
async function sandboxCall(op: string, body: unknown): Promise<any> {
  try {
    const r = await fetch(`${config.apiUrl}/v3/sessions/${config.sessionId}/sandbox/${op}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Turn-Token": config.turnToken, "ngrok-skip-browser-warning": "1" },
      body: JSON.stringify(body),
    });
    if (r.status === 404) return { error: TOOLS_COMING_SOON };
    if (!r.ok) return { error: `sandbox ${op}: HTTP ${r.status}` };
    return r.json();
  } catch (err) {
    return { error: `sandbox ${op} unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

// POST a platform ACTION (github publish / add_source) with the turn token. Unlike sandboxCall
// these hit /v3/sessions/:id/actions/* — the platform holds the GitHub App key + runs the
// isolated repo-op, so the git token never reaches the agent (zero-secret). Op errors come back
// as {error} at HTTP 200; only auth failures are non-2xx.
async function apiPost(path: string, body: unknown): Promise<any> {
  try {
    const r = await fetch(`${config.apiUrl}/v3/sessions/${config.sessionId}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Turn-Token": config.turnToken, "ngrok-skip-browser-warning": "1" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { error: `${path}: HTTP ${r.status}` };
    return r.json();
  } catch (err) {
    return { error: `${path} unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function makeServer(emitter: DurableEmitter, ctx: HostContext, tools?: string[]): McpServer {
  const server = new McpServer({ name: "oc", version: "0.0.1" });
  // Per-runtime tool subset (undefined = all): ends the copy-drift where a lagging runtime
  // was missing newer platform tools — one host, explicit subsets.
  const registerTool: typeof server.registerTool = ((name: string, def: never, handler: never) => {
    if (tools && !tools.includes(name)) return undefined as never;
    return server.registerTool(name as never, def as never, handler as never);
  }) as typeof server.registerTool;

  registerTool(
    "bash",
    { description: "Run a shell command in your remote sandbox — the ONLY place commands run. Returns exit code + stdout/stderr.", inputSchema: { command: z.string(), timeout: z.number().optional() } },
    async (a) => {
      await emitter.emit({ type: "tool.call", level: "progress", body: { tool: "bash", args_summary: a.command.slice(0, 200) } });
      const r = await sandboxCall("exec", { command: a.command, timeout: a.timeout });
      if (r.error) return text(r.error, true);
      await emitter.emit({ type: "exec.completed", level: "progress", body: { command: a.command.slice(0, 200), exit_code: r.exitCode, summary: String(r.stdout ?? "").slice(0, 400) } });
      return text(`exit ${r.exitCode}\n${r.stdout ?? ""}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`);
    },
  );

  registerTool(
    "read",
    { description: "Read a file from the remote sandbox.", inputSchema: { path: z.string() } },
    async (a) => {
      const r = await sandboxCall("read", { path: a.path });
      return text(r.content ?? r.error ?? "", Boolean(r.error));
    },
  );

  registerTool(
    "write",
    { description: "Create or overwrite a file in the remote sandbox (parent dirs created).", inputSchema: { path: z.string(), content: z.string() } },
    async (a) => {
      const r = await sandboxCall("write", { path: a.path, content: a.content });
      return text(r.error ?? `wrote ${a.path}`, Boolean(r.error));
    },
  );

  registerTool(
    "ls",
    { description: "List a directory in the remote sandbox.", inputSchema: { path: z.string().optional() } },
    async (a) => {
      const r = await sandboxCall("ls", { path: a.path });
      return text(r.error ?? JSON.stringify(r.entries), Boolean(r.error));
    },
  );

  registerTool(
    "say",
    { description: "Say something to the human you're working with — a deliberate, user-facing message (a finding, a summary, your final ANSWER). Your ordinary reasoning is NOT shown to them. Markdown ok.", inputSchema: { text: z.string() } },
    async (a) => {
      await emitter.emit({ type: "agent.message", level: "user", body: { text: a.text } });
      ctx.sawUserFacing = true;
      return text("said");
    },
  );

  registerTool(
    "ask",
    { description: "Ask the human a question and PAUSE. Use only when you need a decision or missing info you cannot safely assume. After calling ask, STOP — your turn ends now and resumes when they reply.", inputSchema: { text: z.string() } },
    async (a) => {
      await emitter.emit({ type: "agent.message", level: "user", body: { text: a.text, awaiting_input: true } });
      ctx.sawUserFacing = true;
      ctx.awaitingInput = true;
      return text("asked — turn paused for the human's reply");
    },
  );

  // Open a PR from the agent's edits to a checked-out source. The platform commits to a fresh
  // oc/<session>/<source> branch + opens the PR with a minted write token — the agent NEVER
  // handles git credentials (zero-secret). Only the outcome comes back.
  registerTool(
    "github_publish_pull_request",
    { description: "Open a GitHub pull request from your changes to a checked-out repo. The platform commits your edits to a fresh branch and opens the PR for you — you never handle git or tokens. Call this AFTER you've made and verified your edits under /workspace/sources/<source>. Returns the PR URL.",
      inputSchema: { source: z.string(), title: z.string(), body: z.string().optional(), base: z.string().optional(), draft: z.boolean().optional() } },
    async (a) => {
      await emitter.emit({ type: "tool.call", level: "progress", body: { tool: "github.publish_pull_request", args_summary: `${a.source}: ${a.title}`.slice(0, 200) } });
      // Stable idempotency key from turn+source+title so a runtime retry doesn't open a 2nd PR.
      const idempotencyKey = `pub:${config.turnId}:${a.source}:${createHash("sha256").update(a.title).digest("hex").slice(0, 12)}`;
      const r = await apiPost("actions/publish", { source: a.source, title: a.title, body: a.body ?? "", kind: "publish_pull_request", baseRef: a.base, draft: a.draft, idempotencyKey });
      if (r.status === "in_progress") {
        const msg = `A publish for "${a.source}" is already in progress — it will finish shortly; no need to retry.`;
        await emitter.emit({ type: "agent.message", level: "user", body: { text: msg } });
        ctx.sawUserFacing = true;
        return text(msg);
      }
      if (r.error) return text(r.error, true);
      const msg = r.noChanges
        ? `No changes to publish in "${a.source}" — nothing was opened.`
        : r.prUrl
          ? `Opened pull request: ${r.prUrl} (branch ${r.branch}).`
          : `Pushed branch ${r.branch}${r.commitSha ? ` (commit ${String(r.commitSha).slice(0, 10)})` : ""}.`;
      await emitter.emit({ type: "agent.message", level: "user", body: { text: msg } });
      ctx.sawUserFacing = true;
      return text(msg);
    },
  );

  // Subscribe to events on a PR the session opened — the session WAKES with the event so the
  // agent can react (checks finish, review/comment lands, merge). A durable wake trigger, not a
  // blocking wait: after calling this the agent can finish its turn normally.
  registerTool(
    "watch_pull_request",
    { description: "Get notified when something happens on a PR you opened — CI finishes, a review or comment lands, or it merges. Your session will be woken with the event so you can react (e.g. fix a failing check, address a comment). This does NOT block: call it after opening a PR, then finish your turn; you'll be resumed when the event fires. Defaults to the PR you most recently opened in this session.",
      inputSchema: {
        wake_on: z.enum(["checks", "review", "comment", "merge"]).optional()
          .describe("The wake condition: checks (CI finished, default), review (a review decision), comment (a new comment), or merge (the PR merged/closed)."),
        repo: z.string().optional().describe('Only if you opened PRs in more than one repo: "owner/repo".'),
        pr: z.number().optional().describe("Only if you opened more than one PR: the PR number."),
        intent: z.string().optional().describe("A short note on why you're watching, replayed to you when it wakes you."),
      } },
    async (a) => {
      await emitter.emit({ type: "tool.call", level: "progress", body: { tool: "watch_pull_request", args_summary: `${a.wake_on ?? "checks"} ${a.repo ?? ""}${a.pr ? "#" + a.pr : ""}`.slice(0, 200) } });
      const r = await apiPost("actions/watch", { wake_on: a.wake_on, repo: a.repo, pr: a.pr, intent: a.intent });
      if (r.error) return text(r.error, true);
      const w = r.watch;
      const msg = `Watching ${w.repo}#${w.pr} — I'll be woken on ${w.wake_on}. No need to poll.`;
      await emitter.emit({ type: "agent.message", level: "progress", body: { text: msg } });
      return text(msg);
    },
  );

  registerTool(
    "unwatch_pull_request",
    { description: "Stop watching a PR you previously subscribed to. Defaults to your only active watch; pass repo/pr if you have several.",
      inputSchema: { repo: z.string().optional(), pr: z.number().optional() } },
    async (a) => {
      const r = await apiPost("actions/unwatch", { repo: a.repo, pr: a.pr });
      if (r.error) return text(r.error, true);
      return text(r.ok ? "Stopped watching." : "No matching watch to stop.");
    },
  );

  // Check out an ADDITIONAL working repo mid-run. Same zero-secret contract as publish: the
  // platform clones it into /workspace/sources/<name> via an isolated repo-op; no token reaches
  // the agent. oc_app repos only.
  registerTool(
    "add_source",
    { description: "Check out an ADDITIONAL GitHub repo into your workspace so you can read or edit it and open PRs from it. The platform clones it under /workspace/sources/<name> — you never handle git or tokens. Use this when your task needs a repo that isn't already checked out. Only repos the OpenComputer App is installed on can be added.",
      inputSchema: { repo: z.string(), ref: z.string(), name: z.string().optional() } },
    async (a) => {
      await emitter.emit({ type: "tool.call", level: "progress", body: { tool: "add_source", args_summary: `${a.repo}@${a.ref}`.slice(0, 200) } });
      const r = await apiPost("actions/add_source", { repo: a.repo, ref: a.ref, name: a.name });
      if (r.error) return text(r.error, true);
      const msg = `Checked out ${a.repo}@${a.ref} at /workspace/sources/${r.name} (commit ${String(r.sha).slice(0, 10)}). Edit it and open a PR with github_publish_pull_request (source: "${r.name}").`;
      await emitter.emit({ type: "agent.message", level: "progress", body: { text: msg } });
      return text(msg);
    },
  );

  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * Start the localhost MCP server. Binds 127.0.0.1 on `port` (a STABLE port, not random):
 * the brain is resident across turns and may pin the MCP URL from its first turn, so each
 * per-turn adapter must serve the SAME URL — a random port per turn would leave the
 * resident brain pointing at a dead port on turn 2 (tools hang). Falls back to an
 * OS-assigned port if the stable one is busy (a lingering prior adapter — degraded but
 * the turn still runs). Returns the URL to hand the brain as config.mcp_endpoint.
 */
export function startMcpHost(emitter: DurableEmitter, ctx: HostContext, port = 0, tools?: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (!req.url || !req.url.startsWith(MCP_PATH)) { res.writeHead(404); res.end(); return; }
    void (async () => {
      // Fresh MCP server + transport per request (stateless): no session id, no SSE,
      // single JSON response. Concurrency-safe even though our one client is sequential.
      const mcp = makeServer(emitter, ctx, tools);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void mcp.close(); });
      try {
        await mcp.connect(transport);
        const body = req.method === "POST" ? await readBody(req) : undefined;
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json" }); }
        if (!res.writableEnded) res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: err instanceof Error ? err.message : String(err) }, id: null }));
      }
    })();
  });

  const onListening = (resolve: (v: { url: string; close: () => Promise<void> }) => void) => {
    const addr = server.address();
    const bound = typeof addr === "object" && addr ? addr.port : 0;
    if (bound !== port) console.error(`[mcp-host] requested port ${port} unavailable; bound ${bound} (degraded — resident brain may have pinned the stable URL)`);
    resolve({ url: `http://127.0.0.1:${bound}${MCP_PATH}`, close: () => new Promise<void>((r) => server.close(() => r())) });
  };
  return new Promise((resolve) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && port !== 0) { server.listen(0, "127.0.0.1", () => onListening(resolve)); }
      else throw err;
    });
    server.listen(port, "127.0.0.1", () => onListening(resolve));
  });
}
