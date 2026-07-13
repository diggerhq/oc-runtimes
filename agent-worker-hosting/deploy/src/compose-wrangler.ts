// Flue-specific composition for the only runtime this deploy package supports today. Keep this
// flat until a second runtime creates a real shared interface; the hosting topology is neutral, but
// the implementation need not pretend to have multiple adapters. The raw generated wrangler.json
// is a build-tool resolution dump and is never an API or persistence contract.

export const FLUE_COMPATIBILITY_DATE = "2026-04-01" as const;
export const FLUE_COMPATIBILITY_FLAGS = ["nodejs_compat"] as const;

export interface SameScriptDurableObjectBinding {
  name: string;
  class_name: string;
}

/** The only Flue build metadata accepted across the CLI/control-plane boundary. */
export interface FlueWranglerDescriptor {
  main: string;
  compatibility_date: typeof FLUE_COMPATIBILITY_DATE;
  compatibility_flags: ["nodejs_compat"];
  no_bundle: true;
  durable_objects: { bindings: SameScriptDurableObjectBinding[] };
}

export interface MigrationEntry {
  tag: string;
  new_sqlite_classes?: string[];
  deleted_classes?: string[];
}

/** Server-owned config consumed by the generic WfP uploader. */
export interface TenantScriptConfig {
  main: string;
  compatibility_date: typeof FLUE_COMPATIBILITY_DATE;
  compatibility_flags: ["nodejs_compat"];
  durable_objects: { bindings: SameScriptDurableObjectBinding[] };
  migrations: MigrationEntry[];
  vars: Record<string, string>;
}

/** OC-owned values layered onto every Flue tenant script. */
export interface OcBindings {
  gatewayUrl: string;
  /** Already validated manifest vars supplied by the control plane, never by wrangler.json. */
  extraVars?: Record<string, string>;
}

export interface ComposeResult {
  config: TenantScriptConfig;
  ledger: MigrationEntry[];
  addedClasses: string[];
}

export class FlueWranglerDescriptorError extends Error {}
export class MigrationLedgerError extends Error {}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, i) => key === [...expected].sort()[i]);
}

export function isSafeModulePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\")) return false;
  if (!(value.endsWith(".js") || value.endsWith(".mjs"))) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Strict runtime parser. Unknown Wrangler capabilities fail closed rather than being ignored. */
export function parseFlueWranglerDescriptor(input: unknown): FlueWranglerDescriptor {
  const top = record(input);
  const topKeys = ["main", "compatibility_date", "compatibility_flags", "no_bundle", "durable_objects"];
  if (!top || !hasExactKeys(top, topKeys)) {
    throw new FlueWranglerDescriptorError(`flue_wrangler must contain exactly: ${topKeys.join(", ")}`);
  }
  if (typeof top.main !== "string" || !isSafeModulePath(top.main)) {
    throw new FlueWranglerDescriptorError("flue_wrangler.main must be a safe relative .js/.mjs module path");
  }
  if (top.compatibility_date !== FLUE_COMPATIBILITY_DATE) {
    throw new FlueWranglerDescriptorError(`flue_wrangler.compatibility_date must be ${FLUE_COMPATIBILITY_DATE}`);
  }
  if (!Array.isArray(top.compatibility_flags)
    || top.compatibility_flags.length !== 1
    || top.compatibility_flags[0] !== FLUE_COMPATIBILITY_FLAGS[0]) {
    throw new FlueWranglerDescriptorError("flue_wrangler.compatibility_flags must be exactly [\"nodejs_compat\"]");
  }
  if (top.no_bundle !== true) {
    throw new FlueWranglerDescriptorError("flue_wrangler.no_bundle must be true");
  }

  const durableObjects = record(top.durable_objects);
  if (!durableObjects || !hasExactKeys(durableObjects, ["bindings"]) || !Array.isArray(durableObjects.bindings)) {
    throw new FlueWranglerDescriptorError("flue_wrangler.durable_objects must contain only a bindings array");
  }

  const bindings: SameScriptDurableObjectBinding[] = [];
  const names = new Set<string>();
  const classes = new Set<string>();
  for (const raw of durableObjects.bindings) {
    const binding = record(raw);
    if (!binding || !hasExactKeys(binding, ["name", "class_name"])) {
      throw new FlueWranglerDescriptorError("each durable-object binding must contain only name and class_name");
    }
    if (typeof binding.name !== "string" || !IDENTIFIER.test(binding.name)) {
      throw new FlueWranglerDescriptorError("durable-object binding names must be non-empty JavaScript identifiers");
    }
    if (typeof binding.class_name !== "string" || !IDENTIFIER.test(binding.class_name)) {
      throw new FlueWranglerDescriptorError("durable-object class names must be non-empty JavaScript identifiers");
    }
    if (names.has(binding.name) || classes.has(binding.class_name)) {
      throw new FlueWranglerDescriptorError("durable-object binding names and class names must be unique");
    }
    names.add(binding.name);
    classes.add(binding.class_name);
    bindings.push({ name: binding.name, class_name: binding.class_name });
  }

  const registries = bindings.filter((binding) =>
    binding.name === "FLUE_REGISTRY" && binding.class_name === "FlueRegistry");
  if (registries.length !== 1) {
    throw new FlueWranglerDescriptorError("flue_wrangler must bind FLUE_REGISTRY to FlueRegistry exactly once");
  }

  return {
    main: top.main,
    compatibility_date: FLUE_COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat"],
    no_bundle: true,
    durable_objects: { bindings },
  };
}

/** Unique same-script class names in first-seen order (stable migration-ledger input). */
export function emittedClasses(descriptor: FlueWranglerDescriptor): string[] {
  return descriptor.durable_objects.bindings.map((binding) => binding.class_name);
}

/** Append-only migration ledger. Class removal is a blue/green boundary. */
export function advanceLedger(prior: MigrationEntry[], classes: string[]): { ledger: MigrationEntry[]; added: string[] } {
  const alreadyMigrated = new Set<string>();
  for (const migration of prior) {
    for (const className of migration.new_sqlite_classes ?? []) alreadyMigrated.add(className);
  }

  const removed = [...alreadyMigrated].filter((className) => !classes.includes(className));
  if (removed.length) {
    throw new MigrationLedgerError(
      `forward-only: previously migrated DO classes are absent: ${removed.join(", ")}; deploy a new agent identity`,
    );
  }
  const added = classes.filter((className) => !alreadyMigrated.has(className));
  if (!added.length) return { ledger: prior, added: [] };
  return {
    ledger: [...prior, { tag: `v${prior.length + 1}`, new_sqlite_classes: added }],
    added,
  };
}

export function composeWrangler(
  descriptor: FlueWranglerDescriptor,
  oc: OcBindings,
  prior: MigrationEntry[] = [],
): ComposeResult {
  const parsed = parseFlueWranglerDescriptor(descriptor);
  const { ledger, added } = advanceLedger(prior, emittedClasses(parsed));
  return {
    config: {
      main: parsed.main,
      compatibility_date: FLUE_COMPATIBILITY_DATE,
      compatibility_flags: ["nodejs_compat"],
      durable_objects: { bindings: parsed.durable_objects.bindings },
      migrations: ledger,
      vars: { ...(oc.extraVars ?? {}), OC_GATEWAY: oc.gatewayUrl },
    },
    ledger,
    addedClasses: added,
  };
}
