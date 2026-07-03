# @opencomputer/flue

Run a [Flue](https://flue.build) agent as an OpenComputer Durable Agent
Session. Your agent code stays plain Flue; this package supplies the entry
that connects it to the platform, and a build command that produces the
deployable artifact.

```ts
// src/opencomputer.ts — the only OpenComputer-specific file in your app
import { serveOC } from "@opencomputer/flue";
import agent from "./agents/support-triage.js";

serveOC(agent);
```

```bash
npx oc-flue-build   # → dist-oc/{oc.js, artifact.json, skills/**}
oc agent deploy     # builds, uploads, boot-verifies, activates a revision
```

## What `serveOC` does

- Runs your agent as the session's resident process behind OpenComputer's
  turn contract (one HTTP surface: `/healthz`, `/turn`).
- Opens Flue's conversation store on the session's state volume — history
  survives process restarts, hibernation, and machine moves. Don't add a
  `db.ts`; a second store would fork the history.
- Routes Flue's built-in `read`/`write`/`edit`/`bash`/`grep`/`glob` tools to
  the session's workspace sandbox (a separate machine where attached repos
  are checked out). Leave `sandbox:` unset; setting one fails the deploy.
- Injects two tools: `say` (user-visible progress message) and `ask` (ask
  the user and end the run — the session hibernates at zero cost until the
  reply arrives as the next message).
- Subordinates durability to the platform: one attempt per turn, timeout
  wired to the turn deadline. Crash recovery re-attaches to a still-running
  engine instead of re-running it, so model spend is not duplicated.

## The profile

Checked at build and again at deploy — failures are build errors with clear
messages, never turn-time surprises:

- Model is `anthropic/<id>`, declared identically in `defineAgent`,
  `agent.toml`, and the OC agent.
- No `sandbox:`, no `db.ts`, no API keys anywhere in the repo or bundle
  (the deploy scans for key-shaped strings). Model credentials come from
  your OpenComputer account.
- Custom tool names must avoid `bash`, `read`, `write`, `edit`, `ls`,
  `grep`, `glob`, `say`, `ask`.
- Skills live at `src/skills/<name>/SKILL.md` and ship with each deploy;
  packaged `with {type:'skill'}` imports are not supported yet.
- Custom tools run inside the deployed bundle: `import` anything they need
  (the repo checkout is not on the app's filesystem), and make network
  calls through declared credentials only.

`flue dev` keeps working locally throughout — this package changes nothing
about your local loop.

Start from the template: [diggerhq/oc-flue-starter](https://github.com/diggerhq/oc-flue-starter).
Full docs: [docs.opencomputer.dev/agent-sessions/flue](https://docs.opencomputer.dev/agent-sessions/flue).
