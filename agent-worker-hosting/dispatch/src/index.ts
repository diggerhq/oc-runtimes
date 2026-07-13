// oc-agent-dispatch — the mandatory auth boundary + byte-exact router into WfP tenant scripts
// (design 013 §3 host-constraints 1/3, buildout W5 + Integration seams).
//
// Tenant scripts (stock `flue build --target cloudflare` Workers) have NO other route — no
// workers.dev, no custom domain. Every request reaches them ONLY through this Worker, which:
//   1. selects the tenant script from the URL prefix (= the OC agent's `agt_` id);
//   2. verifies the dedicated control-plane dispatch bearer BEFORE forwarding — browser client
//      tokens terminate at the sessions API, so this Worker is not a second public session API;
//   3. forwards the remainder of the path BYTE-EXACT via env.DISPATCHER.get(script).fetch(req)
//      (host constraint 1: the DO parses exact path tails; any transform silently terminalizes
//      lost submissions);
//   4. on an inbound ADMIT (a POST that delivers a message), kicks the OC tailer so it pulls the
//      new turn's updates until the submission settles (W5 → W1/W2 seam).
//
// ── The admit URL / shape (W5→W1 seam; sessions-api calls this) ──────────────────────────────
//   POST  https://<dispatch>/dispatch/<agt_id>/agents/<agent_name>/<ses_id>
//   headers: X-OC-Agent-Dispatch-Auth: <secret>  (control-plane admit only)
//            content-type: application/json
//   body:    {"message": <content>}           (1a: the key is `message`, NOT `prompt`)
//   → the tenant Worker receives EXACTLY  POST /agents/<agent_name>/<ses_id>  with the same body.
// Routing is by SCRIPT NAME = <agt_id> (one script per agent; revisions are versions of it), taken
// from the first path segment after /dispatch/. Stream reads / aborts use the same prefix with the
// tenant's own tails (GET …?view=updates, etc.) and are forwarded identically (no kick).

export interface Env {
  DISPATCHER: DispatchNamespace;
  AGENT_DISPATCH_AUTH_SECRET: string;  // dedicated sessions-api → dispatch bearer
  FLUE_KICK_AUTH_SECRET: string;       // dedicated dispatch → /internal/flue/kick bearer
  SESSIONS_API_URL?: string;           // for the tailer kick; default = prod
  KICK_PATH?: string;                  // default /internal/flue/kick
}

const DEFAULT_SESSIONS_API = "https://api.opencomputer.dev";
const AGENT_ID = /^agt_[0-9a-f]{24}$/;

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/** Constant-time string compare (avoid a timing oracle on the internal secret). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface Parsed { script: string; tenantPath: string; sessionId: string | null; isAdmit: boolean }

/** Split /dispatch/<script>/<tenant-path…> → { script, tenantPath }. */
function parse(url: URL, method: string): Parsed | null {
  const segs = url.pathname.split("/").filter(Boolean); // ["dispatch","<script>","agents","<name>","<ses>"]
  if (segs[0] !== "dispatch" || segs.length < 2) return null;
  const script = segs[1];
  const tenantPath = "/" + segs.slice(2).join("/"); // byte-exact tail for the tenant Worker
  // Admit = POST to EXACTLY /agents/<name>/<ses> (a message delivery). A POST to a deeper tail
  // (…/abort, …/attachments/<id>) is NOT an admit and must not kick. Session id = the segment
  // after /agents/<name>, extracted for any /agents/<name>/<ses>[/…] shape (client-token scoping).
  const underAgents = segs[2] === "agents" && segs.length >= 5;
  const sessionId = underAgents ? segs[4] : null;
  const isAdmit = method === "POST" && segs[2] === "agents" && segs.length === 5;
  return { script, tenantPath, sessionId, isAdmit };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return json({ status: "ok", service: "oc-agent-dispatch" });
    }

    const p = parse(url, req.method);
    if (!p) return json({ error: { type: "not_found", message: "expected /dispatch/<script>/…" } }, 404);
    if (!AGENT_ID.test(p.script)) {
      return json({ error: { type: "invalid_agent_id", message: "dispatch script must be an OpenComputer agent id" } }, 400);
    }

    // ── auth boundary (B5): verify BEFORE any forward ──────────────────────────────
    const presented = req.headers.get("x-oc-agent-dispatch-auth");
    if (!presented || !timingSafeEqual(presented, env.AGENT_DISPATCH_AUTH_SECRET)) {
      return json({ error: { type: "unauthorized", message: "dispatch requires control-plane auth" } }, 401);
    }

    // ── byte-exact forward into the tenant script ──────────────────────────────────
    // Rewrite the URL to the tenant's own path (strip /dispatch/<script>); keep method/body/headers.
    // Strip OC control headers so they never reach the tenant app.
    const tenantUrl = new URL(req.url);
    tenantUrl.pathname = p.tenantPath;
    const fwdHeaders = new Headers(req.headers);
    fwdHeaders.delete("x-oc-agent-dispatch-auth");
    const deferKick = fwdHeaders.get("x-oc-flue-defer-kick") === "1";
    fwdHeaders.delete("x-oc-flue-defer-kick");
    // `duplex: "half"` is required by undici (node/tests) when forwarding a streaming body; the
    // Workers runtime accepts it too. GET/HEAD have a null body → no duplex needed.
    const init: RequestInit = { method: req.method, headers: fwdHeaders, body: req.body, redirect: "manual" };
    if (req.body) (init as RequestInit & { duplex: "half" }).duplex = "half";
    const fwdReq = new Request(tenantUrl.toString(), init);

    let resp: Response;
    try {
      // The namespace's outbound Worker has a static platform-managed host set. It needs no
      // per-request tenant parameters and cannot make the model hot path depend on sessions-api.
      resp = await env.DISPATCHER.get(p.script).fetch(fwdReq);
    } catch (err) {
      // WfP `get()` throws if the script doesn't exist in the namespace → a clear 404 for the caller.
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: { type: "script_not_found", message: `no tenant script '${p.script}': ${msg}` } }, 404);
    }

    // ── tailer kick on a successful inbound admit (W5 → W1/W2) ──────────────────────
    if (p.isAdmit && p.sessionId && resp.status < 300 && !deferKick) {
      ctx.waitUntil(kickAdmittedTailer(env, p.sessionId, resp.clone()));
    }

    return resp;
  },
};

async function kickAdmittedTailer(env: Env, sessionId: string, admission: Response): Promise<void> {
  try {
    const body = (await admission.json().catch(() => ({}))) as Record<string, unknown>;
    const submissionId = typeof body.submissionId === "string" ? body.submissionId : undefined;
    const base = env.SESSIONS_API_URL || DEFAULT_SESSIONS_API;
    const path = env.KICK_PATH || "/internal/flue/kick";
    await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-oc-flue-kick-auth": env.FLUE_KICK_AUTH_SECRET },
      body: JSON.stringify({ session_id: sessionId, ...(submissionId ? { submission_id: submissionId } : {}) }),
    });
  } catch {
    // Best-effort: a missed kick is recovered by the tailer's poll fallback (W2). Never fail the turn.
  }
}
