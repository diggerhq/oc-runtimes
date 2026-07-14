// Managed egress boundary for WfP tenant Workers. It has no tenant policy fetch and therefore no
// control-plane availability dependency: platform operators configure the small exact set of
// managed hosts the runtime needs (gateway, ingest, sandbox/repo API) on this Worker itself.

export interface Env {
  MANAGED_EGRESS_HOSTS: string;
}

const SYNTHETIC_HOSTS = new Set(["flue.invalid", "flue-registry.local"]);

function managedHosts(env: Env): Set<string> {
  return new Set(env.MANAGED_EGRESS_HOSTS.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
}

const error = (status: number, type: string, message: string) =>
  Response.json({ error: { type, message } }, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Flue's two internal DO/registry hosts are not network egress and must remain byte-exact.
    if (SYNTHETIC_HOSTS.has(url.hostname)) return fetch(request);
    if (url.protocol !== "https:") return error(403, "egress_denied", "only HTTPS egress is allowed");
    if (!managedHosts(env).has(url.hostname.toLowerCase())) {
      return error(403, "egress_denied", "hostname is not a platform-managed endpoint");
    }
    return fetch(request);
  },
};
