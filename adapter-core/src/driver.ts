// The shared per-turn ADAPTER DRIVER — the OC-aware side of every runtime (runtime.md
// §3.2/§3.7, design 011 §5.3). Extracted from the v3-claude adapter with claude/codex/pi
// as the three consumers; behavior is byte-identical to the copies it replaces (the
// conformance goldens are the proof). Per turn it:
//   1. recovers the durable spool (flush a prior crash's unacked steps, §3.7d)
//   2. reads new input at the cursor, bounded by the turn's pinned input window
//   3. materializes the session's skill bundle (spec-declared layout; restart brain on change)
//   4. starts the localhost MCP host (the brain's tools; spec-declared subset)
//   5. ensures the RESIDENT brain is up (start lock + lazy-start + /healthz, §3.7a)
//   6. POSTs /turn and consumes the brain's NATIVE NDJSON stream
//   7. translates each native step → the OC taxonomy via the SPEC's translate()
//   8. safety-nets the final answer, then maps lifecycle → exit code
//      (quiescent / awaiting_input / fenced → 0; error / crash → 1; the host reads
//       needs_input from the ask event's awaiting_input marker, not the exit code)
//   9. on a fence (401 on append) or cancel: abort /turn → grace → kill the brain → exit 0
//
// What a runtime contributes (the WHOLE per-runtime surface, design 011 §5.3):
// its brain server (never imported here — exec'd as dist/server.js beside the adapter),
// and a RuntimeSpec: model default, which events are model input and how they render,
// native-step translation, steering/sources text, the skills layout, the MCP tool subset.

import { spawn } from "node:child_process";
import { openSync, closeSync, unlinkSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { config, getEventsSince, type InEvent } from "./oc.js";
import { DurableEmitter } from "./emitter.js";
import { startMcpHost, type HostContext } from "./mcp-host.js";
import { materializeBundle, emptySkills } from "./skills.js";

export type { InEvent } from "./oc.js";
export type { DurableEmitter } from "./emitter.js";

/** Shared body→text rendering (title+text), used by most specs' renderInput. */
export function textOf(body: unknown): string {
  const b = body as { text?: string; title?: string } | undefined;
  return [b?.title, b?.text].filter(Boolean).join("\n") || "";
}

/** Passed to spec.translate alongside each native step. */
export interface TranslateCtx {
  /** The effective model id (OC_MODEL ?? spec.defaultModel), for agent.result bodies. */
  model: string;
  /** Report assistant text so the driver can promote the LAST one as the safety-net answer. */
  noteAssistantText(text: string): void;
}

/** The whole per-runtime surface. Everything else is the shared driver. */
export interface RuntimeSpec {
  /** Runtime name for logs ("claude" | "codex" | "pi"). */
  name: string;
  defaultModel: string;
  /** True for a user-facing INPUT event the model should see this turn. STRICT type
   *  allowlist — `agent.message` is ALSO user-level (the agent's own answers/asks). */
  isInputForModel(e: InEvent): boolean;
  renderInput(e: InEvent): string;
  /** Native brain step → OC taxonomy. Throwing Error("fenced") stops the turn (fence path). */
  translate(emitter: DurableEmitter, msg: unknown, ctx: TranslateCtx): Promise<void>;
  /** Session-specific system-prompt suffix (checked-out repos note); "" for none. */
  sourcesNote(): string;
  /** Where the skill bundle materializes for THIS runtime's brain, or null = skills-unaware. */
  skillsDir(stateDir: string): string | null;
  /** MCP host tool subset; undefined = the full set. */
  mcpTools?: string[];
}

const BRAIN_START_DEADLINE_MS = 30_000;
const FENCE_GRACE_MS = 5_000;

/**
 * Run one turn as this runtime's adapter process. Never returns — owns process.exit for
 * every disposition (including the fatal catch, which reuses the live emitter's key
 * sequence so a crash-path event never collides with already-spooled keys).
 */
export function runAdapter(spec: RuntimeSpec): void {
  const turnId = config.turnId;
  const cursor = Number(process.env.OC_EVENTS_CURSOR ?? "0");
  // Upper bound of THIS turn's input window (pinned at accept). Events past it belong to the
  // NEXT turn — their wakeup re-fires, so consuming them here would deliver them twice. 0/absent
  // (an older host) → unbounded, today's behavior.
  const inputToSeq = Number(process.env.OC_INPUT_TO_SEQ ?? "0") || 0;
  const agentPrompt = process.env.OC_AGENT_PROMPT ?? "You are a helpful background agent.";
  const model = process.env.OC_MODEL ?? spec.defaultModel;
  // Managed model access (token-billing §5.2): non-secret routing the host derived
  // from the sealed credential — { mode, base_url, auth_env }. Absent → BYO/default.
  const endpointProfile = process.env.OC_ENDPOINT_PROFILE ? JSON.parse(process.env.OC_ENDPOINT_PROFILE) : undefined;
  const stateDir = process.env.OC_RUNTIME_STATE_DIR ?? join(process.env.HOME ?? "/home/sandbox", ".oc/runtime-state", config.sessionId);
  const brainPort = Number(process.env.OC_BRAIN_PORT ?? "8080");
  // STABLE port for the adapter-hosted MCP server: the resident brain may pin the MCP URL
  // across turns, so every per-turn adapter must serve the same one (§ MCP-across-turns).
  const mcpPort = Number(process.env.OC_MCP_PORT ?? "8765");
  // Agent Revisions skills (design 009 §8.2): the session's pinned skill bundle digest; the
  // TARGET dir is the spec's (each brain discovers skills in its own layout). Empty digest /
  // null dir / unset root ⇒ no skills.
  const skillBundleDigest = process.env.OC_SKILL_BUNDLE_DIGEST ?? "";
  const skillsDir = spec.skillsDir(stateDir);
  const skillsRoot = process.env.OC_SKILLS_ROOT ?? "";

  // The brain is baked BESIDE the consuming adapter's entry (dist/server.js) — resolve it
  // from the PROCESS entry (dist/adapter.js), not from this module (which lives in the
  // adapter-core package's own dist when installed as a dependency).
  const entryDir = dirname(process.argv[1] ?? ".");
  const brainServerPath = join(entryDir, "server.js");
  const lockPath = join(stateDir, "brain.lock");
  const pidPath = join(stateDir, "brain.pid");
  const logPath = join(stateDir, "brain.log");

  // Module-scoped so the fatal-catch path reuses the SAME key sequence (a fresh emitter
  // would restart at base+0 and collide with already-spooled keys).
  let emitter: DurableEmitter | null = null;
  let lastAssistantText = "";
  const translateCtx: TranslateCtx = {
    model,
    noteAssistantText: (t: string) => { lastAssistantText = t; },
  };

  // ── Brain supervision (§3.7a) ──────────────────────────────────────────────

  async function brainStatus(): Promise<{ up: boolean; busy: boolean }> {
    try {
      const r = await fetch(`http://127.0.0.1:${brainPort}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) return { up: false, busy: false };
      const j = (await r.json()) as { status?: string; busy?: boolean };
      return { up: j.status === "ready", busy: Boolean(j.busy) };
    } catch {
      return { up: false, busy: false };
    }
  }

  async function waitHealthy(deadlineMs: number): Promise<boolean> {
    const until = nowPlus(deadlineMs);
    while (Date.now() < until) {
      if ((await brainStatus()).up) return true;
      await sleep(250);
    }
    return false;
  }

  /**
   * Ensure a READY, IDLE resident brain.
   *  - up & idle → reuse (warm path).
   *  - up & BUSY → an orphaned query from a turn whose adapter was killed externally
   *    (the deadline SIGKILLs the adapter before it can abort the brain, leaving the
   *    brain stuck busy=true → every later turn gets 409). Turns are fence-serialized,
   *    so a busy brain at turn start is ALWAYS stale → kill + restart.
   *  - down → lazy-start.
   */
  async function ensureBrain(): Promise<void> {
    const st = await brainStatus();
    if (st.up && !st.busy) return;
    if (st.up && st.busy) {
      console.error("[adapter] brain busy at turn start (orphaned prior turn) — killing + restarting");
      killBrain();
      await sleep(300);   // let the listen port free before respawn
    }
    await startBrain();
  }

  async function startBrain(): Promise<void> {
    let lockFd = acquireStartLock();        // exclusive O_EXCL: serializes a racing adapter
    if (lockFd == null) {
      if (await waitHealthy(5000)) return;   // another adapter is starting → wait briefly
      safeUnlink(lockPath);                  // still down → stale lock (killed adapter) → steal
      lockFd = acquireStartLock();
      if (lockFd == null) {
        if (await waitHealthy(BRAIN_START_DEADLINE_MS)) return;
        throw new Error("brain did not become ready (contended start)");
      }
    }
    try {
      if ((await brainStatus()).up) return;  // came up under the lock
      const logFd = openSync(logPath, "a");  // crash log (NOT the event log)
      const child = spawn(process.execPath, [brainServerPath], {
        detached: true,                      // own process group → killBrain can reap its SDK/CLI child
        env: { ...process.env, OC_BRAIN_PORT: String(brainPort) },
        stdio: ["ignore", logFd, logFd],
      });
      child.unref();                         // resident: survives this adapter's exit
      closeSync(logFd);
      if (child.pid) writeFileSync(pidPath, String(child.pid));
      if (!(await waitHealthy(BRAIN_START_DEADLINE_MS))) {
        killBrain();
        throw new Error(`brain did not become ready within ${BRAIN_START_DEADLINE_MS}ms`);
      }
    } finally {
      if (lockFd != null) closeSync(lockFd);
      safeUnlink(lockPath);
    }
  }

  function acquireStartLock(): number | null {
    try { return openSync(lockPath, "wx"); } catch { return null; }
  }

  function killBrain(): void {
    try {
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, "utf8").trim());
        if (Number.isFinite(pid) && pid > 0) {
          // The brain is detached (its own process group) → kill the GROUP so its SDK/CLI
          // child dies too; an orphaned query left alive would keep the box busy.
          try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
        }
      }
    } catch {
      // already gone
    }
    safeUnlink(pidPath);
    safeUnlink(lockPath);
  }

  // ── NDJSON line reader over the brain's /turn response stream ───────────────

  async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) { try { yield JSON.parse(line); } catch { /* torn line — skip */ } }
      }
      if (done) break;
    }
    const tail = buf.trim();
    if (tail) { try { yield JSON.parse(tail); } catch { /* ignore */ } }
  }

  /**
   * Materialize the session's pinned skill bundle into the spec's skills dir before the
   * brain starts (design 009 §8.2). Effectively once-per-box-per-digest (warm cache hit
   * skips). Two-step signed-URL fetch so the turn token never reaches R2. Returns true when
   * the live skills target CHANGED (caller restarts the resident brain so it re-reads them).
   * Throws → the caller fails the turn.
   */
  async function materializeSkills(): Promise<boolean> {
    if (!skillsDir || !skillsRoot) return false; // runtime is skills-unaware — no-op
    mkdirSync(skillsRoot, { recursive: true });
    const cacheFile = join(stateDir, "skills.digest");
    const cached = existsSync(cacheFile) ? readFileSync(cacheFile, "utf8").trim() : "";

    if (!skillBundleDigest) {
      if (cached === "" && existsSync(skillsDir)) return false; // already empty
      const { changed } = emptySkills({ skillsRoot, skillsDir });
      writeFileSync(cacheFile, "");
      return changed;
    }
    if (cached === skillBundleDigest && existsSync(skillsDir)) return false; // warm cache hit

    // Fetch by digest in TWO steps so the turn token never reaches R2: (1) ask the control plane
    // (with X-Turn-Token) for a short-lived signed URL — it verifies the digest against the session
    // snapshot; (2) download the bundle from that URL with NO auth header (the signed URL is
    // self-authenticating). materializeBundle re-verifies the fileset digest before swapping.
    const metaUrl = `${config.apiUrl}/v3/sessions/${config.sessionId}/skill-bundle?digest=${encodeURIComponent(skillBundleDigest)}&mode=url`;
    const meta = await fetch(metaUrl, { headers: { "X-Turn-Token": config.turnToken } });
    if (!meta.ok) throw new Error(`skill-bundle ${meta.status}: ${await meta.text().catch(() => "")}`);
    const { url } = (await meta.json()) as { url: string };
    const r = await fetch(url); // NO headers — never send the turn token to R2
    if (!r.ok) throw new Error(`skill-bundle download ${r.status}`);
    const tarGz = Buffer.from(await r.arrayBuffer());
    const { changed } = materializeBundle({ tarGz, expectedDigest: skillBundleDigest, skillsRoot, skillsDir });
    writeFileSync(cacheFile, skillBundleDigest);
    return changed;
  }

  // ── Main ─────────────────────────────────────────────────────────────────────

  async function main(): Promise<void> {
    mkdirSync(stateDir, { recursive: true });
    emitter = new DurableEmitter(stateDir, turnId);
    const em = emitter;     // non-null alias (the module `let` widens to | null after awaits)
    const flushed = await em.recover();
    if (flushed) console.error(`[adapter] recovered ${flushed} spooled step(s) from a prior attempt`);

    // Input: the new user messages at the cursor (the brain's own resume carries history),
    // bounded above by the turn's pinned input window.
    const inputs: InEvent[] = await getEventsSince(cursor);
    const prompt = inputs
      .filter((e) => inputToSeq === 0 || Number(e.seq) <= inputToSeq)
      .filter((e) => spec.isInputForModel(e))
      .map((e) => spec.renderInput(e))
      .join("\n\n") || "(no new input)";

    // §8.2 reorder — materialize skills FIRST (before the MCP host + brain), so the brain reads
    // them at start. Never run a turn without the declared skills: a materialize failure
    // fails the turn (classified skills_materialize) rather than silently running without them.
    try {
      const skillsChanged = await materializeSkills();
      if (skillsChanged) killBrain(); // a resident brain (warm box) must restart to pick up new skills
    } catch (err) {
      await em.emit({ type: "error.runtime", level: "internal", body: { code: "skills_materialize", retriable: false, message: err instanceof Error ? err.message : String(err) } }).catch(() => {});
      await em.drain().catch(() => {});
      console.error("[adapter] skills materialize failed — failing turn:", err);
      process.exit(1);
    }

    const ctx: HostContext = { sawUserFacing: false, awaitingInput: false };
    const host = await startMcpHost(em, ctx, mcpPort, spec.mcpTools);

    const ac = new AbortController();
    let fenced = false;
    let brainSteps = 0;     // native steps the brain streamed (excl. the terminal `done`)
    let terminalReason: string | null = null;
    let terminalError: { type?: string; message?: string } | undefined;

    try {
      await ensureBrain();

      const resume = existsSync(join(stateDir, "journal"));
      const res = await fetch(`http://127.0.0.1:${brainPort}/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          contract_version: "1",
          turn_id: turnId,
          input: [{ role: "user", content: prompt }],
          config: { model, system_prompt: `${agentPrompt}${spec.sourcesNote()}`, mcp_endpoint: host.url, state_dir: stateDir, resume, max_turns: 24, endpoint_profile: endpointProfile },
        }),
      });
      if (!res.ok || !res.body) throw new Error(`brain /turn ${res.status}: ${await res.text().catch(() => "")}`);

      for await (const step of ndjsonLines(res.body)) {
        if (step?.kind === "done") { terminalReason = step.reason ?? "quiescent"; terminalError = step.error; break; }
        brainSteps++;
        try {
          await spec.translate(em, step.msg, translateCtx);   // backpressure: the brain blocks on the socket if we're slow
        } catch (err) {
          if (err instanceof Error && err.message === "fenced") { fenced = true; break; }
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message === "fenced") fenced = true;
      else throw err;
    } finally {
      await host.close().catch(() => {});
    }

    // ── Fence/cancel ladder (§3.7b) ────────────────────────────────────────────
    if (fenced) {
      ac.abort();                                  // cooperative: the brain observes req close → aborts its query
      const ended = await waitBrainIdle(FENCE_GRACE_MS);
      if (!ended) killBrain();                      // stuck turn must not poison the resident brain
      await em.drain().catch(() => {});
      console.error("[adapter] fenced — yielding");
      process.exit(0);
    }

    // ── Disposition ────────────────────────────────────────────────────────────
    await em.drain();
    // Diagnostic: a turn the brain ended with ZERO steps is an anomaly (the resident brain
    // produced nothing — e.g. an MCP/tool-loading hang). Surface the brain.log tail + the
    // terminal so a live canary session is debuggable. Internal level + retriable:false so
    // it's visible without forcing a retry; disposition continues as quiescent below.
    if (brainSteps === 0 && terminalReason !== "error") {
      await em.emit({ type: "error.runtime", level: "internal", body: { code: "empty_turn", retriable: false, terminal: terminalReason, mcp_endpoint: host.url, brain_log: tailBrainLog() } }).catch(() => {});
      await em.drain().catch(() => {});
      console.error(`[adapter] EMPTY TURN — brain streamed 0 steps (terminal=${terminalReason}); brain.log tail:\n${tailBrainLog()}`);
    }
    // Out of model credits is TERMINAL: retrying just re-hits the 402, and the answer
    // safety-net below would surface the raw "API Error: 402 …" as a user message — so an
    // exhausted org spams its thread with the same error on every in-place retry + re-run.
    // Detect it, surface ONE clean notice, and stop cleanly (exit 0 → no in-place restart,
    // input consumed → no re-run on the same message).
    const isCreditError = terminalReason === "error"
      && /\b402\b|requires more credits|insufficient.*credit|out of credit/i.test(terminalError?.message ?? "");
    if (isCreditError) {
      if (!ctx.sawUserFacing) {
        await em.emit({ type: "agent.message", level: "user",
          body: { text: "⚠️ I've run out of model credits, so I can't continue. Top up your credits and message me again." } });
      }
      await em.emit({ type: "error.runtime", level: "internal",
        body: { code: "insufficient_credits", retriable: false, message: terminalError?.message ?? "402 insufficient credits" } }).catch(() => {});
      await em.drain().catch(() => {});
      console.error("[adapter] out of model credits — stopping cleanly (terminal, no retry)");
      process.exit(0);
    }

    // Safety net: surface the agent's final plain-text answer as a user-level message so
    // a turn that never said/asked still has an answer event (turn.ts resolves the LAST
    // user-level agent.message as the result). ONLY on a clean disposition — on an
    // error/crash lastAssistantText is usually the error text itself, and surfacing it
    // (re-emitted on every retry) is exactly the thread spam.
    if (!ctx.sawUserFacing && lastAssistantText.trim() && (terminalReason === "quiescent" || terminalReason === "awaiting_input")) {
      await em.emit({ type: "agent.message", level: "user", body: { text: lastAssistantText.trim() } });
      await em.drain();
    }

    if (terminalReason === "quiescent" || terminalReason === "awaiting_input") {
      process.exit(0);                              // needs_input is read from the ask event, not the code
    }
    // error reason, or the stream ended with no done line (brain crash) → non-zero so the
    // host restarts-in-place from the journal (Tier 1).
    const code = terminalError?.type ?? (terminalReason ? "turn_failed" : "brain_crashed");
    await em.emit({ type: "error.runtime", level: "internal", body: { code, message: terminalError?.message ?? "brain stream ended without a terminal", retriable: true } }).catch(() => {});
    await em.drain().catch(() => {});
    console.error(`[adapter] turn failed: ${code} — ${terminalError?.message ?? "no terminal"}`);
    process.exit(1);
  }

  // brain reports busy:false once its /turn handler has released — poll /healthz.
  async function waitBrainIdle(graceMs: number): Promise<boolean> {
    const until = nowPlus(graceMs);
    while (Date.now() < until) {
      try {
        const r = await fetch(`http://127.0.0.1:${brainPort}/healthz`, { signal: AbortSignal.timeout(1000) });
        const j = (await r.json()) as { busy?: boolean };
        if (j.busy === false) return true;
      } catch {
        return true;   // unreachable = the brain stopped; good enough for "not still emitting"
      }
      await sleep(200);
    }
    return false;
  }

  function tailBrainLog(maxChars = 1500): string {
    try { const s = readFileSync(logPath, "utf8"); return s.length > maxChars ? s.slice(-maxChars) : s; } catch { return "(no brain.log)"; }
  }

  main()
    .then(() => process.exit(0))
    .catch(async (err) => {
      if (err instanceof Error && err.message === "fenced") { console.error("[adapter] fenced — yielding"); process.exit(0); }
      // Best-effort error event, then non-zero (host restarts-in-place). Reuse the
      // live emitter's advanced key seq if main() got that far; else a fresh one
      // (main threw before spooling anything, so base+0 is unused).
      try {
        const em = emitter ?? new DurableEmitter(stateDir, turnId);
        await em.emit({ type: "error.runtime", level: "internal", body: { code: "adapter_failed", message: String(err?.message ?? err), retriable: true } });
        await em.drain();
      } catch { /* ignore */ }
      console.error("[adapter] fatal:", err);
      process.exit(1);
    });
}

function safeUnlink(p: string): void { try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ } }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function nowPlus(ms: number): number { return Date.now() + ms; }
