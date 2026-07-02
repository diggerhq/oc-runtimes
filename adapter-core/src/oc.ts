// The substrate the v3 runtime is given (§5.9): the v3 session events API, reached
// over HTTP and authenticated by the fenced TURN TOKEN — the ONLY credential the
// runtime holds (besides the SEALED ANTHROPIC_API_KEY, which is opaque). No DB, no
// plaintext provider key.
//
// Adapted from runtimes/claude/src/oc.ts. v3 changes (§5.9 "adapt don't lift"):
//   - repoint /v2 → /v3
//   - DROP the `kind` discriminator — emit top-level `type` + `level` only (§4.1)
//   - stable idempotency keys (rt:<turn>:<n>) so a re-run/restart dedups (§5.10)

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export const config = {
  apiUrl: req("OC_API_URL").replace(/\/$/, ""),
  sessionId: req("OC_SESSION_ID"),
  turnId: process.env.OC_TURN_ID ?? "",
  turnToken: req("OC_TURN_TOKEN"),
};

export type EventLevel = "user" | "progress" | "internal";

export interface InEvent {
  seq: number;
  id: string;
  type: string;         // single public discriminator (no `kind`)
  level: EventLevel;
  actor: unknown;
  body: unknown;
  refs: unknown;
  ts: string;
}

export interface OutEvent {
  type: string;         // §4.1 taxonomy: agent.message | tool.call | exec.completed | error.* …
  level?: EventLevel;   // default internal
  body?: unknown;
  refs?: Record<string, unknown>;
  idempotencyKey?: string;
}

// ngrok-skip is harmless against a real API; lets a dev tunnel skip its interstitial.
const baseHeaders = { "X-Turn-Token": config.turnToken, "ngrok-skip-browser-warning": "1" };

// Stable per-turn append keys (§5.10): `rt:<turn>:<base + n>`. `base` is the
// DURABLE high-water the host seeds via OC_EVENT_KEY_BASE — NOT 0. The in-process
// `n` increments per append within this process. Because the host advances the
// durable counter past committed events before each crash-restart, a --continue'd
// attempt seeds `base` ABOVE every committed key, so its NEW events never re-collide
// with already-committed ones AND no new event is dropped by the single writer.
const keyBase = Number(process.env.OC_EVENT_KEY_BASE ?? "0") || 0;
let appendSeq = 0;

export async function getEventsSince(afterSeq: number): Promise<InEvent[]> {
  // level=internal → return ALL levels (the runtime needs every input event).
  const r = await fetch(`${config.apiUrl}/v3/sessions/${config.sessionId}/events?after=${afterSeq}&level=internal`, {
    headers: baseHeaders,
  });
  if (!r.ok) throw new Error(`getEvents ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { data?: InEvent[] };
  return j.data ?? [];
}

export async function appendEvent(ev: OutEvent): Promise<void> {
  const idempotencyKey = ev.idempotencyKey ?? `rt:${config.turnId}:${keyBase + appendSeq++}`;
  const r = await fetch(`${config.apiUrl}/v3/sessions/${config.sessionId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...baseHeaders },
    body: JSON.stringify({
      type: ev.type,
      level: ev.level ?? "internal",
      body: ev.body ?? {},
      refs: ev.refs,
      idempotency_key: idempotencyKey,
    }),
  });
  // 401 fenced = a cancel/supersede landed — stop quietly (the host owns disposition).
  if (r.status === 401) throw new Error("fenced");
  if (!r.ok) throw new Error(`appendEvent ${r.status}: ${await r.text()}`);
}
