import { pathToFileURL } from "node:url";

export const PRODUCTION_NAMESPACE = "oc-agent-workers-prod";
const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";

interface NamespaceResult {
  namespace_name?: string;
  trusted_workers?: boolean;
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
}

export interface ProvisionConfig {
  accountId: string;
  apiToken: string;
  namespace: string;
  apiBase?: string;
}

export interface ProvisionResult {
  namespace: typeof PRODUCTION_NAMESPACE;
  created: boolean;
  trustedWorkers: false;
}

export class NamespaceProvisionError extends Error {}

async function envelope<T>(response: Response): Promise<CloudflareEnvelope<T>> {
  try {
    return await response.json() as CloudflareEnvelope<T>;
  } catch {
    return {};
  }
}

function failure(action: string, response: Response, body: CloudflareEnvelope<unknown>): NamespaceProvisionError {
  const details = body.errors?.map((error) => error.message).filter(Boolean).join("; ");
  return new NamespaceProvisionError(`${action} failed (${response.status})${details ? `: ${details}` : ""}`);
}

function verify(result: NamespaceResult | undefined): void {
  if (result?.namespace_name !== PRODUCTION_NAMESPACE) {
    throw new NamespaceProvisionError("Cloudflare returned an unexpected dispatch namespace");
  }
  // Cloudflare documents untrusted mode as the default and `trusted_workers` as optional. Its live
  // GET responses omit the field for default-untrusted namespaces; an explicit true enables
  // the weaker trusted mode. Accept only the documented default omission or explicit false, and
  // reject true/null/any future unrecognized representation rather than mutating the namespace.
  if (result.trusted_workers !== undefined && result.trusted_workers !== false) {
    throw new NamespaceProvisionError(
      `dispatch namespace ${PRODUCTION_NAMESPACE} must exist in untrusted mode; refusing to mutate it`,
    );
  }
}

export async function provisionProductionNamespace(
  config: ProvisionConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ProvisionResult> {
  if (!config.accountId || !config.apiToken) {
    throw new NamespaceProvisionError("AGENT_WORKER_WFP_ACCOUNT_ID and AGENT_WORKER_WFP_API_TOKEN are required");
  }
  if (config.namespace !== PRODUCTION_NAMESPACE) {
    throw new NamespaceProvisionError(`AGENT_WORKER_NAMESPACE must equal ${PRODUCTION_NAMESPACE}`);
  }

  const base = config.apiBase ?? DEFAULT_API_BASE;
  const collection = `${base}/accounts/${encodeURIComponent(config.accountId)}/workers/dispatch/namespaces`;
  const target = `${collection}/${PRODUCTION_NAMESPACE}`;
  const headers = { authorization: `Bearer ${config.apiToken}` };

  const currentResponse = await fetchImpl(target, { headers });
  const current = await envelope<NamespaceResult>(currentResponse);
  if (currentResponse.ok && current.success !== false) {
    verify(current.result);
    return { namespace: PRODUCTION_NAMESPACE, created: false, trustedWorkers: false };
  }
  if (currentResponse.status !== 404) throw failure("namespace lookup", currentResponse, current);

  const createResponse = await fetchImpl(collection, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: PRODUCTION_NAMESPACE }),
  });
  const created = await envelope<NamespaceResult>(createResponse);
  if (!createResponse.ok || created.success === false) throw failure("namespace creation", createResponse, created);
  verify(created.result);
  return { namespace: PRODUCTION_NAMESPACE, created: true, trustedWorkers: false };
}

async function main(): Promise<void> {
  const result = await provisionProductionNamespace({
    accountId: process.env.AGENT_WORKER_WFP_ACCOUNT_ID ?? "",
    apiToken: process.env.AGENT_WORKER_WFP_API_TOKEN ?? "",
    namespace: process.env.AGENT_WORKER_NAMESPACE ?? "",
  });
  process.stdout.write(
    `namespace ${result.namespace}: ${result.created ? "created" : "verified"} (untrusted)\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "namespace provisioning failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
