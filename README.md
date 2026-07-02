# oc-runtimes

Runtime images for OpenComputer Durable Agent Sessions: one shared **adapter-core**
(the OC-aware per-turn driver — durable event spool, fenced leases, brain supervision,
the MCP tool host) plus thin per-harness runtimes (**claude**, **codex**, **pi**) that
each contribute only their brain server and event translation.

Private while the extraction bakes; public at launch. Design + contracts:
`oc-bg-agents/.agents/design/011-pi-runtime.md` (§11 contracts, §12 journeys).
Migration in from `sessions-api/runtimes/` per 011 §8 (S3a in-repo extraction first,
cutover here after; claude/codex brains follow at S6).

Runtime ⇄ host contract (the short version): the host execs the adapter once per turn
with `OC_*` env; the adapter owns everything OC-shaped and drives a resident,
OC-unaware brain over localhost HTTP (`/healthz`, `POST /turn` → NDJSON native steps +
a terminal `done`). Tools reach the world only through the adapter's MCP host.
