// Thin client for the adapter's MCP host (the six-tool subset, contract 9). Same convention
// as the pi brain's mcpCall: one short-lived official-SDK client per call against the
// stateless streamable-http host. The endpoint is TURN-SCOPED — it arrives in each /turn
// config and is resolved lazily from the active-turn holder (tools are valid only while a
// turn is in flight; 012 §11.4).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export class NoActiveTurnError extends Error {
  constructor() {
    super("no turn is in flight — OC tools are valid only during a turn");
    this.name = "NoActiveTurnError";
  }
}

/** The active-turn context serveOC updates on every /turn. */
export const activeTurn: { mcpEndpoint: string | null; turnId: string | null } = {
  mcpEndpoint: null,
  turnId: null,
};

export async function mcpCall(name: string, args: Record<string, unknown>): Promise<string> {
  const endpoint = activeTurn.mcpEndpoint;
  if (!endpoint) throw new NoActiveTurnError();
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  const client = new Client({ name: "opencomputer-flue", version: "0.1.0" });
  await client.connect(transport);
  try {
    const r = (await client.callTool({ name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (r.isError) throw new Error(text || `tool ${name} failed`);
    return text;
  } finally {
    await client.close().catch(() => {});
  }
}

/** Preflight: is the turn's MCP host reachable? Used by serveOC before attaching — a dead
 *  host would otherwise wedge the claim in silent queued-retry (flue retries env-setup
 *  failures without settling; P0 finding). */
export async function mcpPing(): Promise<void> {
  const endpoint = activeTurn.mcpEndpoint;
  if (!endpoint) throw new NoActiveTurnError();
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  const client = new Client({ name: "opencomputer-flue", version: "0.1.0" });
  await client.connect(transport);
  try {
    await client.listTools();
  } finally {
    await client.close().catch(() => {});
  }
}
