// Deploy a composed tenant config to Workers-for-Platforms via the RAW multipart script-upload API
// (contract #4, design 013 §3/§6). This is the ONLY supported vehicle for tenant scripts.
//
// ⚠️  NEVER deploy a tenant with `wrangler deploy --dispatch-namespace <ns>`. Wrangler SILENTLY DROPS
//     the Durable Object migrations — the uploaded script lands with `migrations: null`, so its
//     SQLite-backed DO 500s at runtime with **"SQL is not enabled"** (W6, 2026-07-07). The migrations
//     (`new_sqlite_classes`) only survive when carried in the `metadata` part of THIS multipart PUT.
//
// This step consumes the contract-#4 composer output (`ComposeResult` from compose-wrangler.ts) and
// PUTs it to:
//   PUT https://api.cloudflare.com/client/v4/accounts/{acct}/workers/dispatch/namespaces/{ns}/scripts/{name}
// with a multipart/form-data body = an ES-module part + a `metadata` part carrying `main_module`,
// `bindings` (incl. the `durable_object_namespace` bindings), `compatibility_*`, and — critically —
// the `migrations` object synthesized by the composer's append-never-reorder ledger.

import type { ComposeResult, GeneratedWrangler, MigrationEntry } from "./compose-wrangler.js";

const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";
const MODULE_CONTENT_TYPE = "application/javascript+module";

/** A single WfP migration step (the shape the script-upload `metadata.migrations` field accepts). */
export interface SingleStepMigration {
  old_tag?: string;
  new_tag: string;
  new_sqlite_classes: string[];
}

/** A WfP script binding (subset — the ones OC tenant scripts use). */
export type WfpBinding =
  | { type: "plain_text"; name: string; text: string }
  | { type: "secret_text"; name: string; text: string }
  | { type: "durable_object_namespace"; name: string; class_name: string; script_name?: string };

/** The `metadata` part of the multipart upload. */
export interface WfpMetadata {
  main_module: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  bindings: WfpBinding[];
  migrations?: SingleStepMigration;
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
  namespace: string; // WfP dispatch namespace (a THROWAWAY ns for checks; NEVER `opencomputer-agent`)
  apiBase?: string;
}

export interface DeployOptions {
  /** Extra secret bindings (uploaded as `secret_text` — e.g. `OC_SESSION_TOKEN`). Override same-named vars. */
  secrets?: Record<string, string>;
  /** Extra ES modules besides the entry (chunks/sourcemaps), if the build emits them. */
  additionalModules?: ScriptModule[];
  /** Re-applying a CHANGED migration is impossible in place — WfP rejects it. Set to delete+recreate
   *  the script and replay the FULL ledger as one fresh migration (design 013 §6.1, blue/green). */
  recreate?: boolean;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class WfpDeployError extends Error {}

/** Flatten the append-only ledger into every SQLite class it has ever introduced (first-seen order). */
function allLedgerClasses(ledger: MigrationEntry[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of ledger) for (const c of m.new_sqlite_classes ?? []) if (!seen.has(c)) { seen.add(c); out.push(c); }
  return out;
}

/**
 * Derive the single WfP migration to send from the composer output.
 * - Normal (incremental) update against a script already at the previous tag: the last ledger step,
 *   `old_tag` = the tag before it (undefined when it's the first). Behavior-only revision (no new
 *   classes) → `null` (nothing to migrate; the script keeps its current tag).
 * - `recreate`: the script is being deleted+recreated, so there is NO migration history to build on —
 *   apply EVERY class the ledger has ever introduced in one fresh migration tagged at the current tag.
 */
export function migrationForUpload(compose: ComposeResult, recreate = false): SingleStepMigration | null {
  const { ledger, addedClasses } = compose;
  if (!ledger.length) return null;
  const newTag = ledger[ledger.length - 1]!.tag;

  if (recreate) {
    return { new_tag: newTag, new_sqlite_classes: allLedgerClasses(ledger) };
  }
  if (!addedClasses.length) return null; // behavior-only revision — no class migration needed
  const oldTag = ledger.length >= 2 ? ledger[ledger.length - 2]!.tag : undefined;
  return { ...(oldTag ? { old_tag: oldTag } : {}), new_tag: newTag, new_sqlite_classes: addedClasses };
}

/** Convert the composed wrangler config's vars + DO bindings (+ secrets) into WfP script bindings. */
export function toWfpBindings(config: GeneratedWrangler, secrets: Record<string, string> = {}): WfpBinding[] {
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
      ...(b.script_name ? { script_name: b.script_name } : {}),
    });
  }
  return bindings;
}

/** Build the `metadata` part. `migration` is carried through verbatim — this is where `migrations`
 *  MUST land (the whole point of this deploy path vs. `wrangler deploy`, which drops it). */
export function buildMetadata(
  config: GeneratedWrangler,
  module: ScriptModule,
  migration: SingleStepMigration | null,
  secrets: Record<string, string> = {},
): WfpMetadata {
  return {
    main_module: module.filename,
    ...(config.compatibility_date ? { compatibility_date: config.compatibility_date } : {}),
    ...(config.compatibility_flags ? { compatibility_flags: config.compatibility_flags } : {}),
    bindings: toWfpBindings(config, secrets),
    ...(migration ? { migrations: migration } : {}),
  };
}

/** Assemble the multipart body: a `metadata` JSON part + the ES-module part(s). */
export function buildFormData(metadata: WfpMetadata, module: ScriptModule, additionalModules: ScriptModule[] = []): FormData {
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

export interface DeployResult { scriptName: string; migration: SingleStepMigration | null; result: unknown }

/**
 * Deploy a composed tenant config to WfP via the multipart script-upload API. Consumes the composer's
 * `ComposeResult` so the synthesized `migrations` (`new_sqlite_classes`) travel in the metadata part —
 * the ONLY way DO migrations reach the uploaded script (never `wrangler deploy`).
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

  if (opts.recreate) await deleteTenantScript(cf, scriptName, fetchImpl);

  const migration = migrationForUpload(compose, opts.recreate);
  const metadata = buildMetadata(compose.config, module, migration, opts.secrets ?? {});
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
  return { scriptName, migration, result: env.result };
}
