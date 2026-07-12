import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { _clearPolicyCache, type Env } from "../src/index.js";

const env = (over: Partial<Env> = {}): Env => ({
  policy: { agent_id: "agt_1" },
  EGRESS_POLICY_URL: "https://api.test/internal/flue/egress-policy",
  EGRESS_POLICY_SECRET: "policy-secret",
  MANAGED_EGRESS_HOSTS: "gateway.oc.test,api.oc.test",
  ...over,
});

afterEach(() => { vi.restoreAllMocks(); _clearPolicyCache(); });

function mockPolicy(hosts: string[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://api.test/internal/flue/egress-policy/")) {
      return Response.json({ allowlist: hosts });
    }
    return new Response("upstream-ok");
  });
}

describe("Flue outbound Worker", () => {
  it("allows managed and user-listed hosts", async () => {
    const fetch = mockPolicy(["api.example.com", "*.stripe.com"]);
    vi.stubGlobal("fetch", fetch);
    expect((await worker.fetch(new Request("https://gateway.oc.test/v1"), env())).status).toBe(200);
    expect((await worker.fetch(new Request("https://api.example.com/v1"), env())).status).toBe(200);
    expect((await worker.fetch(new Request("https://hooks.stripe.com/v1"), env())).status).toBe(200);
  });

  it("denies unlisted, non-HTTPS, and unidentified egress", async () => {
    vi.stubGlobal("fetch", mockPolicy([]));
    expect((await worker.fetch(new Request("https://evil.example/v1"), env())).status).toBe(403);
    expect((await worker.fetch(new Request("http://api.oc.test/v1"), env())).status).toBe(403);
    expect((await worker.fetch(new Request("https://api.oc.test/v1"), env({ policy: undefined }))).status).toBe(403);
  });

  it("fails closed when policy lookup fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    expect((await worker.fetch(new Request("https://api.example.com/v1"), env())).status).toBe(503);
  });

  it("passes Flue synthetic subrequests without a policy lookup", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    expect((await worker.fetch(new Request("https://flue.invalid/__flue/internal/dispatch"), env())).status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
