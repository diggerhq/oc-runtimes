// In-process tests for the dispatch Worker: the real handler against a fake DISPATCHER namespace +
// stubbed fetch (for the kick). Proves the auth boundary, byte-exact forward, and the tailer kick.
// Run: npx vitest run

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import worker, { Env } from "../src/index.js";

const DISPATCH_SECRET = "dispatch-secret";
const KICK_SECRET = "kick-secret";

// Records what the tenant script received (proves byte-exactness), returns a canned 2xx.
let forwarded: { url: string; method: string; hadDispatchAuth: boolean; hadDeferKick: boolean; body: string } | null;
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
            hadDispatchAuth: r.headers.has("x-flue-dispatch-auth"),
            hadDeferKick: r.headers.has("x-flue-defer-kick"),
            body: r.body ? await r.text() : "",
          };
          return new Response(JSON.stringify({ submissionId: "sub_accepted", offset: "12" }), { status: 202, headers: { "content-type": "application/json" } });
        },
      } as unknown as Fetcher;
    },
  } as unknown as DispatchNamespace;
}

function env(over: Partial<Env> = {}): Env {
  return { DISPATCHER: fakeDispatcher(), DISPATCH_AUTH_SECRET: DISPATCH_SECRET, KICK_AUTH_SECRET: KICK_SECRET, SESSIONS_API_URL: "https://sapi.test", ...over };
}
function ctx() {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, _p: pending } as unknown as ExecutionContext;
}
const drain = (c: ExecutionContext) => Promise.all((c as unknown as { _p: Promise<unknown>[] })._p);

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

  it("rejects the wrong dedicated dispatch bearer before tenant selection", async () => {
    const r = await worker.fetch(admit({ "x-flue-dispatch-auth": "wrong" }), env(), ctx());
    expect(r.status).toBe(401);
    expect(forwarded).toBeNull();
  });

  it("control-plane admit forwards byte-exact and kicks with the dedicated bearer", async () => {
    const kick = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response("ok"));
    vi.stubGlobal("fetch", kick);
    const c = ctx();
    const r = await worker.fetch(admit({ "x-flue-dispatch-auth": DISPATCH_SECRET }), env(), c);
    expect(r.status).toBe(202);
    // the tenant saw exactly /agents/support/ses_abc — NOT the /dispatch/<script> prefix
    expect(new URL(forwarded!.url).pathname).toBe("/agents/support/ses_abc");
    expect(forwarded!.method).toBe("POST");
    expect(forwarded!.body).toBe(JSON.stringify({ message: "hi" }));
    expect(forwarded!.hadDispatchAuth).toBe(false); // control header stripped before the tenant
    expect(forwarded!.hadDeferKick).toBe(false);
    await drain(c);
    // kick fired to /internal/flue/kick with the session id
    expect(kick).toHaveBeenCalledOnce();
    const [kurl, kinit] = kick.mock.calls[0]!;
    expect(String(kurl)).toBe("https://sapi.test/internal/flue/kick");
    expect(JSON.parse(kinit!.body as string)).toEqual({ session_id: "ses_abc", submission_id: "sub_accepted" });
    expect(new Headers(kinit!.headers).get("x-flue-kick-auth")).toBe(KICK_SECRET);
  });

  it("lets sessions-api defer the kick until its sole input event is durable", async () => {
    const kick = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", kick);
    const c = ctx();
    const r = await worker.fetch(admit({
      "x-flue-dispatch-auth": DISPATCH_SECRET,
      "x-flue-defer-kick": "1",
    }), env(), c);
    expect(r.status).toBe(202);
    expect(forwarded!.hadDeferKick).toBe(false);
    await drain(c);
    expect(kick).not.toHaveBeenCalled();
  });

  it("rejects browser client tokens because they terminate at the sessions API", async () => {
    const r = await worker.fetch(admit({ authorization: "Bearer client-token" }), env(), ctx());
    expect(r.status).toBe(401);
    expect(forwarded).toBeNull();
  });

  it("a GET stream read forwards byte-exact but does NOT kick (not an admit)", async () => {
    const kick = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", kick);
    const c = ctx();
    const r = await worker.fetch(new Request("https://disp.test/dispatch/agt_123/agents/support/ses_abc?view=updates", { headers: { "x-flue-dispatch-auth": DISPATCH_SECRET } }), env(), c);
    expect(r.status).toBe(202);
    expect(new URL(forwarded!.url).pathname).toBe("/agents/support/ses_abc");
    expect(new URL(forwarded!.url).search).toBe("?view=updates"); // query preserved byte-exact
    await drain(c);
    expect(kick).not.toHaveBeenCalled();
  });

  it("unknown tenant script → 404", async () => {
    const r = await worker.fetch(admit({ "x-flue-dispatch-auth": DISPATCH_SECRET }), env({ DISPATCHER: fakeDispatcher(false) }), ctx());
    expect(r.status).toBe(404);
  });
});
