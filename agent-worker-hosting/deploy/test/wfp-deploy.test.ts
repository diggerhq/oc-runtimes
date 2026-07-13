import { describe, expect, it, vi } from "vitest";
import {
  composeWrangler,
  type FlueWranglerDescriptor,
} from "../src/compose-wrangler.js";
import {
  buildFormData,
  buildMetadata,
  deleteTenantScript,
  deployTenantScript,
  toWfpBindings,
  toWfpExports,
  WfpDeployError,
  type CfCreds,
  type ScriptModule,
  type WfpMetadata,
} from "../src/wfp-deploy.js";

const AGENT_ID = "agt_0123456789abcdef01234567";
const descriptor = (agents: string[]): FlueWranglerDescriptor => ({
  main: "index.js",
  compatibility_date: "2026-04-01",
  compatibility_flags: ["nodejs_compat"],
  no_bundle: true,
  durable_objects: {
    bindings: [
      ...agents.map((agent) => ({ name: `FLUE_${agent.toUpperCase()}_AGENT`, class_name: `Flue${agent[0]!.toUpperCase()}${agent.slice(1)}Agent` })),
      { name: "FLUE_REGISTRY", class_name: "FlueRegistry" },
    ],
  },
});
const oc = { gatewayUrl: "https://gateway.oc.test" };
const cf: CfCreds = {
  accountId: "account-id",
  apiToken: "cf-token",
  namespace: "oc-agent-workers-prod",
  apiBase: "https://cf.test/v4",
};
const module: ScriptModule = {
  filename: "index.js",
  content: "export default { fetch() { return new Response('ok') } }",
};
const okEnvelope = () => new Response(JSON.stringify({ success: true, result: { id: AGENT_ID } }), {
  status: 200,
  headers: { "content-type": "application/json" },
});

describe("WfP metadata", () => {
  it("contains only server vars, secrets, and same-script Durable Object bindings", () => {
    const result = composeWrangler(descriptor(["one"]), { ...oc, extraVars: { USER_SETTING: "yes" } });
    const bindings = toWfpBindings(result.config, { OC_SESSION_TOKEN: "jwt" });
    expect(bindings).toContainEqual({ type: "plain_text", name: "OC_GATEWAY", text: oc.gatewayUrl });
    expect(bindings).toContainEqual({ type: "plain_text", name: "USER_SETTING", text: "yes" });
    expect(bindings).toContainEqual({ type: "secret_text", name: "OC_SESSION_TOKEN", text: "jwt" });
    expect(bindings).toContainEqual({ type: "durable_object_namespace", name: "FLUE_REGISTRY", class_name: "FlueRegistry" });
    expect(JSON.stringify(bindings)).not.toContain("script_name");
  });

  it("declares each validated Durable Object class as a SQLite export", () => {
    const result = composeWrangler(descriptor(["one"]), oc);
    expect(toWfpExports(result.config)).toEqual({
      FlueOneAgent: { type: "durable-object", storage: "sqlite" },
      FlueRegistry: { type: "durable-object", storage: "sqlite" },
    });
    const metadata = buildMetadata(result.config, module);
    expect(metadata).not.toHaveProperty("migrations");
  });

  it("requires the entry module to match the server-owned main", () => {
    const result = composeWrangler(descriptor(["one"]), oc);
    expect(() => buildMetadata(result.config, { ...module, filename: "other.js" })).toThrow(WfpDeployError);
  });

  it("builds a module-only multipart body", async () => {
    const result = composeWrangler(descriptor(["one"]), oc);
    const metadata = buildMetadata(result.config, module);
    const form = buildFormData(metadata, module, [{ filename: "chunks/helper.mjs", content: "export {}" }]);
    expect(JSON.parse(await (form.get("metadata") as File).text())).toEqual(metadata);
    expect(await (form.get("index.js") as File).text()).toBe(module.content);
    expect(form.get("chunks/helper.mjs")).toBeInstanceOf(File);
  });

  it("rejects unsafe or duplicate module paths", () => {
    const metadata: WfpMetadata = { main_module: "../index.js", bindings: [], exports: {} };
    expect(() => buildFormData(metadata, { ...module, filename: "../index.js" })).toThrow(WfpDeployError);
    const safeMetadata: WfpMetadata = { main_module: "index.js", bindings: [], exports: {} };
    expect(() => buildFormData(safeMetadata, module, [module])).toThrow(/unique/);
  });
});

describe("deployTenantScript", () => {
  it("uploads the multipart artifact to the exact namespace and agent id", async () => {
    let captured: { url: string; method?: string; body: FormData } | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(input), method: init?.method, body: init?.body as FormData };
      return okEnvelope();
    }) as unknown as typeof fetch;
    const result = composeWrangler(descriptor(["one"]), oc);
    await deployTenantScript(cf, AGENT_ID, result, module, { fetchImpl });
    expect(captured?.url).toBe(`https://cf.test/v4/accounts/account-id/workers/dispatch/namespaces/oc-agent-workers-prod/scripts/${AGENT_ID}`);
    expect(captured?.method).toBe("PUT");
    expect((captured?.body.get("metadata") as File)).toBeInstanceOf(File);
  });

  it("rejects a non-canonical script name before any Cloudflare call", async () => {
    const fetchImpl = vi.fn(async () => okEnvelope()) as unknown as typeof fetch;
    const result = composeWrangler(descriptor(["one"]), oc);
    await expect(deployTenantScript(cf, "agt_short", result, module, { fetchImpl })).rejects.toThrow(WfpDeployError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not leak the API token in Cloudflare failures", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      success: false,
      errors: [{ code: 10021, message: "upload error" }],
    }), { status: 400 })) as typeof fetch;
    const result = composeWrangler(descriptor(["one"]), oc);
    await expect(deployTenantScript(cf, AGENT_ID, result, module, { fetchImpl })).rejects.not.toThrow(/cf-token/);
  });

  it("treats delete 404 as already absent", async () => {
    const fetchImpl = (async () => new Response("", { status: 404 })) as typeof fetch;
    await expect(deleteTenantScript(cf, AGENT_ID, fetchImpl)).resolves.toBeUndefined();
  });
});
