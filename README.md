# oc-runtimes

Runtime images for OpenComputer Durable Agent Sessions: one shared **adapter-core**
(the OC-aware per-turn driver — durable event spool + idempotent append behind fenced
leases, resident-brain supervision, the localhost MCP tool host, skills materialization,
the turn driver) plus thin per-harness runtimes that each contribute a `RuntimeSpec`
(model default, input filter/renderer, native-step translation, steering text, skills
layout, tool subset) and their brain server — nothing else.

```
adapter-core/   @oc/adapter-core      the shared driver (runAdapter + RuntimeSpec)
claude/         @oc/runtime-claude    Claude Agent SDK brain + spec
codex/          @oc/runtime-codex     Codex SDK brain + spec
pi/             @oc/runtime-pi        pi coding agent (earendil-works/pi) brain + spec
```

## Contract (the short version)

The host execs the runtime's adapter once per turn with `OC_*` env (session/turn ids, a
fenced turn token, the input-window cursor + upper bound, state dir, model + endpoint
profile). The adapter owns everything OC-shaped and drives a **resident, OC-unaware brain**
over localhost HTTP — `GET /healthz`, `POST /turn` → NDJSON native steps, then a terminal
`done {reason}`. Tools reach the world only through the adapter's MCP host; tool events are
emitted by the host's tools, never by the brain. Full contracts, journeys, and deadline
hierarchy: design 011 (§11–§12).

## Source of truth & provenance

Until the publish-pipeline home decision (011 O9, at S6), `sessions-api/runtimes/` is the
pipeline's source of truth and this repo is its faithful mirror: content lands here ONLY
via `scripts/sync-from-sessions-api.sh`, each sync commit stamped with the source sha.
Directory names here drop the legacy `v3-` route prefixes; package names are
`@oc/runtime-<name>`.

Snapshot builds run from sessions-api (`scripts/build-runtime-snapshot.ts`): fork-verify
(brain boots + the adapter's module graph resolves in-image), publish-before-record, then
an owner-pinned canary before any global pointer flip.

## pi

The pi runtime embeds `@earendil-works/pi-coding-agent` (MIT — thank you,
[earendil-works/pi](https://github.com/earendil-works/pi)) as a resident brain:
same-name tool replacement via a programmatic extension (read/bash/write proxy to the
hands sandbox; skill files serve brain-locally), stop-after-ask via `ctx.abort()` after
the ask result records, pi's native JSONL session tree as the resume artifact, and model
routing through `models.json` (BYO extends the built-in anthropic provider; Managed is a
custom provider at the platform's endpoint profile). Requires node ≥ 22.19 — the snapshot
build bakes it.
