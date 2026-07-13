// Load-bearing: multipart WfP upload with declarative Durable Object exports.
//
// Deploy a composed tenant config to Workers-for-Platforms via the RAW multipart script-upload API
// (contract #4, design 013 §3/§6). This is the ONLY supported vehicle for tenant scripts.
//
// Flue exports dynamically wrapped Durable Object classes. Cloudflare cannot infer those classes from
// JavaScript alone, so the upload MUST declare each validated class in `metadata.exports`. Declarative
// exports own SQLite class provisioning and are mutually exclusive with legacy `metadata.migrations`.
//
// This step consumes the contract-#4 composer output (`ComposeResult` from compose-wrangler.ts) and
// PUTs it to:
//   PUT https://api.cloudflare.com/client/v4/accounts/{acct}/workers/dispatch/namespaces/{ns}/scripts/{name}
// with a multipart/form-data body = an ES-module part + a `metadata` part carrying `main_module`,
// `bindings` (incl. the `durable_object_namespace` bindings), `compatibility_*`, and the declarative
// Durable Object `exports` synthesized from the same server-validated class list.

import type { ComposeResult, TenantScriptConfig } from "./compose-wrangler.js";

const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";
const MODULE_CONTENT_TYPE = "application/javascript+module";
const AGENT_ID = /^agt_[0-9a-f]{24}$/;

/** A WfP script binding (subset — the ones OC tenant scripts use). */
export type WfpBinding =
  | { type: "plain_text"; name: string; text: string }
  | { type: "secret_text"; name: string; text: string }
  | { type: "durable_object_namespace"; name: string; class_name: string };

export interface WfpDurableObjectExport {
  type: "durable-object";
  storage: "sqlite";
}

/** The `metadata` part of the multipart upload. */
export interface WfpMetadata {
  main_module: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  bindings: WfpBinding[];
  exports: Record<string, WfpDurableObjectExport>;
}

/** The built ES-module artifact from `flue build --target cloudflare` (already bundled — this step
 *  uploads it verbatim, it does NOT bundle). `filename` MUST equal what `metadata.main_module` names. */
export interface ScriptModule {
  filename: string;
  content: string | Uint8Array;
  contentType?: string;
}

export interface CfCreds {
  accountId: string;
  apiToken: string;
  namespace: string; // WfP dispatch namespace; provisioned out of band and pinned by runner policy
  apiBase?: string;
}

export interface DeployOptions {
  /** Extra secret bindings (uploaded as `secret_text` — e.g. `OC_SESSION_TOKEN`). Override same-named vars. */
  secrets?: Record<string, string>;
  /** Extra verified .js/.mjs modules besides the entry. */
  additionalModules?: ScriptModule[];
  /** Explicitly delete the script before upload. This destroys the current tenant script identity and
   *  lets declarative exports provision its classes from scratch; normal revisions never need it. */
  recreate?: boolean;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class WfpDeployError extends Error {}

function assertAgentScriptName(scriptName: string): void {
  if (!AGENT_ID.test(scriptName)) {
    throw new WfpDeployError("WfP script name must be a canonical OpenComputer agent id");
  }
}

function assertModule(module: ScriptModule): void {
  const path = module.filename;
  const segments = path.split("/");
  if (!path || path.startsWith("/") || path.includes("\\")
    || !(path.endsWith(".js") || path.endsWith(".mjs"))
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new WfpDeployError("tenant modules must use safe relative .js/.mjs paths");
  }
}

/** Convert the composed wrangler config's vars + DO bindings (+ secrets) into WfP script bindings. */
export function toWfpBindings(config: TenantScriptConfig, secrets: Record<string, string> = {}): WfpBinding[] {
  const bindings: WfpBinding[] = [];
  const secretNames = new Set(Object.keys(secrets));

  for (const [name, text] of Object.entries(config.vars ?? {})) {
    if (secretNames.has(name)) continue; // a secret of the same name wins (never also emit it as plaintext)
    bindings.push({ type: "plain_text", name, text: String(text) });
  }
  for (const [name, text] of Object.entries(secrets)) {
    bindings.push({ type: "secret_text", name, text: String(text) });
  }
  for (const b of config.durable_objects?.bindings ?? []) {
    bindings.push({
      type: "durable_object_namespace",
      name: b.name,
      class_name: b.class_name,
    });
  }
  return bindings;
}

/** Declare every validated same-script class as a SQLite-backed Durable Object export. Flue's
 *  generated wrappers are dynamic, so Cloudflare cannot infer this from the module syntax. */
export function toWfpExports(config: TenantScriptConfig): Record<string, WfpDurableObjectExport> {
  return Object.fromEntries(
    (config.durable_objects?.bindings ?? []).map((binding) => [
      binding.class_name,
      { type: "durable-object", storage: "sqlite" } satisfies WfpDurableObjectExport,
    ]),
  );
}

/** Build the metadata part from server-owned config only. `exports` replaces legacy migrations;
 *  Cloudflare rejects an upload that specifies both. */
export function buildMetadata(
  config: TenantScriptConfig,
  module: ScriptModule,
  secrets: Record<string, string> = {},
): WfpMetadata {
  if (config.main !== module.filename) {
    throw new WfpDeployError("entry module filename must equal the server-owned config main");
  }
  return {
    main_module: module.filename,
    ...(config.compatibility_date ? { compatibility_date: config.compatibility_date } : {}),
    ...(config.compatibility_flags ? { compatibility_flags: config.compatibility_flags } : {}),
    bindings: toWfpBindings(config, secrets),
    exports: toWfpExports(config),
  };
}

/** Assemble the multipart body: a `metadata` JSON part + the ES-module part(s). */
export function buildFormData(metadata: WfpMetadata, module: ScriptModule, additionalModules: ScriptModule[] = []): FormData {
  assertModule(module);
  for (const additional of additionalModules) assertModule(additional);
  const filenames = new Set([module.filename]);
  for (const additional of additionalModules) {
    if (filenames.has(additional.filename)) throw new WfpDeployError("tenant module filenames must be unique");
    filenames.add(additional.filename);
  }
  if (metadata.main_module !== module.filename) {
    throw new WfpDeployError("entry module filename must equal metadata.main_module");
  }
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  const appendModule = (m: ScriptModule) => {
    const part: string | Uint8Array = m.content;
    form.append(m.filename, new Blob([part], { type: m.contentType ?? MODULE_CONTENT_TYPE }), m.filename);
  };
  appendModule(module); // the entry module — its filename must equal metadata.main_module
  for (const m of additionalModules) appendModule(m);
  return form;
}

function scriptUrl(cf: CfCreds, scriptName: string): string {
  const base = cf.apiBase ?? DEFAULT_API_BASE;
  return `${base}/accounts/${cf.accountId}/workers/dispatch/namespaces/${cf.namespace}/scripts/${scriptName}`;
}

interface CfEnvelope { success?: boolean; errors?: Array<{ code?: number; message?: string }>; result?: unknown }

async function readEnvelope(res: Response): Promise<CfEnvelope> {
  try { return (await res.json()) as CfEnvelope; } catch { return {}; }
}

/** Delete a tenant script (the delete half of the delete+recreate path). Idempotent-ish: a 404 is fine. */
export async function deleteTenantScript(cf: CfCreds, scriptName: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  assertAgentScriptName(scriptName);
  const res = await fetchImpl(`${scriptUrl(cf, scriptName)}?force=true`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${cf.apiToken}` },
  });
  if (res.status === 404) return;
  if (!res.ok) {
    const env = await readEnvelope(res);
    throw new WfpDeployError(`WfP delete '${scriptName}' failed (${res.status}): ${env.errors?.map((e) => e.message).join("; ") || res.statusText}`);
  }
}

export interface DeployResult { scriptName: string; result: unknown }

/**
 * Deploy a composed tenant config to WfP via the multipart script-upload API. The composer's
 * forward-only ledger still rejects class removal before this point; the live upload declares the
 * current validated classes through `metadata.exports` so Cloudflare provisions SQLite-backed DOs.
 *
 * @param scriptName the WfP script name = the OC agent id (`agt_…`); one script per agent.
 */
export async function deployTenantScript(
  cf: CfCreds,
  scriptName: string,
  compose: ComposeResult,
  module: ScriptModule,
  opts: DeployOptions = {},
): Promise<DeployResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  assertAgentScriptName(scriptName);

  if (opts.recreate) await deleteTenantScript(cf, scriptName, fetchImpl);

  const metadata = buildMetadata(compose.config, module, opts.secrets ?? {});
  const form = buildFormData(metadata, module, opts.additionalModules ?? []);

  // NB: do NOT set content-type — fetch derives the multipart boundary from the FormData body.
  const res = await fetchImpl(scriptUrl(cf, scriptName), {
    method: "PUT",
    headers: { authorization: `Bearer ${cf.apiToken}` },
    body: form,
  });

  const env = await readEnvelope(res);
  if (!res.ok || env.success === false) {
    const detail = env.errors?.map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ") || res.statusText;
    throw new WfpDeployError(`WfP upload '${scriptName}' failed (${res.status}): ${detail}`);
  }
  return { scriptName, result: env.result };
}
