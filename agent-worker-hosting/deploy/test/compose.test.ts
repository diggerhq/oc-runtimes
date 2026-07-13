import { describe, expect, it } from "vitest";
import {
  advanceLedger,
  composeWrangler,
  emittedClasses,
  FlueWranglerDescriptorError,
  MigrationLedgerError,
  parseFlueWranglerDescriptor,
  type FlueWranglerDescriptor,
} from "../src/compose-wrangler.js";

const descriptor = (agents: string[]): FlueWranglerDescriptor => ({
  main: "index.js",
  compatibility_date: "2026-04-01",
  compatibility_flags: ["nodejs_compat"],
  no_bundle: true,
  durable_objects: {
    bindings: [
      ...agents.map((agent) => ({
        name: `FLUE_${agent.toUpperCase()}_AGENT`,
        class_name: `Flue${agent[0]!.toUpperCase()}${agent.slice(1)}Agent`,
      })),
      { name: "FLUE_REGISTRY", class_name: "FlueRegistry" },
    ],
  },
});

describe("parseFlueWranglerDescriptor", () => {
  it("accepts and copies the exact module-only Flue descriptor", () => {
    const parsed = parseFlueWranglerDescriptor(descriptor(["support"]));
    expect(parsed).toEqual(descriptor(["support"]));
    expect(emittedClasses(parsed)).toEqual(["FlueSupportAgent", "FlueRegistry"]);
  });

  it.each([
    ["unknown top-level capability", { ...descriptor(["a"]), routes: ["example.com/*"] }],
    ["vars", { ...descriptor(["a"]), vars: { ATTACKER: "value" } }],
    ["migrations", { ...descriptor(["a"]), migrations: [{ tag: "owned-by-attacker" }] }],
    ["foreign-script DO binding", {
      ...descriptor(["a"]),
      durable_objects: { bindings: [
        { name: "FLUE_A_AGENT", class_name: "FlueAAgent", script_name: "victim" },
        { name: "FLUE_REGISTRY", class_name: "FlueRegistry" },
      ] },
    }],
    ["wrong compatibility date", { ...descriptor(["a"]), compatibility_date: "2026-07-01" }],
    ["extra compatibility flag", { ...descriptor(["a"]), compatibility_flags: ["nodejs_compat", "unsafe"] }],
    ["bundling enabled", { ...descriptor(["a"]), no_bundle: false }],
    ["unsafe main", { ...descriptor(["a"]), main: "../index.js" }],
  ])("rejects %s", (_name, input) => {
    expect(() => parseFlueWranglerDescriptor(input)).toThrow(FlueWranglerDescriptorError);
  });

  it("requires unique non-empty bindings and the exact registry binding", () => {
    const duplicate = descriptor(["a"]);
    duplicate.durable_objects.bindings.push({ name: "FLUE_A_AGENT", class_name: "OtherAgent" });
    expect(() => parseFlueWranglerDescriptor(duplicate)).toThrow(/unique/);

    const missingRegistry = descriptor(["a"]);
    missingRegistry.durable_objects.bindings.pop();
    expect(() => parseFlueWranglerDescriptor(missingRegistry)).toThrow(/FLUE_REGISTRY/);
  });
});

describe("composeWrangler", () => {
  it("synthesizes the migration ledger and only server-owned vars", () => {
    const result = composeWrangler(descriptor(["support"]), {
      gatewayUrl: "https://gateway.oc.test",
      extraVars: { USER_SETTING: "enabled" },
    });
    expect(result.config).toEqual({
      main: "index.js",
      compatibility_date: "2026-04-01",
      compatibility_flags: ["nodejs_compat"],
      durable_objects: descriptor(["support"]).durable_objects,
      migrations: [{ tag: "v1", new_sqlite_classes: ["FlueSupportAgent", "FlueRegistry"] }],
      vars: { USER_SETTING: "enabled", OC_GATEWAY: "https://gateway.oc.test" },
    });
  });
});

describe("advanceLedger", () => {
  it("appends only newly introduced classes", () => {
    const prior = [{ tag: "v1", new_sqlite_classes: ["FlueOneAgent", "FlueRegistry"] }];
    expect(advanceLedger(prior, ["FlueOneAgent", "FlueTwoAgent", "FlueRegistry"])).toEqual({
      ledger: [
        ...prior,
        { tag: "v2", new_sqlite_classes: ["FlueTwoAgent"] },
      ],
      added: ["FlueTwoAgent"],
    });
  });

  it("returns the original ledger for a behavior-only revision", () => {
    const prior = [{ tag: "v1", new_sqlite_classes: ["FlueOneAgent", "FlueRegistry"] }];
    expect(advanceLedger(prior, ["FlueOneAgent", "FlueRegistry"]).ledger).toBe(prior);
  });

  it("rejects class removal", () => {
    const prior = [{ tag: "v1", new_sqlite_classes: ["FlueOneAgent", "FlueRegistry"] }];
    expect(() => advanceLedger(prior, ["FlueRegistry"])).toThrow(MigrationLedgerError);
  });
});
