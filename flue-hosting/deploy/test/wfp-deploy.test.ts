// Tests for the multipart WfP script-upload deploy step (contract #4). The load-bearing guarantee:
// the composer's synthesized `migrations` (`new_sqlite_classes`) MUST land in the `metadata` part of
// the PUT — that is exactly what `wrangler deploy --dispatch-namespace` silently drops (→ tenant DO
// 500s "SQL is not enabled", W6 bug 4). Everything here is in-process (injected fetch, no live CF).
// Run: npx vitest run

import { describe, it, expect } from "vitest";
import { composeWrangler, type GeneratedWrangler, type MigrationEntry } from "../src/compose-wrangler.js";
import {
  migrationForUpload,
  toWfpBindings,
  buildMetadata,
  buildFormData,
  deployTenantScript,
  deleteTenantScript,
  WfpDeployError,
  type WfpMetadata,
  type ScriptModule,
  type CfCreds,
} from "../src/wfp-deploy.js";

// Mirrors compose.test.ts: Flue's exact class-name scheme.
const generated = (agents: string[]): GeneratedWrangler => ({
  name: "agt_123",
  main: ".flue-vite/_entry.ts",
  compatibility_date: "2026-04-01",
  compatibility_flags: ["nodejs_compat"],
  durable_objects: {
    bindings: [
      ...agents.map((a) => ({ name: `FLUE_${a.toUpperCase().replace(/-/g, "_")}_AGENT`, class_name: `Flue${a.split(/[-_]/).map((s) => s[0].toUpperCase() + s.slice(1)).join("")}Agent` })),
      { name: "FLUE_REGISTRY", class_name: "FlueRegistry" },
    ],
  },
});

const oc = { gatewayUrl: "https://gw.oc.dev", ingestUrl: "https://ingest.oc.dev/e" };
const cf: CfCreds = { accountId: "acct_1", apiToken: "cf-token", namespace: "oc-flue-throwaway", apiBase: "https://cf.test/v4" };
const module: ScriptModule = { filename: "index.js", content: "export default { async fetch() { return new Response('ok'); } }" };

const okEnvelope = () => new Response(JSON.stringify({ success: true, result: { id: "agt_123" }, errors: [] }), { status: 200, headers: { "content-type": "application/json" } });

describe("migrationForUpload", () => {
  it("first deploy → a fresh migration with ALL classes and no old_tag", () => {
    const c = composeWrangler(generated(["support-triage"]), oc, []);
    expect(migrationForUpload(c)).toEqual({ new_tag: "v1", new_sqlite_classes: ["FlueSupportTriageAgent", "FlueRegistry"] });
  });

  it("incremental add → old_tag=prev, new_tag=last, only the NEW class in new_sqlite_classes", () => {
    const prior: MigrationEntry[] = [{ tag: "v1", new_sqlite_classes: ["FlueOneAgent", "FlueRegistry"] }];
    const c = composeWrangler(generated(["one", "two"]), oc, prior);
    expect(migrationForUpload(c)).toEqual({ old_tag: "v1", new_tag: "v2", new_sqlite_classes: ["FlueTwoAgent"] });
  });

  it("behavior-only revision (no new classes) → null (nothing to migrate)", () => {
    const prior: MigrationEntry[] = [{ tag: "v1", new_sqlite_classes: ["FlueOneAgent", "FlueRegistry"] }];
    const c = composeWrangler(generated(["one"]), oc, prior);
    expect(migrationForUpload(c)).toBeNull();
  });

  it("recreate → one fresh migration replaying the FULL ledger (every class, no old_tag)", () => {
    const prior: MigrationEntry[] = [{ tag: "v1", new_sqlite_classes: ["FlueOneAgent", "FlueRegistry"] }];
    const c = composeWrangler(generated(["one", "two"]), oc, prior); // ledger = v1 + v2
    expect(migrationForUpload(c, true)).toEqual({ new_tag: "v2", new_sqlite_classes: ["FlueOneAgent", "FlueRegistry", "FlueTwoAgent"] });
  });
});

describe("toWfpBindings", () => {
  it("maps vars→plain_text, DO bindings→durable_object_namespace, secrets→secret_text", () => {
    const { config } = composeWrangler(generated(["support-triage"]), oc, []);
    const bindings = toWfpBindings(config, { OC_SESSION_TOKEN: "jwt-x" });
    expect(bindings).toContainEqual({ type: "plain_text", name: "OC_GATEWAY", text: "https://gw.oc.dev" });
    expect(bindings).toContainEqual({ type: "durable_object_namespace", name: "FLUE_REGISTRY", class_name: "FlueRegistry" });
    expect(bindings).toContainEqual({ type: "durable_object_namespace", name: "FLUE_SUPPORT_TRIAGE_AGENT", class_name: "FlueSupportTriageAgent" });
    expect(bindings).toContainEqual({ type: "secret_text", name: "OC_SESSION_TOKEN", text: "jwt-x" });
  });

  it("a secret of the same name as a var wins — the var is NOT also emitted as plain_text", () => {
    const config: GeneratedWrangler = { vars: { OC_SESSION_TOKEN: "should-be-hidden", OTHER: "keep" } };
    const bindings = toWfpBindings(config, { OC_SESSION_TOKEN: "jwt-x" });
    expect(bindings).toContainEqual({ type: "secret_text", name: "OC_SESSION_TOKEN", text: "jwt-x" });
    expect(bindings).not.toContainEqual({ type: "plain_text", name: "OC_SESSION_TOKEN", text: "should-be-hidden" });
    expect(bindings).toContainEqual({ type: "plain_text", name: "OTHER", text: "keep" });
  });
});

describe("buildMetadata", () => {
  it("carries main_module, floors, and the migration (new_sqlite_classes) into metadata", () => {
    const c = composeWrangler(generated(["support-triage"]), oc, []);
    const meta = buildMetadata(c.config, module, migrationForUpload(c), {});
    expect(meta.main_module).toBe("index.js");
    expect(meta.compatibility_flags).toContain("nodejs_compat");
    expect(meta.migrations).toEqual({ new_tag: "v1", new_sqlite_classes: ["FlueSupportTriageAgent", "FlueRegistry"] });
  });

  it("omits migrations for a behavior-only revision (null migration)", () => {
    const c = composeWrangler(generated(["support-triage"]), oc, []);
    const meta = buildMetadata(c.config, module, null, {});
    expect(meta.migrations).toBeUndefined();
  });
});

describe("buildFormData", () => {
  it("has a metadata part (json) and an entry-module part named by main_module", async () => {
    const meta: WfpMetadata = { main_module: "index.js", bindings: [], migrations: { new_tag: "v1", new_sqlite_classes: ["X"] } };
    const form = buildFormData(meta, module);
    const metaPart = form.get("metadata") as File;
    expect(JSON.parse(await metaPart.text())).toEqual(meta);
    const modPart = form.get("index.js") as File;
    expect(await modPart.text()).toBe(module.content);
    expect(modPart.type).toBe("application/javascript+module");
  });
});

describe("deployTenantScript (injected fetch — no live CF)", () => {
  it("PUTs multipart to the WfP script URL with the migration in the metadata part (the core guarantee)", async () => {
    let captured: { url: string; method?: string; auth: string | null; body: FormData } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), method: init?.method, auth: new Headers(init?.headers).get("authorization"), body: init!.body as FormData };
      return okEnvelope();
    }) as unknown as typeof fetch;

    const c = composeWrangler(generated(["support-triage"]), oc, []);
    const res = await deployTenantScript(cf, "agt_123", c, module, { fetchImpl });

    expect(res.scriptName).toBe("agt_123");
    expect(captured!.method).toBe("PUT");
    expect(captured!.url).toBe("https://cf.test/v4/accounts/acct_1/workers/dispatch/namespaces/oc-flue-throwaway/scripts/agt_123");
    expect(captured!.auth).toBe("Bearer cf-token");
    expect(captured!.body).toBeInstanceOf(FormData);
    const meta = JSON.parse(await (captured!.body.get("metadata") as File).text()) as WfpMetadata;
    expect(meta.migrations).toEqual({ new_tag: "v1", new_sqlite_classes: ["FlueSupportTriageAgent", "FlueRegistry"] });
    expect(meta.bindings).toContainEqual({ type: "durable_object_namespace", name: "FLUE_REGISTRY", class_name: "FlueRegistry" });
    // and the entry module rode along
    expect(await (captured!.body.get("index.js") as File).text()).toBe(module.content);
  });

  it("recreate → DELETEs the script first, then PUTs the full-ledger migration", async () => {
    const calls: Array<{ method?: string; url: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: init?.method, url: String(url) });
      return okEnvelope();
    }) as unknown as typeof fetch;

    const prior: MigrationEntry[] = [{ tag: "v1", new_sqlite_classes: ["FlueOneAgent", "FlueRegistry"] }];
    const c = composeWrangler(generated(["one", "two"]), oc, prior);
    const res = await deployTenantScript(cf, "agt_123", c, module, { fetchImpl, recreate: true });

    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/scripts/agt_123?force=true");
    expect(calls[1]!.method).toBe("PUT");
    expect(res.migration).toEqual({ new_tag: "v2", new_sqlite_classes: ["FlueOneAgent", "FlueRegistry", "FlueTwoAgent"] });
  });

  it("throws WfpDeployError on a CF failure envelope — without leaking the token", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10021, message: "migration error" }] }), { status: 400, headers: { "content-type": "application/json" } })
    ) as unknown as typeof fetch;
    const c = composeWrangler(generated(["support-triage"]), oc, []);
    await expect(deployTenantScript(cf, "agt_123", c, module, { fetchImpl })).rejects.toThrow(WfpDeployError);
    await expect(deployTenantScript(cf, "agt_123", c, module, { fetchImpl })).rejects.not.toThrow(/cf-token/);
  });

  it("deleteTenantScript treats a 404 as already-gone (no throw)", async () => {
    const fetchImpl = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(deleteTenantScript(cf, "agt_gone", fetchImpl)).resolves.toBeUndefined();
  });
});
