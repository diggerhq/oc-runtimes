# flue-hosting — WfP dispatch Worker + tenant-script deploy (W5)

Work item **W5** of the Flue-native buildout (`oc-bg-agents/.agents/work/flue-native-buildout.md`, design `013 §3/§6`, contract **#4**). Hosts stock `flue build --target cloudflare` Workers as tenant scripts on Workers-for-Platforms, reached **byte-exact** through the mandatory auth-boundary dispatch Worker.

Two pieces (each independently tested, in-process, no live CF needed for CI):

| Dir | What | Tests |
|---|---|---|
| `dispatch/` | the dispatch Worker — auth boundary + byte-exact forward + tailer kick | 7 ✓ |
| `deploy/` | the contract-#4 wrangler composer (`compose-wrangler.ts`) + the multipart WfP script-upload deploy step (`wfp-deploy.ts`) — synthesizes the migration ledger + OC bindings, then uploads them so `migrations` land on the script | 23 ✓ |

> ## ⛔ NEVER `wrangler deploy` a tenant
> `wrangler deploy --dispatch-namespace <ns>` **silently drops the Durable Object migrations** — the
> uploaded script lands with `migrations: null`, so its SQLite-backed DO 500s at runtime with
> **"SQL is not enabled"** (surfaced by the W6 live run, 2026-07-07). Wrangler is NOT a supported tenant
> vehicle. The **only** supported path is the multipart Workers-for-Platforms script-upload API
> (`deploy/src/wfp-deploy.ts` → `PUT …/dispatch/namespaces/{ns}/scripts/{name}`), which carries the
> composed `migrations` (`new_sqlite_classes`) in the `metadata` part. This governs W5 **and W7**.

---

## The admit URL / shape (W5 → W1 seam — sessions-api calls this)

sessions-api is a Node service and **cannot** call `env.DISPATCHER` (a Worker binding), so it materializes/admits a turn by **HTTP to the dispatch Worker**:

```
POST  https://<dispatch-worker>/dispatch/<agt_id>/agents/<agent_name>/<ses_id>
  X-Flue-Dispatch-Auth: <DISPATCH_AUTH_SECRET>  # dedicated control-plane bearer
  content-type: application/json
  { "message": <content> }                       # 1a: the body key is `message`, NOT `prompt`
```

- **Script selection = the first path segment after `/dispatch/`** = `<agt_id>` (the OC agent id = the WfP script name; one script per agent, revisions are versions of it). The dispatch Worker does `env.DISPATCHER.get(<agt_id>).fetch(rewritten)`.
- **Byte-exact:** the dispatch Worker strips `/dispatch/<agt_id>`, so the tenant Worker receives **exactly** `POST /agents/<agent_name>/<ses_id>` with the same body/query (host constraint 1 — the DO parses exact path tails; any transform silently terminalizes lost submissions). All tenant tails work the same way: `…/abort`, `…/attachments/<id>`, `GET …?view=updates` (stream read), `POST /workflows/:name`, `GET /runs/:runId`, `ALL /channels/:name`.
- **Auth boundary (B5):** verified **before** any forward. Only the dedicated `X-Flue-Dispatch-Auth` control-plane bearer is accepted; browser client tokens terminate at sessions-api, which performs grant/scope/revocation checks and dispatches internally. Tenant scripts have no other route (no workers.dev, no custom domain). The control header is stripped before the tenant sees the request. W9 adds provider-authenticated channel ingress as an explicit route class.

**Preview egress:** the namespace outbound Worker allows only Flue's exact synthetic hosts plus the
comma-separated platform hosts configured in its own `MANAGED_EGRESS_HOSTS`. It does not fetch a
per-agent policy, so model calls have no sessions-api dependency. Tenant-configurable allowlists are
deferred until external tenants need them.

## The tailer kick (W5 → W1/W2 seam)

On every **inbound admit** (a `POST` to exactly `/agents/<name>/<ses>` — not stream reads, aborts, or attachment tails), the dispatch Worker fires, via `waitUntil`:

```
POST  <SESSIONS_API_URL>/internal/flue/kick
  X-Flue-Kick-Auth: <KICK_AUTH_SECRET>
  { "session_id": "<ses_id>" }
```

The tailer (W2) wakes and pulls `view=updates` until the submission settles. The kick is a latency doorbell; a bounded sessions-api reconciler re-drives stale nonterminal Flue sessions after a missed kick or process restart.

## The wrangler composer (contract #4)

`flue build --target cloudflare` emits `durable_objects.bindings` (the DO class names) but **never** a `migrations` array (Spike B, Explore-confirmed) — deploying that as-is is a hard SQLite-DO runtime failure. `composeWrangler(generated, ocBindings, priorLedger)`:

- **synthesizes `migrations`** from the emitted class names (`Flue<Pascal>Agent` / `Flue<Pascal>Workflow` + the always-present `FlueRegistry`) as an **append-never-reorder** ledger: first deploy → one tag with all classes; adding an agent → a new tag with only the new class; a behavior-only revision → ledger no-op; **removing a migrated class → throws** (forward-only; DO class-identity change ships blue/green, `013 §6.1`).
- **injects OC bindings:** `OC_GATEWAY` (W3's gateway URL), `OC_INGEST`, optional `OC_SESSION_TOKEN` (static seam option (b) only) / `Sandbox` (cloudflareSandbox only — `ocSandbox` needs no binding).
- **enforces floors:** `compatibility_date ≥ 2026-04-01`, `nodejs_compat` (never downgrades a stricter user value).

**Deploy rule:** upload **only** this composed config — never ship the generated `wrangler.json` alongside (wrangler would pick the empty-migration one → hard failure).

## The deploy step (`deploy/src/wfp-deploy.ts`) — the multipart WfP upload

The composer produces the config + ledger; **this step is what actually reaches Cloudflare**, and it MUST be the raw multipart script-upload — not `wrangler deploy` (see the ⛔ above; wrangler drops `migrations`). `deployTenantScript(cf, scriptName, composeResult, module, opts)`:

- **`PUT https://api.cloudflare.com/client/v4/accounts/{acct}/workers/dispatch/namespaces/{ns}/scripts/{name}`** with a `multipart/form-data` body = a `metadata` JSON part + the ES-module part(s). `scriptName` = the OC agent id (`agt_…`); one script per agent.
- **`metadata` part** carries `main_module`, `compatibility_date`/`compatibility_flags`, `bindings` (vars→`plain_text`, DO bindings→`durable_object_namespace`, secrets→`secret_text`), and — the whole point — **`migrations`** = a single WfP step derived by `migrationForUpload(composeResult)` from the composer's ledger: first deploy → `{new_tag:"v1", new_sqlite_classes:[…all classes]}`; adding an agent → `{old_tag:"v1", new_tag:"v2", new_sqlite_classes:[…new class only]}`; a behavior-only revision → `null` (nothing to migrate). This is where `new_sqlite_classes` lands on the script.
- **The module part's filename must equal `metadata.main_module`.** The step uploads the already-bundled `flue build --target cloudflare` artifact verbatim — it does NOT bundle.
- **Changed-migration re-apply is impossible in place** (WfP rejects it). Pass `{ recreate: true }` to delete+recreate the script and replay the FULL ledger as one fresh migration (design 013 §6.1, blue/green).

W7's `oc deploy` composes then calls `deployTenantScript` (binding the minted `OC_SESSION_TOKEN` via `opts.secrets`). CF creds (`accountId`/`apiToken`) grep from `sessions-api/.env.v3` — never `source` it, never commit the token; upload only to a **throwaway** namespace, never the prod `opencomputer-agent` ns.

---

## Live WfP — status & the 500-DO-class experiment (gates W7)

**Byte-exact hosting of a stock Flue Worker is already proven** (Spike B + 1a, on real WfP). The remaining live must-confirm is the **500-DO-classes-per-account cap**: if a tenant script's DO classes count account-wide, agents/account ≈ 500 ÷ classes-per-script → **shard across accounts** (blocks W7, not the spine).

**Method (ready to run; must be on Mo's WfP account — `CLOUDFLARE_ACCOUNT_ID` in `sessions-api/.env.v3`; NEVER the prod `opencomputer-agent` ns; tear down via CF API):**

1. Create a **throwaway** dispatch namespace: `POST /accounts/{acct}/workers/dispatch/namespaces {name:"oc-flue-500test"}`.
2. Deploy **2–3 tenant scripts**, each declaring **K distinct DO classes** (e.g. `FlueAAgent…FlueEAgent` + `FlueRegistry`, K=6) with a `new_sqlite_classes` migration, via the WfP script-upload API (`PUT …/dispatch/namespaces/{ns}/scripts/{name}`, multipart: ES-module + metadata with `migrations` + `durable_objects`).
3. Observe: does deploying script #2 (another K classes) **succeed**, and does the account's DO-class/namespace usage rise by **K per script** (account-wide) or stay isolated per script? The cap surfaces as a deploy error at the ceiling — push K high on a single script (or many scripts) until the error, and read the limit from it.
4. **Tear down every path:** `DELETE …/scripts/{name}` for each, then `DELETE …/dispatch/namespaces/{ns}`.

**Interpretation:** account-wide counting → per-account agent ceiling = `500 / (agents-per-app + workflows-per-app + 1 registry)` → shard tenants across accounts (a pool of WfP accounts, agent→account map). Per-script (isolated) → single-account tenancy is fine. Report the number into the working doc's Open-decisions.

**Harness read-only-validated (2026-07-05):** the CF creds in `sessions-api/.env.v3` work against Mo's account `b8f23c…`; the account has exactly **one** dispatch namespace — `opencomputer-agent` (prod, ~336 scripts — **never touch**). So the experiment must **create** a fresh throwaway ns (e.g. `oc-flue-500test`) for steps 1–4. Starting state confirmed; the deploy/count/teardown mutations are the remaining run.

> Only the read-only probe (namespace list) was run this pass — no mutations, no deploys (live-account caution + context budget). The dispatch Worker + composer — the net-new W5 code — are complete and tested; the deploy-count-teardown experiment is the isolated remaining step, safe to run in a fresh context with the guardrails above.
