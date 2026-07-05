// flue-dispatch — the mandatory auth boundary + byte-exact router into WfP tenant scripts
// (design 013 §3 host-constraints 1/3, buildout W5 + Integration seams).
//
// Tenant scripts (stock `flue build --target cloudflare` Workers) have NO other route — no
// workers.dev, no custom domain. Every request reaches them ONLY through this Worker, which:
//   1. selects the tenant script from the URL prefix (= the OC agent's `agt_` id);
//   2. verifies the caller (control-plane internal-auth, or a session-scoped client token) BEFORE
//      forwarding — a user's own app.ts may add no auth, so the platform owns it (B5);
//   3. forwards the remainder of the path BYTE-EXACT via env.DISPATCHER.get(script).fetch(req)
//      (host constraint 1: the DO parses exact path tails; any transform silently terminalizes
//      lost submissions);
//   4. on an inbound ADMIT (a POST that delivers a message), kicks the OC tailer so it pulls the
//      new turn's updates until the submission settles (W5 → W1/W2 seam).
//
// ── The admit URL / shape (W5→W1 seam; sessions-api calls this) ──────────────────────────────
//   POST  https://<dispatch>/dispatch/<agt_id>/agents/<agent_name>/<ses_id>
//   headers: X-Internal-Auth: <secret>        (control-plane admit; OR a client token — see auth)
//            content-type: application/json
//   body:    {"message": <content>}           (1a: the key is `message`, NOT `prompt`)
//   → the tenant Worker receives EXACTLY  POST /agents/<agent_name>/<ses_id>  with the same body.
// Routing is by SCRIPT NAME = <agt_id> (one script per agent; revisions are versions of it), taken
// from the first path segment after /dispatch/. Stream reads / aborts use the same prefix with the
// tenant's own tails (GET …?view=updates, etc.) and are forwarded identically (no kick).

export interface Env {
  DISPATCHER: DispatchNamespace;
  INTERNAL_AUTH_SECRET: string;        // control-plane (sessions-api) auth
  CLIENT_TOKEN_SECRET?: string;        // session-scoped client token (dashboard/direct) — HS256
  SESSIONS_API_URL?: string;           // for the tailer kick; default = prod
  KICK_PATH?: string;                  // default /internal/flue/kick
}

const DEFAULT_SESSIONS_API = "https://api.opencomputer.dev";

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/** Constant-time string compare (avoid a timing oracle on the internal secret). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Minimal HS256 verify (Web Crypto) for the session-scoped client token — same alg as sessions-api's
// client token (auth/client.ts, jose HS256). Returns the claims or null. Kept dependency-free.
async function verifyClientToken(secret: string, token: string, nowSec: number): Promise<{ sub?: string; session?: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const b64urlToBytes = (x: string) => {
    const pad = x.length % 4 === 0 ? "" : "=".repeat(4 - (x.length % 4));
    const bin = atob(x.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  let ok: boolean;
  try { ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`)); }
  catch { return null; }
  if (!ok) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as { exp?: number; sub?: string; session?: string; sid?: string };
    if (typeof claims.exp === "number" && claims.exp <= nowSec) return null;
    return { sub: claims.sub, session: claims.session ?? claims.sid ?? claims.sub };
  } catch { return null; }
}

interface Parsed { script: string; tenantPath: string; sessionId: string | null; isAdmit: boolean; isChannel: boolean }

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
  const isChannel = segs[2] === "channels";
  return { script, tenantPath, sessionId, isAdmit, isChannel };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return json({ status: "ok", service: "flue-dispatch" });
    }

    const p = parse(url, req.method);
    if (!p) return json({ error: { type: "not_found", message: "expected /dispatch/<script>/…" } }, 404);

    // ── auth boundary (B5): verify BEFORE any forward ──────────────────────────────
    const internal = req.headers.get("x-internal-auth");
    const isControlPlane = !!internal && timingSafeEqual(internal, env.INTERNAL_AUTH_SECRET);
    if (!isControlPlane) {
      // External caller (dashboard/direct): require a session-scoped client token that matches the
      // ses_ in the path (no cross-session reach). Channels (W9) carry their own signature — deferred.
      const auth = req.headers.get("authorization");
      const token = auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : null;
      const claims = token && env.CLIENT_TOKEN_SECRET ? await verifyClientToken(env.CLIENT_TOKEN_SECRET, token, Math.floor(Date.now() / 1000)) : null;
      const sessionOk = claims && p.sessionId && claims.session === p.sessionId;
      if (!sessionOk) {
        return json({ error: { type: "unauthorized", message: "dispatch requires internal auth or a matching session client token" } }, 401);
      }
    }

    // ── byte-exact forward into the tenant script ──────────────────────────────────
    // Rewrite the URL to the tenant's own path (strip /dispatch/<script>); keep method/body/headers.
    // Strip OC control headers so they never reach the tenant app.
    const tenantUrl = new URL(req.url);
    tenantUrl.pathname = p.tenantPath;
    const fwdHeaders = new Headers(req.headers);
    fwdHeaders.delete("x-internal-auth");
    // `duplex: "half"` is required by undici (node/tests) when forwarding a streaming body; the
    // Workers runtime accepts it too. GET/HEAD have a null body → no duplex needed.
    const init: RequestInit = { method: req.method, headers: fwdHeaders, body: req.body, redirect: "manual" };
    if (req.body) (init as RequestInit & { duplex: "half" }).duplex = "half";
    const fwdReq = new Request(tenantUrl.toString(), init);

    let resp: Response;
    try {
      resp = await env.DISPATCHER.get(p.script).fetch(fwdReq);
    } catch (err) {
      // WfP `get()` throws if the script doesn't exist in the namespace → a clear 404 for the caller.
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: { type: "script_not_found", message: `no tenant script '${p.script}': ${msg}` } }, 404);
    }

    // ── tailer kick on a successful inbound admit (W5 → W1/W2) ──────────────────────
    if (p.isAdmit && p.sessionId && resp.status < 300) {
      ctx.waitUntil(kickTailer(env, p.sessionId));
    }

    return resp;
  },
};

async function kickTailer(env: Env, sessionId: string): Promise<void> {
  try {
    const base = env.SESSIONS_API_URL || DEFAULT_SESSIONS_API;
    const path = env.KICK_PATH || "/internal/flue/kick";
    await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-auth": env.INTERNAL_AUTH_SECRET },
      body: JSON.stringify({ session_id: sessionId }),
    });
  } catch {
    // Best-effort: a missed kick is recovered by the tailer's poll fallback (W2). Never fail the turn.
  }
}
