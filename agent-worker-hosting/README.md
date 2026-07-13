# Agent Worker hosting

Framework-neutral Workers-for-Platforms hosting for OpenComputer managed agents. The permanent
production plane uses one untrusted dispatch namespace and three separately deployed components:

| Directory | Responsibility |
|---|---|
| `dispatch/` | authenticate platform dispatch, validate `agt_*`, and forward the tenant path/body byte-exact |
| `egress/` | allow only exact platform-managed HTTPS endpoints plus framework-internal synthetic requests |
| `deploy/` | provision the namespace and upload verified module-only tenant artifacts through the WfP API |

Flue is the only runtime implementation in this plane today. Its descriptor/migration composer
lives flat at `deploy/src/compose-wrangler.ts` beside the multipart uploader; do not introduce an
adapter directory until a second runtime creates a real shared interface. Do not rename real Flue
protocol or generated ABI names to make them look framework-neutral.

## Production identities

- namespace: `oc-agent-workers-prod` (untrusted)
- dispatch Worker: `oc-agent-dispatch-prod`
- egress Worker: `oc-agent-egress-prod`
- model gateway: `oc-agent-gateway-prod` (owned by the `opencomputer` repository)

The existing `opencomputer-agent` namespace is a separate production plane. Provisioning and
upload code must never select or mutate it.

## Dispatch contract

The sessions API calls:

```text
POST /dispatch/<agt_id>/agents/<flue_agent_name>/<session_id>
X-OC-Agent-Dispatch-Auth: <dedicated bearer>
X-OC-Flue-Defer-Kick: 1  # only while the control plane durably records the admitted input
```

The Worker accepts only `^agt_[0-9a-f]{24}$`, strips the two control headers, and forwards the
remaining method, path tail, query, headers and body to the selected tenant script. A successful
Flue admit is followed by a best-effort `/internal/flue/kick` using
`X-OC-Flue-Kick-Auth`; the durable reconciler remains the recovery path.

Tenant scripts have no direct route. The production dispatch binding is the only invocation path.

## Production error visibility

The production dispatch Worker attaches `opencomputer-log-tail-prod`, the existing account-level
log collector owned by the `opencomputer` repository. Cloudflare applies that tail consumer to both
the dispatch invocation and nested user-Worker invocations in `oc-agent-workers-prod`, including
Workers uploaded after the dispatch deploy. Flue keeps unknown failures out of caller-facing 500
responses but logs the original stack; the collector therefore records the actionable failure with
the tenant script name (`agt_*`) and request URL (including `ses_*`) without exposing it to clients.

Do not diagnose a managed-agent failure by changing its HTTP error envelope or uploading a debug
tenant bundle. Query the central Worker logs by tenant script/session first. A production dispatch
deploy must preserve this tail consumer; a missing collector is a production-readiness failure.

## Production egress contract

`MANAGED_EGRESS_HOSTS` contains exactly the permanent gateway hostname and
`api.opencomputer.dev`. W7-P binds `OC_GATEWAY` to the former and `OC_SANDBOX_API` to the latter;
it does not bind `OC_INGEST` or `OC_REPO_API`. `app.opencomputer.dev` is the browser/legacy edge and
is intentionally denied. A future tenant binding that introduces another network destination must
update this allowlist and its allow/deny test in the same change.

## Flue descriptor and upload boundary

The raw `wrangler.json` emitted by Flue is not an API contract. It can contain absolute build paths
and unrelated Wrangler capabilities. The CLI extracts a descriptor containing only:

```json
{
  "main": "index.js",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "no_bundle": true,
  "durable_objects": {
    "bindings": [{ "name": "FLUE_REGISTRY", "class_name": "FlueRegistry" }]
  }
}
```

Additional generated Flue agent/workflow classes may be present, but every binding is same-script
and contains only `name` and `class_name`. The adapter rejects unknown keys, external
`script_name`, routes, resources, generated vars/migrations, unsafe module paths, duplicate
bindings, profile variation, and a missing registry.

The uploader accepts only relative `.js`/`.mjs` modules and synthesizes the append-only SQLite
Durable Object migration ledger. Tenant Workers must be uploaded through the multipart WfP API;
`wrangler deploy --dispatch-namespace` is not supported because it has dropped DO migrations in
live validation.

## Explicit production commands

Production commands require the dedicated `AGENT_WORKER_WFP_*` coordinates or Worker-specific
Wrangler secrets. Default `deploy` scripts fail intentionally so an unqualified command cannot
target production.

```sh
npm --prefix agent-worker-hosting/deploy run provision:production
npm --prefix agent-worker-hosting/egress run deploy:production
npm --prefix agent-worker-hosting/dispatch run deploy:production
```

`provision:production` creates `oc-agent-workers-prod` only when absent, verifies it is untrusted,
and refuses any other configured namespace. It never toggles or deletes a namespace.

Run local checks independently in each package:

```sh
npm --prefix agent-worker-hosting/deploy test
npm --prefix agent-worker-hosting/deploy run typecheck
npm --prefix agent-worker-hosting/egress test
npm --prefix agent-worker-hosting/egress run typecheck
npm --prefix agent-worker-hosting/dispatch test
npm --prefix agent-worker-hosting/dispatch run typecheck
```
