// Compose ONE OC wrangler config from a stock `flue build --target cloudflare` output (contract #4,
// design 013 §6). Flue emits `durable_objects.bindings` (the DO class names) but NEVER a `migrations`
// array (Spike B) — deploying that as-is yields a SQLite-backed DO with no `new_sqlite_classes`
// migration and a hard runtime failure. This composer replaces `migrations` with an OC-owned,
// append-never-reorder ledger synthesized from the emitted class names, adds OC bindings + floors,
// and returns the single config to upload. The deploy step must upload ONLY this — never ship the
// generated wrangler.json alongside (wrangler would pick the empty-migration one).
//
// The uploaded `migrations` reach the tenant script ONLY via the multipart WfP script-upload in
// wfp-deploy.ts (`deployTenantScript`). NEVER `wrangler deploy --dispatch-namespace` — it silently
// drops migrations (`migrations: null`) → the DO 500s "SQL is not enabled" (W6). See ../README.md.

export interface WranglerDOBinding { name: string; class_name: string; script_name?: string }
export interface MigrationEntry { tag: string; new_sqlite_classes?: string[]; deleted_classes?: string[] }
export interface GeneratedWrangler {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  durable_objects?: { bindings?: WranglerDOBinding[] };
  migrations?: MigrationEntry[];
  vars?: Record<string, string>;
  [k: string]: unknown;
}

/** OC-owned bindings layered onto every tenant script (§6, Integration seams). */
export interface OcBindings {
  gatewayUrl: string;                 // OC_GATEWAY var — W3's deployed gateway
  ingestUrl?: string;                 // OC_INGEST — operator-panel telemetry sink
  sessionTokenVar?: string;           // OC_SESSION_TOKEN (only the static seam option (b); option (a) needs none)
  sandboxBinding?: WranglerDOBinding; // if the app uses cloudflareSandbox (ocSandbox needs no binding)
  extraVars?: Record<string, string>;
}

const MIN_COMPAT_DATE = "2026-04-01"; // 013 §6 floor (SQLite DOs + nodejs_compat v2 + ALS)
const REQUIRED_FLAG = "nodejs_compat";

export class MigrationLedgerError extends Error {}

/** Unique class names from the generated DO bindings, in first-seen order (stable ledger input). */
export function emittedClasses(gen: GeneratedWrangler): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const b of gen.durable_objects?.bindings ?? []) {
    if (b.class_name && !seen.has(b.class_name)) { seen.add(b.class_name); out.push(b.class_name); }
  }
  return out;
}

/**
 * Advance the migration ledger forward-only (§6.1). New classes append a new tag; a class present in
 * the prior ledger but absent now is a DO class-identity removal — a hard boundary pre-1.0 that would
 * brick tenant DOs, so it THROWS (ship breaking changes blue/green, not by mutating the ledger).
 */
export function advanceLedger(prior: MigrationEntry[], classes: string[]): { ledger: MigrationEntry[]; added: string[] } {
  const alreadyMigrated = new Set<string>();
  for (const m of prior) for (const c of m.new_sqlite_classes ?? []) alreadyMigrated.add(c);

  const removed = [...alreadyMigrated].filter((c) => !classes.includes(c));
  if (removed.length) {
    throw new MigrationLedgerError(`forward-only: these DO classes were migrated before but are gone now — ${removed.join(", ")}. A class-identity change ships blue/green, never by editing the ledger.`);
  }
  const added = classes.filter((c) => !alreadyMigrated.has(c));
  if (!added.length) return { ledger: prior, added: [] }; // no-op revision (behavior-only change)
  const tag = `v${prior.length + 1}`;
  return { ledger: [...prior, { tag, new_sqlite_classes: added }], added };
}

/** Apply the Flue compatibility floors (never downgrade a stricter user value). */
function withFloors(gen: GeneratedWrangler): Pick<GeneratedWrangler, "compatibility_date" | "compatibility_flags"> {
  const date = !gen.compatibility_date || gen.compatibility_date < MIN_COMPAT_DATE ? MIN_COMPAT_DATE : gen.compatibility_date;
  const flags = new Set(gen.compatibility_flags ?? []);
  flags.add(REQUIRED_FLAG);
  return { compatibility_date: date, compatibility_flags: [...flags] };
}

export interface ComposeResult { config: GeneratedWrangler; ledger: MigrationEntry[]; addedClasses: string[] }

/**
 * Produce the single OC wrangler config to upload. `prior` = the tenant's existing migration ledger
 * (empty on first deploy). Throws MigrationLedgerError on a forward-only violation.
 */
export function composeWrangler(gen: GeneratedWrangler, oc: OcBindings, prior: MigrationEntry[] = []): ComposeResult {
  const classes = emittedClasses(gen);
  const { ledger, added } = advanceLedger(prior, classes);

  const bindings = [...(gen.durable_objects?.bindings ?? [])];
  if (oc.sandboxBinding && !bindings.some((b) => b.name === oc.sandboxBinding!.name)) bindings.push(oc.sandboxBinding);

  const vars: Record<string, string> = {
    ...(gen.vars ?? {}),
    OC_GATEWAY: oc.gatewayUrl,
    ...(oc.ingestUrl ? { OC_INGEST: oc.ingestUrl } : {}),
    ...(oc.sessionTokenVar ? { OC_SESSION_TOKEN: oc.sessionTokenVar } : {}),
    ...(oc.extraVars ?? {}),
  };

  const config: GeneratedWrangler = {
    ...gen,
    ...withFloors(gen),
    durable_objects: { ...(gen.durable_objects ?? {}), bindings },
    migrations: ledger,
    vars,
  };
  return { config, ledger, addedClasses: added };
}
