// Tests for the contract-#4 wrangler composer + forward-only migration ledger.
// A realistic generated config uses Flue's exact class-name scheme (Explore-confirmed):
//   agent "support-triage" → class FlueSupportTriageAgent, binding FLUE_SUPPORT_TRIAGE_AGENT
//   + the always-present FlueRegistry / FLUE_REGISTRY.
// Run: npx vitest run

import { describe, it, expect } from "vitest";
import { composeWrangler, advanceLedger, emittedClasses, MigrationLedgerError, type GeneratedWrangler } from "../src/compose-wrangler.js";

const generated = (agents: string[]): GeneratedWrangler => ({
  name: "agt_123",
  main: ".flue-vite/_entry.ts",
  compatibility_date: "2026-04-01",
  compatibility_flags: ["nodejs_compat"],
  durable_objects: {
    bindings: [
      ...agents.map((a) => ({ name: `FLUE_${a.toUpperCase().replace(/-/g, "_")}_AGENT`, class_name: `Flue${a.split(/[-_]/).map((s) => s[0].toUpperCase() + s.slice(1)).join("")}Agent` })),
      { name: "FLUE_REGISTRY", class_name: "FlueRegistry" },
    ],
  },
  // NOTE: no `migrations` — Flue never emits it (Spike B).
});

const oc = { gatewayUrl: "https://gw.oc.dev", ingestUrl: "https://ingest.oc.dev/e" };

describe("emittedClasses", () => {
  it("reads unique DO class names from the generated bindings incl. FlueRegistry", () => {
    expect(emittedClasses(generated(["support-triage"]))).toEqual(["FlueSupportTriageAgent", "FlueRegistry"]);
  });
});

describe("composeWrangler (first deploy)", () => {
  const { config, ledger, addedClasses } = composeWrangler(generated(["support-triage"]), oc, []);
  it("synthesizes migrations from the class names (the empty-migrations gap Flue leaves)", () => {
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["FlueSupportTriageAgent", "FlueRegistry"] }]);
    expect(addedClasses).toEqual(["FlueSupportTriageAgent", "FlueRegistry"]);
    expect(ledger).toBe(config.migrations);
  });
  it("injects OC bindings (OC_GATEWAY, OC_INGEST) and keeps floors", () => {
    expect(config.vars?.OC_GATEWAY).toBe("https://gw.oc.dev");
    expect(config.vars?.OC_INGEST).toBe("https://ingest.oc.dev/e");
    expect(config.compatibility_flags).toContain("nodejs_compat");
    expect(config.compatibility_date! >= "2026-04-01").toBe(true);
  });
  it("preserves the generated DO bindings", () => {
    expect(config.durable_objects?.bindings?.map((b) => b.class_name)).toEqual(["FlueSupportTriageAgent", "FlueRegistry"]);
  });
});

describe("forced floors", () => {
  it("bumps a too-old compatibility_date to the floor and adds nodejs_compat", () => {
    const g = { ...generated(["a"]), compatibility_date: "2025-01-01", compatibility_flags: [] as string[] };
    const { config } = composeWrangler(g, oc);
    expect(config.compatibility_date).toBe("2026-04-01");
    expect(config.compatibility_flags).toContain("nodejs_compat");
  });
  it("keeps a stricter (newer) user compatibility_date", () => {
    const g = { ...generated(["a"]), compatibility_date: "2026-06-01" };
    expect(composeWrangler(g, oc).config.compatibility_date).toBe("2026-06-01");
  });
});

describe("advanceLedger (append-never-reorder, forward-only)", () => {
  it("first deploy → one tag with all classes", () => {
    expect(advanceLedger([], ["A", "FlueRegistry"]).ledger).toEqual([{ tag: "v1", new_sqlite_classes: ["A", "FlueRegistry"] }]);
  });
  it("adding an agent appends a NEW tag with only the new class (never re-lists prior ones)", () => {
    const prior = [{ tag: "v1", new_sqlite_classes: ["FlueOneAgent", "FlueRegistry"] }];
    const { ledger, added } = advanceLedger(prior, ["FlueOneAgent", "FlueTwoAgent", "FlueRegistry"]);
    expect(added).toEqual(["FlueTwoAgent"]);
    expect(ledger).toEqual([
      { tag: "v1", new_sqlite_classes: ["FlueOneAgent", "FlueRegistry"] },
      { tag: "v2", new_sqlite_classes: ["FlueTwoAgent"] },
    ]);
  });
  it("a behavior-only revision (same classes) is a ledger no-op", () => {
    const prior = [{ tag: "v1", new_sqlite_classes: ["A", "FlueRegistry"] }];
    const { ledger, added } = advanceLedger(prior, ["A", "FlueRegistry"]);
    expect(added).toEqual([]);
    expect(ledger).toBe(prior);
  });
  it("removing a migrated DO class THROWS (forward-only; ship blue/green)", () => {
    const prior = [{ tag: "v1", new_sqlite_classes: ["FlueOneAgent", "FlueTwoAgent", "FlueRegistry"] }];
    expect(() => advanceLedger(prior, ["FlueOneAgent", "FlueRegistry"])).toThrow(MigrationLedgerError);
  });
});
