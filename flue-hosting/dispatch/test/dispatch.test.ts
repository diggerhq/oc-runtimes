// In-process tests for the dispatch Worker: the real handler against a fake DISPATCHER namespace +
// stubbed fetch (for the kick). Proves the auth boundary, byte-exact forward, and the tailer kick.
// Run: npx vitest run

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import worker, { Env } from "../src/index.js";

const INTERNAL = "internal-secret";
const CLIENT_SECRET = "client-secret";

// Records what the tenant script received (proves byte-exactness), returns a canned 2xx.
let forwarded: { url: string; method: string; hadInternalAuth: boolean; body: string } | null;
function fakeDispatcher(scriptExists = true): DispatchNamespace {
  return {
    get: (script: string) => {
      if (!scriptExists) throw new Error(`Worker '${script}' not found`);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const r = input instanceof Request ? input : new Request(input as string, init);
          forwarded = {
            url: r.url,
            method: r.method,
            hadInternalAuth: r.headers.has("x-internal-auth"),
            body: r.body ? await r.text() : "",
          };
          return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "content-type": "application/json" } });
        },
      } as unknown as Fetcher;
    },
  } as unknown as DispatchNamespace;
}

function env(over: Partial<Env> = {}): Env {
  return { DISPATCHER: fakeDispatcher(), INTERNAL_AUTH_SECRET: INTERNAL, CLIENT_TOKEN_SECRET: CLIENT_SECRET, SESSIONS_API_URL: "https://sapi.test", ...over };
}
function ctx() {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, _p: pending } as unknown as ExecutionContext;
}
const drain = (c: ExecutionContext) => Promise.all((c as unknown as { _p: Promise<unknown>[] })._p);

// Mint an HS256 client token bound to a session (mirrors sessions-api's client token).
async function clientToken(session: string, expOffset = 3600): Promise<string> {
  const b64url = (b: Uint8Array) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(enc.encode(JSON.stringify({ session, exp: Math.floor(Date.now() / 1000) + expOffset })));
  const key = await crypto.subtle.importKey("raw", enc.encode(CLIENT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${b64url(sig)}`;
}

const admitUrl = "https://disp.test/dispatch/agt_123/agents/support/ses_abc";
const admit = (headers: Record<string, string>) =>
  new Request(admitUrl, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ message: "hi" }) });

describe("dispatch Worker", () => {
  beforeEach(() => { forwarded = null; });
  afterEach(() => vi.restoreAllMocks());

  it("GET /healthz → ok", async () => {
    const r = await worker.fetch(new Request("https://disp.test/healthz"), env(), ctx());
    expect(r.status).toBe(200);
  });

  it("rejects an unauthenticated admit (401), no forward", async () => {
    const r = await worker.fetch(admit({}), env(), ctx());
    expect(r.status).toBe(401);
    expect(forwarded).toBeNull();
  });

  it("control-plane admit (internal-auth): forwards BYTE-EXACT (strips /dispatch/<script> + the internal header) and kicks the tailer", async () => {
    const kick = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response("ok"));
    vi.stubGlobal("fetch", kick);
    const c = ctx();
    const r = await worker.fetch(admit({ "x-internal-auth": INTERNAL }), env(), c);
    expect(r.status).toBe(202);
    // the tenant saw exactly /agents/support/ses_abc — NOT the /dispatch/<script> prefix
    expect(new URL(forwarded!.url).pathname).toBe("/agents/support/ses_abc");
    expect(forwarded!.method).toBe("POST");
    expect(forwarded!.body).toBe(JSON.stringify({ message: "hi" }));
    expect(forwarded!.hadInternalAuth).toBe(false); // control header stripped before the tenant
    await drain(c);
    // kick fired to /internal/flue/kick with the session id
    expect(kick).toHaveBeenCalledOnce();
    const [kurl, kinit] = kick.mock.calls[0]!;
    expect(String(kurl)).toBe("https://sapi.test/internal/flue/kick");
    expect(JSON.parse(kinit!.body as string)).toEqual({ session_id: "ses_abc" });
  });

  it("external caller with a matching session client token is allowed", async () => {
    const token = await clientToken("ses_abc");
    const r = await worker.fetch(admit({ authorization: `Bearer ${token}` }), env(), ctx());
    expect(r.status).toBe(202);
    expect(new URL(forwarded!.url).pathname).toBe("/agents/support/ses_abc");
  });

  it("external caller whose token is for a DIFFERENT session is rejected (no cross-session reach)", async () => {
    const token = await clientToken("ses_other");
    const r = await worker.fetch(admit({ authorization: `Bearer ${token}` }), env(), ctx());
    expect(r.status).toBe(401);
    expect(forwarded).toBeNull();
  });

  it("a GET stream read forwards byte-exact but does NOT kick (not an admit)", async () => {
    const kick = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", kick);
    const c = ctx();
    const r = await worker.fetch(new Request("https://disp.test/dispatch/agt_123/agents/support/ses_abc?view=updates", { headers: { "x-internal-auth": INTERNAL } }), env(), c);
    expect(r.status).toBe(202);
    expect(new URL(forwarded!.url).pathname).toBe("/agents/support/ses_abc");
    expect(new URL(forwarded!.url).search).toBe("?view=updates"); // query preserved byte-exact
    await drain(c);
    expect(kick).not.toHaveBeenCalled();
  });

  it("unknown tenant script → 404", async () => {
    const r = await worker.fetch(admit({ "x-internal-auth": INTERNAL }), env({ DISPATCHER: fakeDispatcher(false) }), ctx());
    expect(r.status).toBe(404);
  });
});
