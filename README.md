# oc-runtimes

**The agent runtimes behind [OpenComputer Durable Agent Sessions](https://docs.opencomputer.dev/agent-sessions/overview).**

Durable Agent Sessions let you define an agent once and run **resumable, steerable** sessions against
it: the runtime restarts on crash, hibernates when idle (storage-only billing while asleep), and streams
a durable event log you can steer with messages and collect results from by webhook. **This repo is the
runtime layer** — the code that actually drives each turn inside a session's sandbox. The host (session
lifecycle, events API, leases, billing) lives in `sessions-api`; the product you point at it — dashboard,
REST API, SDKs — is [OpenComputer](https://app.opencomputer.dev).

- 📚 **Docs:** [Durable Agent Sessions overview](https://docs.opencomputer.dev/agent-sessions/overview) · [Quickstart](https://docs.opencomputer.dev/agent-sessions/quickstart) · [Custom runtimes](https://docs.opencomputer.dev/agent-sessions/custom-runtimes)
- 🖥️ **Dashboard:** [app.opencomputer.dev](https://app.opencomputer.dev)
- 📐 **Contract spec (internal):** design 011 (§11 contracts, §12 journeys)

A **runtime** is the "brain" of a session — it wraps a model or agent SDK behind one uniform contract, so
the host runs any of them the same way: one process per turn, resumable across crashes and hibernation,
with tool calls proxied to a separate sandbox. This repo is the **source of truth for runtime code**;
`sessions-api` holds only the host that invokes it.

```
adapter-core/       @oc/adapter-core     shared per-turn driver (runAdapter + RuntimeSpec)
claude/             @oc/runtime-claude   Claude Agent SDK brain
codex/              @oc/runtime-codex    OpenAI Codex SDK brain
pi/                 @oc/runtime-pi       pi coding-agent brain (earendil-works/pi, MIT)
flue/               @oc/runtime-flue     hosts a user-built Flue artifact as a brain (design 012 §11.6)
opencomputer-flue/  @opencomputer/flue   the serveOC package a Flue artifact's entry calls
```

> **Building your own runtime?** Start with the human-facing [Custom runtimes guide](https://docs.opencomputer.dev/agent-sessions/custom-runtimes), then use `claude/` or `pi/` here as a working template. A runtime is a `RuntimeSpec` (seven knobs) plus a brain server — see **Contracts** below.

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

## The runtimes

- **`adapter-core`** (`@oc/adapter-core`) — the shared per-turn driver. `runAdapter(spec)` is the whole
  adapter; a runtime supplies a `RuntimeSpec`. Content-addresses skill/artifact bundles by blob digest
  and extracts with the system tar. Every runtime is a `file:` dep on it (build it first — see Dev).
- **`claude` / `codex` / `pi`** (`@oc/runtime-claude` / `-codex` / `-pi`) — model/agent SDK brains. Same
  shape: a `RuntimeSpec` + a resident brain server. Use one as your template.
- **`flue`** (`@oc/runtime-flue`) — hosts a **user-built Flue artifact** (a self-contained ESM bundle) as
  an OC brain, instead of a baked-in SDK. Ships only the adapter-side consumer — a `RuntimeSpec`
  (FlueEvent → OC taxonomy translation, MCP subset, sources note), a launcher that resolves + imports the
  materialized artifact, and the aggregated skills-mount helper. It never links `@flue/runtime`: it knows
  Flue's wire shapes, not its code, so it hosts whichever artifact lands in it (design 012 §11.6).
- **`opencomputer-flue`** (`@opencomputer/flue`) — the `serveOC(agent)` package a Flue app's entry calls to
  become that resident brain.

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
cd ../claude && npm install && npm run typecheck && npm run build   # same for codex, pi, flue
```

- Node ≥ 20 for claude/codex; **pi and flue need ≥ 22.19** (their SDKs) — locally too. Snapshots bake
  node22 into those images; the entrypoint is `node22/bin/node dist/adapter.js`.
- After touching `adapter-core/src`, rebuild it before typechecking consumers. A stale
  `adapter-core/dist` compiles clean and lies.
- Model calls MUST honor proxy env (`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`): the sealed API
  key in the box is a placeholder the egress proxy swaps on the way out. Node's built-in
  fetch ignores proxy env — pi's server routes global fetch through undici's
  `EnvHttpProxyAgent` for exactly this reason. A brain that bypasses the proxy gets
  provider 401s (and no managed billing).
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

---

Part of [OpenComputer](https://opencomputer.dev) — durable sandboxes for AI agents.
