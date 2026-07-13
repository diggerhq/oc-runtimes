import { describe, expect, it, vi } from "vitest";
import {
  NamespaceProvisionError,
  PRODUCTION_NAMESPACE,
  provisionProductionNamespace,
} from "../src/provision-production.js";

const config = {
  accountId: "account-id",
  apiToken: "secret-token",
  namespace: PRODUCTION_NAMESPACE,
  apiBase: "https://cf.test/v4",
};
const json = (result: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, result }), {
  status,
  headers: { "content-type": "application/json" },
});

describe("provisionProductionNamespace", () => {
  it("verifies an existing untrusted namespace without mutating it", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      json({ namespace_name: PRODUCTION_NAMESPACE, trusted_workers: false }));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    await expect(provisionProductionNamespace(config, fetchImpl)).resolves.toEqual({
      namespace: PRODUCTION_NAMESPACE,
      created: false,
      trustedWorkers: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
  });

  it("creates only the exact production namespace after a 404", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(undefined, 404))
      .mockResolvedValueOnce(json({ namespace_name: PRODUCTION_NAMESPACE, trusted_workers: false }));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    await expect(provisionProductionNamespace(config, fetchImpl)).resolves.toMatchObject({ created: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://cf.test/v4/accounts/account-id/workers/dispatch/namespaces");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ name: PRODUCTION_NAMESPACE });
  });

  it("refuses a trusted namespace rather than toggling it", async () => {
    const fetchMock = vi.fn(async () => json({ namespace_name: PRODUCTION_NAMESPACE, trusted_workers: true }));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    await expect(provisionProductionNamespace(config, fetchImpl)).rejects.toThrow(NamespaceProvisionError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses an operator-selected namespace and never calls Cloudflare", async () => {
    const fetchMock = vi.fn();
    const fetchImpl = fetchMock as unknown as typeof fetch;
    await expect(provisionProductionNamespace({ ...config, namespace: "opencomputer-agent" }, fetchImpl)).rejects.toThrow(/must equal/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
