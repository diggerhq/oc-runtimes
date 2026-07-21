# oc-runtimes

Runtime images for OpenComputer Durable Agent Sessions. This repo is the source of truth
for runtime code; `sessions-api` holds the host only. Full contract spec: design 011
(§11 contracts, §12 journeys).

```
adapter-core/   @oc/adapter-core      shared per-turn driver (runAdapter + RuntimeSpec)
claude/         @oc/runtime-claude    Claude Agent SDK brain
codex/          @oc/runtime-codex     Codex SDK brain
pi/             @oc/runtime-pi        pi coding agent brain (earendil-works/pi, MIT)
```

## How it works

Two processes per brain sandbox:

- **brain** (`dist/server.js`) — resident HTTP server wrapping the harness SDK. OC-unaware:
  knows its SDK, a model endpoint, tools-over-MCP, and a state dir. Survives across turns
  and hibernate/wake (same pid), so SDK boot is paid once per box, not per turn.
- **adapter** (`dist/adapter.js`) — exec'd by the host once per turn. Owns everything
  OC-shaped: reads the turn's input window from the events API (paginated, `level=user`),
  materializes skills, hosts the MCP tool server on a stable port, ensures/starts/kills
  the brain, streams `/turn`, translates native steps to OC events, appends them durably,
  maps the outcome to an exit code.

Durability: events spool to disk before append; appends carry idempotency keys
(`rt:<turn>:<base+n>`); the host advances the key base across crash-retries of the same
turn, so replays never collide and never drop. A 401 on append means the turn was fenced
(superseded): stop quietly, exit 0, the successor owns completion.

Tools run on a separate **hands** sandbox, never on the brain. The brain calls the
adapter's MCP host; the host proxies to hands and emits the tool events
(`tool.call`/`exec.completed`/`agent.message`) itself — the brain's stream never carries
them. Tools are valid only while a `/turn` is in flight; the MCP host dies with the
adapter.

## Contracts

**Host → adapter**: one exec per turn (`cd <runtime> && <entrypoint>`), config via `OC_*`
env: `OC_API_URL`, `OC_SESSION_ID`, `OC_TURN_ID`, `OC_TURN_TOKEN` (fenced), the input
window `OC_EVENTS_CURSOR` (exclusive lower) / `OC_INPUT_TO_SEQ` (inclusive upper, absent =
unbounded), `OC_EVENT_KEY_BASE`, `OC_RUNTIME_STATE_DIR`, `OC_MODEL`, `OC_AGENT_PROMPT`,
`OC_ENDPOINT_PROFILE` (managed model routing), `OC_SKILL_BUNDLE_DIGEST`/`OC_SKILLS_ROOT`.
Exit 0 = clean (done, awaiting input, or fenced); non-zero = crash, host re-execs the SAME
turn (bounded attempts + crash-loop breaker). `needs_input` rides the ask event's
`awaiting_input: true` marker, not the exit code.

**Adapter → brain** (localhost HTTP): `GET /healthz` →
`{status:"ready", contract_version:"1", busy}`. `POST /turn` with
`{contract_version, turn_id, input:[{role,content}], config:{model, system_prompt,
mcp_endpoint, state_dir, resume, max_turns, endpoint_profile}}` → NDJSON, one native SDK
step per line, terminal `{"kind":"done","reason":"quiescent"|"awaiting_input"|"error"}`.
One turn at a time (busy → 409). Everything in `config` is turn-invariant for the box's
life; what legitimately changes (skills digest) forces a brain restart instead. Cancel =
the adapter aborts the request; the brain must abort its SDK run.

**A runtime = a RuntimeSpec + a brain server.** The spec (`adapter-core/src/driver.ts`)
is seven knobs: `defaultModel`, `isInputForModel`, `renderInput`, `translate` (native
step → OC events), `sourcesNote`, `skillsDir`, `mcpTools`. Use the exported
`standardInputFilter`/`standardRenderInput` unless you have a reason: they pass user
messages + rendered `github.*` watch deliveries + canonical `http.request` payloads, and
a filter that drops machine input silently eats deliveries (neither surface has a
per-runtime gate). Claude, Codex, and Pi emit one normalized final `agent.result` usage
observation; missing or invalid provider usage stays explicitly unreported.

## Dev

```sh
# order matters: runtimes are file:-deps on adapter-core; their tsc needs its dist
cd adapter-core && npm install && npm run build && npm test
cd ../claude && npm install && npm run typecheck && npm run build   # same for codex, pi
```

- Node ≥ 20 for claude/codex; **pi needs ≥ 22.19** (its SDK) — locally too. Snapshots bake
  node22 into the pi image; its entrypoint is `node22/bin/node dist/adapter.js`.
- After touching `adapter-core/src`, rebuild it before typechecking consumers. A stale
  `adapter-core/dist` compiles clean and lies.
- Model calls MUST honor proxy env (`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`): the sealed API
  key in the box is a placeholder the egress proxy swaps on the way out. Node's built-in
  fetch ignores proxy env — pi's server routes global fetch through undici's
  `EnvHttpProxyAgent` for exactly this reason. A brain that bypasses the proxy gets
  provider 401s (and no Managed billing).
- Keep the tree clean when snapshots build from your checkout: the pipeline refuses a
  dirty tree (build rows stamp `source_ref = oc-runtimes@<sha>`).

## Shipping

No deploys from this repo. Snapshot builds run from sessions-api
(`scripts/build-runtime-snapshot.ts` with `OC_RUNTIMES_DIR` pointing at a clean checkout):
installs+builds adapter-core then the runtime, bakes an OC named snapshot
(`npm ci --install-links` — the file: dep must be a real directory in-image, not a
symlink), fork-verifies (brain boots to `/healthz` ready AND `dist/adapter.js`
import-resolves in-image), publishes to the shared catalog, records the build row.
Versions are immutable — bump the runtime's `package.json` to rebuild. Activation is
separate: owner-scoped pointer pin for canary, global pointer flip to promote, flip back
to roll back. New sessions resolve pointers at create; in-flight sessions keep their pin.
