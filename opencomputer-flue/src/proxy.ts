// Global-fetch egress-proxy bootstrap — the pi-brain fix, verbatim in shape
// (oc-runtimes/pi/src/server.ts). Node's built-in fetch ignores HTTPS_PROXY; pi-ai's
// vendor SDKs resolve globalThis.fetch at CALL time (S0a-verified), so routing the global
// fetch through undici's EnvHttpProxyAgent carries BYO model calls through the OC egress
// proxy (where the sealed placeholder key is swapped). NO_PROXY keeps localhost — the MCP
// host and the /turn loopback — direct. Managed traffic doesn't need the proxy for auth
// (registerProvider sets an explicit base URL + key) but flows the same way harmlessly.

import { EnvHttpProxyAgent } from "undici";

let installed = false;

export function installProxyFetch(): void {
  if (installed) return;
  installed = true;
  if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY) return; // nothing to route through
  process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
  const agent = new EnvHttpProxyAgent();
  const platformFetch = fetch; // capture once
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    platformFetch(input, { ...(init ?? {}), dispatcher: agent } as unknown as Parameters<typeof fetch>[1])) as typeof fetch;
}
