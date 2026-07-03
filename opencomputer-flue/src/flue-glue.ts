// The engine embedding + the §11.9 state machine (R3/R4/R5). Built on the S0a-verified
// recipe (flue's generated node entry, mirrored): sqlite(path) stores → coordinator →
// createAdmission drives runs (contract 19 — flue generates submission ids; the package
// keeps its own durable turn-map). The embedding surface is @flue/runtime/internal —
// explicitly NOT their public API; the peer dep is exact-range-pinned for this reason
// (012 §6.5 carries the public-exports upstream ask).

import { join } from "node:path";
import { registerProvider } from "@flue/runtime";
import { sqlite } from "@flue/runtime/node";
import {
  Bash, InMemoryFs, bashFactoryToSessionEnv, createFlueContext,
  createNodeAgentCoordinator, createNodeDispatchQueue, createRuntimeActivityGate,
  configureFlueRuntime, resolveModel,
} from "@flue/runtime/internal";
import { PackageState, type OutcomeRecord } from "./state.js";
import { ocSandbox } from "./sandbox.js";
import { createOcTools, RESERVED_TOOL_NAMES } from "./tools.js";

/** A decorated FlueEvent as forwarded over NDJSON (eventIndex = the step `offset`). */
export interface ForwardedEvent {
  type?: string;
  eventIndex?: number;
  [k: string]: unknown;
}

export interface TurnRequest {
  turn_id: string;
  attempt: number;
  input: Array<{ role: string; content: string }>;
  events_from_offset?: number;
  config: {
    model?: string;
    system_prompt?: string;
    mcp_endpoint?: string;
    state_dir?: string;
    deadline_s?: number;
    endpoint_profile?: { mode?: string; auth_env?: string; base_url?: string };
  };
}

export type DoneReason = "quiescent" | "awaiting_input" | "error";

/** The R3 branch taken, stamped on the done line so the adapter can emit `runtime.*`
 *  lifecycle telemetry (012 §11.9 — flight recorder, not billing). */
export interface TurnDisposition {
  attach_mode: "fresh" | "reattach" | "drain_settled";
  /** set when the fresh path had to abort a different turn's unsettled run first */
  orphan_abort?: { aborted: number; waited_ms: number };
  /** R4 boot reconcile count — reported once, on the first turn after boot */
  stale_runs_settled?: number;
}

/** Orphan-abort timed out: the engine holds a run that will not settle. The brain must die
 *  (killBrain fallback) so the next attempt boots a fresh engine and R4 reconciles. */
export class OrphanWedgedError extends Error {
  constructor(count: number, waitedMs: number) {
    super(`orphan run(s) did not settle within ${waitedMs}ms of abort (${count} unsettled) — engine wedged`);
    this.name = "OrphanWedgedError";
  }
}

export interface AgentDefinitionLike {
  __flueAgentDefinition: true;
  initialize: (ctx: unknown) => unknown | Promise<unknown>;
}

interface SubmissionRow {
  submissionId: string;
  status: string;
  acceptedAt?: number;
  attemptId?: string;
  attempt?: { attemptId?: string };
}

interface Submissions {
  getSubmission(id: string): Promise<SubmissionRow | null>;
  hasUnsettledSubmissions(): Promise<boolean>;
  listRunningSubmissions(): Promise<SubmissionRow[]>;
  listRunnableSubmissions(): Promise<SubmissionRow[]>;
  listUnreadySubmissions(): Promise<SubmissionRow[]>;
  failSubmission(attempt: { submissionId: string; attemptId: string }, error: unknown): Promise<unknown>;
}

interface Coordinator {
  createAdmission(agent: string, instance: string): (
    payload: { message: string },
    onEvent?: (ev: ForwardedEvent) => void,
    waitForResult?: boolean,
  ) => Promise<{ submissionId: string; offset?: string; result?: unknown }>;
  abortInstance(agent: string, instance: string): Promise<boolean>;
  shutdown(timeoutMs?: number): Promise<void>;
}

interface EngineHandles {
  state: PackageState;
  coordinator: Coordinator;
  submissions: Submissions;
}

export const AGENT_NAME = "oc";
export const INSTANCE_ID = "session";

let engine: EngineHandles | null = null;
// Per-submission live event buffers — a same-process fast path for replay. The DURABLE
// backstop for every cross-process path is `state` (turn-map, awaiting flag, outcomes.json):
// a fresh brain over a recreated box has empty Maps and must not rely on them (finding 2).
const buffers = new Map<string, ForwardedEvent[]>();
const outcomes = new Map<string, OutcomeRecord>();
// R4 boot-reconcile count, surfaced on the FIRST done line after boot then cleared.
let staleRunsSettledAtBoot = 0;

/** The settle outcome for a submission: in-memory fast path (same process) ∪ the durable
 *  record (finding 2 — the only source in a fresh process; getSubmission can't tell
 *  completed from aborted from failed). */
function classifyOutcome(state: PackageState, submissionId: string): OutcomeRecord | null {
  return outcomes.get(submissionId) ?? state.getOutcome(submissionId);
}

/** The run's final assistant text, scanned back-to-front from its forwarded-event buffer.
 *  Persisted with the outcome so a fresh-process drain can still deliver the answer. */
function extractAnswerText(buf: ForwardedEvent[]): string | undefined {
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].type !== "message_end") continue;
    const message = (buf[i] as { message?: { role?: string; content?: unknown } }).message;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = (message.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim())
      .map((b) => b.text).join("");
    if (text.trim()) return text;
  }
  return undefined;
}

/** Every non-settled submission (running ∪ runnable ∪ unready). The R3/R4 paths reason over
 *  this set; flue exposes it only as three status-scoped lists, so we union them. */
async function listUnsettled(submissions: Submissions): Promise<SubmissionRow[]> {
  return (await Promise.all([
    submissions.listRunningSubmissions(),
    submissions.listRunnableSubmissions(),
    submissions.listUnreadySubmissions(),
  ])).flat();
}

/** R2 — /healthz busy is ENGINE truth: any non-settled submission. */
export async function engineBusy(): Promise<boolean> {
  if (!engine) return false;
  return engine.submissions.hasUnsettledSubmissions();
}

export async function engineShutdown(): Promise<void> {
  await engine?.coordinator.shutdown(3000).catch(() => {});
}

function profileError(msg: string): never {
  throw new Error(`flue profile violation: ${msg}`);
}

/** Once-per-process: stores → R4 stamp → wrapped agent → coordinator → runtime seed. */
export async function ensureEngine(userAgent: AgentDefinitionLike, turn: TurnRequest): Promise<EngineHandles> {
  if (engine) return engine;
  const stateDir = turn.config.state_dir ?? process.env.OC_RUNTIME_STATE_DIR ?? "/tmp/oc-flue-state";
  const state = new PackageState(stateDir);

  // Provider registration from endpoint_profile: managed → explicit base URL + sealed env
  // key; BYO → env key, transport rides the proxy bootstrap. Turn config is box-invariant.
  const profile = turn.config.endpoint_profile;
  const authEnv = profile?.auth_env ?? "ANTHROPIC_API_KEY";
  const apiKey = process.env[authEnv];
  if (apiKey || profile?.base_url) {
    registerProvider("anthropic", {
      ...(profile?.base_url ? { baseUrl: profile.base_url } : {}),
      ...(apiKey ? { apiKey } : {}),
    } as never);
  }

  const adapter = sqlite(join(stateDir, "flue.db"));
  if (adapter.migrate) await adapter.migrate();
  const stores = (await adapter.connect()) as {
    executionStore: { submissions: Submissions };
    runStore: unknown; eventStreamStore: unknown; conversationStreamStore: unknown; attachmentStore: unknown;
  };
  const submissions = stores.executionStore.submissions;

  // §11.9 R4 — reconcile to quiescence BEFORE any admit (the claim loop that starts with
  // the first admission reclaims expired leases and RESUMES continuable work). Fast path,
  // S0a-measured ~100ms vs the 30s lease wait: directly fail each stale running row.
  for (const row of await submissions.listRunningSubmissions()) {
    const attemptId = row.attempt?.attemptId ?? row.attemptId;
    if (!attemptId) continue;
    await submissions.failSubmission({ submissionId: row.submissionId, attemptId }, new Error("stale run settled at boot (R4)"));
    staleRunsSettledAtBoot++;
  }

  // R5 — durability is per-agent config in flue: apply by WRAPPING the user's definition.
  // Profile checks here are STRUCTURAL, scoped by profile_version (the policy-free rule).
  const deadlineS = turn.config.deadline_s ?? (Number(process.env.OC_TURN_DEADLINE_S ?? "") || 1800);
  const timeoutMs = Math.max(60_000, (deadlineS - 15) * 1000);
  let coordinatorRef: Coordinator | null = null;
  const ocTools = createOcTools({
    state,
    abortCurrentInstance: async () => (coordinatorRef ? coordinatorRef.abortInstance(AGENT_NAME, INSTANCE_ID) : false),
  });
  const wrapped: AgentDefinitionLike = {
    __flueAgentDefinition: true,
    initialize: async (ctx: unknown) => {
      const cfg = (await userAgent.initialize(ctx)) as Record<string, unknown>;
      if (cfg.sandbox != null) profileError("`sandbox` must be unset — OpenComputer supplies the session sandbox");
      const tools = Array.isArray(cfg.tools) ? (cfg.tools as Array<{ name?: string }>) : [];
      for (const t of tools) {
        if (t?.name && RESERVED_TOOL_NAMES.has(t.name)) profileError(`custom tool name '${t.name}' is reserved`);
      }
      return {
        ...cfg,
        // deploy-time triangle made divergence impossible; the host string wins (managed slugs)
        model: turn.config.model ?? cfg.model,
        durability: { maxAttempts: 1, timeoutMs },
        sandbox: ocSandbox(),
        tools: [...tools, ...ocTools],
      };
    },
  };

  const activityGate = createRuntimeActivityGate();
  const agents = [{ name: AGENT_NAME, definition: wrapped }];
  const mkDefaultEnv = async () =>
    bashFactoryToSessionEnv(() => new Bash({ fs: new InMemoryFs(), network: { dangerouslyAllowFullInternetAccess: true } }));
  const mkCtx = (args: { id: string; agentName: string; request: unknown; initialEventIndex: unknown; dispatchId: unknown }) =>
    createFlueContext({
      id: args.id, agentName: args.agentName, dispatchId: args.dispatchId, initialEventIndex: args.initialEventIndex,
      env: process.env, req: args.request,
      agentConfig: { resolveModel },
      createDefaultEnv: mkDefaultEnv, // unreachable in practice (sandbox injected above)
      submissionStore: submissions,
    } as never);
  const coordinator = createNodeAgentCoordinator({
    submissions, agents, createContext: mkCtx,
    conversationStreamStore: stores.conversationStreamStore, attachmentStore: stores.attachmentStore, activityGate,
  } as never) as unknown as Coordinator;
  coordinatorRef = coordinator;
  configureFlueRuntime({
    target: "node", devMode: false, temporaryLocalExposure: false, agents, workflows: [],
    createAgentAdmission: (n: string, i: string) => coordinator.createAdmission(n, i),
    abortAgentInstance: (n: string, i: string) => coordinator.abortInstance(n, i),
    dispatchQueue: createNodeDispatchQueue(coordinator as never), activityGate,
    admitWorkflow: () => { throw new Error("workflows are not supported on OpenComputer"); },
    channelHandlers: [], createWorkflowContext: () => { throw new Error("workflows are not supported on OpenComputer"); },
    runStore: stores.runStore, eventStreamStore: stores.eventStreamStore,
    conversationStreamStore: stores.conversationStreamStore, attachmentStore: stores.attachmentStore,
  } as never);

  engine = { state, coordinator, submissions };
  return engine;
}

export interface AttachResult {
  /** events from `events_from_offset`: replay + live tail; ends when the run settles */
  events: AsyncGenerator<ForwardedEvent>;
  /** resolves with the done reason once settled (and the tail is drained) */
  done: Promise<{ reason: DoneReason; error?: string }>;
  /** the R3 branch taken — serveOC stamps it on the done line */
  disposition: TurnDisposition;
}

/** The one-shot R4 report: attached to the first disposition after boot, then cleared. */
function takeStaleRunsSettled(): { stale_runs_settled?: number } {
  if (staleRunsSettledAtBoot === 0) return {};
  const n = staleRunsSettledAtBoot;
  staleRunsSettledAtBoot = 0;
  return { stale_runs_settled: n };
}

// Serializes the lookup/admit phase across handlers: a detached handler releases the HTTP
// stream slot immediately (R1 — the engine keeps running), so a re-attaching attempt can
// arrive while the previous handler's attachTurn is still mid-admit. Without this chain the
// two would race freshAdmit and double-admit the same turn.
let attachChain: Promise<unknown> = Promise.resolve();

/** §11.9 R3 — the attach protocol. `isLive` reports whether the calling subscriber is still
 *  connected — a detached handler must never consume the awaiting flag (its done line is
 *  never written; the flag belongs to the attempt that will actually deliver it). */
export function attachTurn(userAgent: AgentDefinitionLike, turn: TurnRequest, isLive: () => boolean = () => true): Promise<AttachResult> {
  const run = attachChain.then(() => attachTurnSerialized(userAgent, turn, isLive));
  attachChain = run.catch(() => {});
  return run;
}

async function attachTurnSerialized(userAgent: AgentDefinitionLike, turn: TurnRequest, isLive: () => boolean): Promise<AttachResult> {
  const eng = await ensureEngine(userAgent, turn);
  const key = `rt:${turn.turn_id}:${turn.attempt}`;
  const fromOffset = turn.events_from_offset ?? -1;
  const prior = eng.state.findTurn(turn.turn_id);

  if (prior) {
    const sub = await eng.submissions.getSubmission(prior.submissionId);
    if (sub && sub.status !== "settled") {
      // running → RE-ATTACH: no admit, model spend not duplicated
      return followSubmission(eng, prior.submissionId, fromOffset, turn, { attach_mode: "reattach", ...takeStaleRunsSettled() }, isLive);
    }
    if (sub && sub.status === "settled") {
      const drained: TurnDisposition = { attach_mode: "drain_settled", ...takeStaleRunsSettled() };
      if (eng.state.consumeAwaiting(turn.turn_id)) {
        return drainSettled(eng, prior.submissionId, fromOffset, "awaiting_input", undefined, drained);
      }
      const out = classifyOutcome(eng.state, prior.submissionId);
      if (out?.outcome === "completed") return drainSettled(eng, prior.submissionId, fromOffset, "quiescent", undefined, drained);
      if (out?.outcome === "failed" && out.error && !/abort/i.test(out.error)) {
        return drainSettled(eng, prior.submissionId, fromOffset, "error", out.error, drained);
      }
      // settled-aborted (no awaiting flag) OR no durable outcome (crashed in the settle→record
      // window) → fresh re-run: the honest claude/pi semantic, bounded duplicated-progress cost.
      // A durably-COMPLETED run never reaches here (classifyOutcome reads it cross-process),
      // so box recreation no longer double-runs a finished turn.
    }
  }

  // R3 orphan-abort — only on the fresh paths: abortInstance is SESSION-WIDE (queued+running),
  // so it must never fire while THIS turn's own run is live (the reattach/drain branches above).
  // Turns are host-serialized, so an orphan here is a fenced predecessor's run (012 §11.9).
  const orphan = await abortOrphans(eng, turn.turn_id);

  const submissionId = await freshAdmit(eng, key, turn);
  // A FRESH submission's `eventIndex` restarts at 0 (flue resets it per submission — no
  // initialEventIndex on the node admit path). The adapter's `events_from_offset` cursor
  // belonged to the DEAD attempt's submission; honoring it here would filter out the new
  // run's events 0..cursor — the head of the answer, silently (finding 3). A fresh re-run
  // re-emits from the start; the adapter re-appends (accepted duplicated-progress semantic).
  return followSubmission(eng, submissionId, -1, turn, {
    attach_mode: "fresh",
    ...(orphan ? { orphan_abort: orphan } : {}),
    ...takeStaleRunsSettled(),
  }, isLive);
}

const ORPHAN_ABORT_TIMEOUT_MS = Number(process.env.OC_ORPHAN_ABORT_TIMEOUT_MS ?? "") || 30_000;

/** Abort every unsettled run NOT belonging to `turnId` and wait for it to settle.
 *  `abortInstance` stamps abort_requested_at on queued AND running rows and arms the
 *  reconcile wake — a queued orphan settles-aborted at claim WITHOUT running (verified in
 *  @flue/runtime processSubmission). A run that ignores its abort signal keeps the engine
 *  wedged → OrphanWedgedError → serveOC dies (killBrain fallback) → next boot R4-reconciles. */
async function abortOrphans(eng: EngineHandles, turnId: string): Promise<{ aborted: number; waited_ms: number } | null> {
  // Unmapped unsettled rows count as orphans too: a crash between admit and turn-map record
  // leaves one, and admitting a SECOND concurrent run of the same input is strictly worse.
  const orphans = (await listUnsettled(eng.submissions)).filter((s) => eng.state.turnForSubmission(s.submissionId) !== turnId);
  if (orphans.length === 0) return null;
  const ids = new Set(orphans.map((s) => s.submissionId));

  const started = Date.now();
  await eng.coordinator.abortInstance(AGENT_NAME, INSTANCE_ID);
  for (;;) {
    const stillUnsettled = (await listUnsettled(eng.submissions)).filter((s) => ids.has(s.submissionId));
    if (stillUnsettled.length === 0) break;
    if (Date.now() - started > ORPHAN_ABORT_TIMEOUT_MS) {
      throw new OrphanWedgedError(stillUnsettled.length, Date.now() - started);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { aborted: ids.size, waited_ms: Date.now() - started };
}

/** Admit through createAdmission (contract 19) and correlate the generated submission id:
 *  the host serializes turns per session, so the single new non-settled submission after
 *  our admit is ours. The mapping is recorded as soon as the id is known. */
async function freshAdmit(eng: EngineHandles, key: string, turn: TurnRequest): Promise<string> {
  const message = turn.input.map((m) => m.content).join("\n\n");
  const before = new Set((await listUnsettled(eng.submissions)).map((s) => s.submissionId));

  const admission = eng.coordinator.createAdmission(AGENT_NAME, INSTANCE_ID);
  const pending: ForwardedEvent[] = [];
  // waitForResult=true is REQUIRED: false detaches the observer immediately (S0a).
  const completion = admission({ message }, (ev) => pending.push(ev), true);

  // correlate the id
  let submissionId: string | null = null;
  for (let i = 0; i < 200 && !submissionId; i++) {
    const all = await listUnsettled(eng.submissions);
    const fresh = all.filter((s) => !before.has(s.submissionId));
    if (fresh.length > 0) submissionId = fresh[fresh.length - 1].submissionId;
    else await new Promise((r) => setTimeout(r, 25));
  }
  if (!submissionId) {
    // extremely fast run: it settled before we saw it queued — take the id from completion
    const receipt = await completion.catch(() => null);
    if (!receipt) throw new Error("could not correlate the admitted flue submission");
    submissionId = receipt.submissionId;
  }
  eng.state.recordSubmission(key, submissionId);
  buffers.set(submissionId, pending);
  const sid = submissionId;
  const settle = (rec: OutcomeRecord): void => {
    outcomes.set(sid, rec);
    eng.state.recordOutcome(sid, rec); // durable — a fresh process reads THIS, not the Map
  };
  void completion.then(
    () => settle({ outcome: "completed", answerText: extractAnswerText(pending) }),
    (err: unknown) => {
      // flue serializes every abort (incl. our ask self-abort) to SubmissionAbortedError with a
      // fixed "aborted" message (verified in dist); a non-abort message is a real failure.
      const msg = err instanceof Error ? err.message : String(err);
      settle(/abort/i.test(msg) ? { outcome: "aborted" } : { outcome: "failed", error: msg });
    },
  );
  return submissionId;
}

/** Drain an already-settled run — no re-run, no model spend. Same process: replay the buffered
 *  tail past the cursor. Fresh process (buffer died with the old brain): the forwarded events
 *  aren't durably replayable (flue keeps no per-submission event stream — finding 2/Q4), so
 *  recover the final answer from the durable outcome as a synthetic message_end. */
function drainSettled(eng: EngineHandles, submissionId: string, fromOffset: number, reason: DoneReason, error: string | undefined, disposition: TurnDisposition): AttachResult {
  const buf = buffers.get(submissionId) ?? [];
  async function* gen(): AsyncGenerator<ForwardedEvent> {
    if (buf.length > 0) {
      for (const ev of buf) {
        if ((ev.eventIndex ?? Number.MAX_SAFE_INTEGER) > fromOffset) yield ev;
      }
      return;
    }
    if (reason === "quiescent") {
      const out = eng.state.getOutcome(submissionId);
      if (out?.answerText) {
        yield { type: "message_end", eventIndex: 0, message: { role: "assistant", content: [{ type: "text", text: out.answerText }] } };
      }
    }
  }
  return { events: gen(), done: Promise.resolve({ reason, ...(error ? { error } : {}) }), disposition };
}

/** Stream a (possibly re-attached) live run: buffered replay past the cursor + live tail. */
function followSubmission(eng: EngineHandles, submissionId: string, fromOffset: number, turn: TurnRequest, disposition: TurnDisposition, isLive: () => boolean): AttachResult {
  const buf = buffers.get(submissionId) ?? [];
  buffers.set(submissionId, buf);
  let settled = false;

  const done = (async (): Promise<{ reason: DoneReason; error?: string }> => {
    for (;;) {
      const sub = await eng.submissions.getSubmission(submissionId);
      if (sub?.status === "settled") break;
      await new Promise((r) => setTimeout(r, 150));
    }
    settled = true;
    // A detached subscriber's done line is never written — leave the awaiting flag for the
    // re-attaching attempt that WILL deliver it (the reported reason here is discarded).
    if (isLive() && eng.state.consumeAwaiting(turn.turn_id)) return { reason: "awaiting_input" };
    // getSubmission-settled races the settle callback that records the outcome; poll briefly so
    // a failed run reports `error`, not a defaulted `quiescent`.
    let out = classifyOutcome(eng.state, submissionId);
    for (let i = 0; i < 20 && !out; i++) {
      await new Promise((r) => setTimeout(r, 25));
      out = classifyOutcome(eng.state, submissionId);
    }
    if (out?.outcome === "failed" && out.error && !/abort/i.test(out.error)) return { reason: "error", error: out.error };
    return { reason: "quiescent" };
  })();

  async function* gen(): AsyncGenerator<ForwardedEvent> {
    let idx = 0;
    for (;;) {
      while (idx < buf.length) {
        const ev = buf[idx++];
        if ((ev.eventIndex ?? Number.MAX_SAFE_INTEGER) > fromOffset) yield ev;
      }
      if (settled && idx >= buf.length) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return { events: gen(), done, disposition };
}
