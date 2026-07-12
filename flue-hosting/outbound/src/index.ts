// Fail-closed egress boundary for WfP tenant Workers (design 013 §5.1/B5). The dispatch Worker
// supplies only the agent id as an outbound parameter; this Worker fetches that agent's current
// hostname allowlist over a dedicated read-only control-plane route and caches it briefly.

export interface Env {
  policy?: { agent_id?: string };
  EGRESS_POLICY_URL?: string;
  EGRESS_POLICY_SECRET: string;
  MANAGED_EGRESS_HOSTS?: string;
}

interface CacheEntry { hosts: string[]; expires: number }
const cache = new Map<string, CacheEntry>();
const CACHE_MS = 30_000;
const DEFAULT_POLICY_URL = "https://api.opencomputer.dev/internal/flue/egress-policy";

function matches(host: string, rule: string): boolean {
  return rule.startsWith("*.") ? host.endsWith(rule.slice(1)) && host !== rule.slice(2) : host === rule;
}

function managedHosts(env: Env): string[] {
  return (env.MANAGED_EGRESS_HOSTS ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
}

async function policy(env: Env, agentId: string): Promise<string[] | null> {
  const hit = cache.get(agentId);
  if (hit && hit.expires > Date.now()) return hit.hosts;
  if (!env.EGRESS_POLICY_SECRET) return null;
  const base = (env.EGRESS_POLICY_URL || DEFAULT_POLICY_URL).replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/${encodeURIComponent(agentId)}`, {
      headers: { "x-flue-egress-auth": env.EGRESS_POLICY_SECRET },
    });
    if (!res.ok) return null;
    const body = await res.json() as { allowlist?: unknown };
    if (!Array.isArray(body.allowlist) || body.allowlist.some((v) => typeof v !== "string")) return null;
    const hosts = (body.allowlist as string[]).map((v) => v.toLowerCase());
    cache.set(agentId, { hosts, expires: Date.now() + CACHE_MS });
    return hosts;
  } catch {
    return null;
  }
}

const error = (status: number, type: string, message: string) =>
  Response.json({ error: { type, message } }, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Flue's internal DO/registry subrequests use synthetic hosts and must remain byte-exact.
    if (url.hostname.endsWith(".invalid") || url.hostname.endsWith(".local")) return fetch(request);
    if (url.protocol !== "https:") return error(403, "egress_denied", "only HTTPS egress is allowed");

    const agentId = env.policy?.agent_id;
    if (!agentId) return error(403, "egress_denied", "missing tenant egress identity");
    const allowlist = await policy(env, agentId);
    if (!allowlist) return error(503, "egress_policy_unavailable", "egress policy unavailable");
    const host = url.hostname.toLowerCase();
    if (![...managedHosts(env), ...allowlist].some((rule) => matches(host, rule))) {
      return error(403, "egress_denied", "hostname is not on this agent's egress allowlist");
    }
    return fetch(request);
  },
};

export function _clearPolicyCache(): void { cache.clear(); }
