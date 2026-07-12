import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index.js";

const env = (hosts = "gateway.oc.test,api.oc.test"): Env => ({ MANAGED_EGRESS_HOSTS: hosts });

afterEach(() => vi.restoreAllMocks());

describe("Flue outbound Worker", () => {
  it("allows exact platform-managed hosts without a policy lookup", async () => {
    const fetch = vi.fn(async () => new Response("upstream-ok"));
    vi.stubGlobal("fetch", fetch);
    expect((await worker.fetch(new Request("https://gateway.oc.test/v1"), env())).status).toBe(200);
    expect((await worker.fetch(new Request("https://api.oc.test/v1"), env())).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("denies unlisted, non-HTTPS, and unconfigured external egress", async () => {
    const fetch = vi.fn(async () => new Response("upstream-ok"));
    vi.stubGlobal("fetch", fetch);
    expect((await worker.fetch(new Request("https://evil.example/v1"), env())).status).toBe(403);
    expect((await worker.fetch(new Request("http://api.oc.test/v1"), env())).status).toBe(403);
    expect((await worker.fetch(new Request("https://api.oc.test/v1"), env(""))).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bypasses only Flue's exact synthetic hosts", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    expect((await worker.fetch(new Request("https://flue.invalid/__flue/internal/dispatch"), env())).status).toBe(200);
    expect((await worker.fetch(new Request("https://flue-registry.local/lookup"), env())).status).toBe(200);
    expect((await worker.fetch(new Request("https://attacker.flue.invalid/"), env())).status).toBe(403);
    expect((await worker.fetch(new Request("https://attacker.local/"), env())).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
