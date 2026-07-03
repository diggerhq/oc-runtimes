// serveOC(agent) — the session's resident brain (design 012 §11.4). Implements the
// standard brain contract (011 §11): GET /healthz {status,contract_version,busy};
// POST /turn → NDJSON steps + terminal done. One turn stream at a time. The §11.9 rules
// live in flue-glue; this file is transport + the R1 rule: a closing socket DETACHES the
// subscriber and never aborts the engine.

import { createServer, type ServerResponse } from "node:http";
import { installProxyFetch } from "./proxy.js";
import { activeTurn, mcpPing } from "./mcp-client.js";
import {
  attachTurn, engineBusy, OrphanWedgedError,
  type AgentDefinitionLike, type TurnRequest, type ForwardedEvent,
} from "./flue-glue.js";

const CONTRACT_VERSION = "1";
export const PROFILE_VERSION = 1;

interface DescribeOutput {
  model: string | null;
  profile_version: number;
  tools: string[];
}

async function describe(agent: AgentDefinitionLike): Promise<DescribeOutput> {
  const cfg = (await agent.initialize({ id: "describe", env: process.env })) as {
    model?: string;
    tools?: Array<{ name?: string }>;
  };
  return {
    model: cfg.model ?? null,
    profile_version: PROFILE_VERSION,
    tools: (cfg.tools ?? []).map((t) => t.name ?? "").filter(Boolean),
  };
}

function writeLine(res: ServerResponse, obj: unknown): boolean {
  return res.write(JSON.stringify(obj) + "\n");
}

export function serveOC(agent: AgentDefinitionLike): void {
  if (!agent || (agent as { __flueAgentDefinition?: boolean }).__flueAgentDefinition !== true) {
    throw new Error("serveOC(agent): pass the default export of a defineAgent(...) module");
  }

  // --describe: print the extracted manifest and exit without binding (deploy-triangle input).
  if (process.argv.includes("--describe")) {
    void describe(agent).then(
      (d) => {
        process.stdout.write(JSON.stringify(d) + "\n");
        process.exit(0);
      },
      (err) => {
        process.stderr.write(`describe failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      },
    );
    return;
  }

  installProxyFetch();
  const port = Number(process.env.OC_BRAIN_PORT ?? "8080");
  // The single-live-subscriber slot. A DETACHED handler releases it immediately (R1: the
  // socket is gone, the engine keeps running) so a re-attaching attempt is never 409'd
  // into waiting out the whole run it is trying to re-attach to.
  let activeStream: symbol | null = null;
  let seq = 0;

  const srv = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url?.startsWith("/healthz")) {
        const busy = activeStream !== null || (await engineBusy());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ready", contract_version: CONTRACT_VERSION, busy }));
        return;
      }
      if (req.method !== "POST" || !req.url?.startsWith("/turn")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "not_found" } }));
        return;
      }
      if (activeStream !== null) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "busy", message: "a turn is already streaming" } }));
        return;
      }

      let body = "";
      req.on("data", (c) => (body += c));
      await new Promise((r) => req.on("end", r));
      let turn: TurnRequest & { contract_version?: string };
      try {
        turn = JSON.parse(body) as never;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "bad_request", message: "invalid JSON" } }));
        return;
      }
      if (turn.contract_version !== CONTRACT_VERSION) {
        res.writeHead(426, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "contract_mismatch", expected: CONTRACT_VERSION } }));
        return;
      }

      const me = Symbol("turn-stream");
      activeStream = me;
      const release = (): void => {
        if (activeStream === me) activeStream = null;
      };
      // R1: socket close = subscriber detached, engine untouched. Stop writing AND free the
      // slot — the next attempt re-attaches (or drains) through the R3 protocol. The hook is
      // on the RESPONSE: req 'close' does not fire on client abort mid-response (it tracks
      // message completion), res 'close' fires on premature termination and on normal end —
      // writableEnded distinguishes the two.
      let detached = false;
      res.on("close", () => {
        if (!res.writableEnded) {
          detached = true;
          release();
        }
      });

      activeTurn.mcpEndpoint = turn.config?.mcp_endpoint ?? null;
      activeTurn.turnId = turn.turn_id ?? null;

      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
      try {
        // Preflight the MCP host: a dead host wedges flue's claim in silent queued-retry
        // (env-setup probes run at session build). Fail the turn loudly instead.
        await mcpPing().catch((err) => {
          throw new Error(`MCP host unreachable at ${activeTurn.mcpEndpoint ?? "<unset>"}: ${err instanceof Error ? err.message : String(err)}`);
        });
        const attached = await attachTurn(agent, turn, () => !detached);
        for await (const ev of attached.events) {
          if (detached) return; // abandoned — the buffer retains events for the re-attach
          writeLine(res, { seq: seq++, kind: (ev as ForwardedEvent).type, offset: (ev as ForwardedEvent).eventIndex, msg: ev });
        }
        if (detached) return;
        const done = await attached.done;
        if (!detached) {
          // The disposition rides the done line (attach_mode + orphan/R4 counts) — the
          // adapter turns it into runtime.* lifecycle telemetry (012 §11.9).
          writeLine(res, { kind: "done", reason: done.reason, ...attached.disposition, ...(done.error ? { error: { type: "engine", message: done.error } } : {}) });
        }
      } catch (err) {
        if (!detached) {
          writeLine(res, {
            kind: "done",
            reason: "error",
            error: {
              type: err instanceof OrphanWedgedError ? "orphan_wedged" : "brain",
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
        if (err instanceof OrphanWedgedError) {
          // killBrain fallback (§11.9 R3): the engine holds a run that will not settle —
          // this process is poisoned. Die after the response flushes; the next attempt
          // boots a fresh engine and R4 settles the wedge.
          res.end(() => process.exit(1));
          setTimeout(() => process.exit(1), 2000).unref();
          return;
        }
      } finally {
        release();
        if (!res.writableEnded) res.end();
      }
    })().catch(() => {
      try {
        if (!res.writableEnded) res.end();
      } catch { /* already gone */ }
    });
  });

  srv.listen(port, "127.0.0.1", () => {
    process.stdout.write(`[opencomputer-flue] brain listening on :${port}\n`);
  });
}
