// The v3-codex ADAPTER — this runtime's RuntimeSpec on the shared adapter-core driver
// (design 011 §5.3). Codex is the leanest consumer: no skills, no sources note, and the
// pre-drift MCP tool subset (the platform/GitHub tools were never in this brain's
// steering — exposing them without prompt support would be a behavior change; they arrive
// deliberately, with steering, as their own canary). Input filtering/rendering is the
// shared standard INCLUDING github.* watch deliveries: the watches API has no per-runtime
// gate, so the old user.message-only filter silently ATE deliveries (review finding) —
// a rendered notification any model can act on beats a consumed-and-lost wakeup.

import { runAdapter, standardInputFilter, standardRenderInput } from "@oc/adapter-core";
import { createCodexTranslator } from "./translate.js";

runAdapter({
  name: "codex",
  defaultModel: "openai/gpt-5-codex",
  isInputForModel: standardInputFilter,
  renderInput: standardRenderInput,

  sourcesNote: () => "",
  skillsDir: () => null,   // skills unsupported on the codex family in v1 (009 §1)
  mcpTools: ["bash", "read", "write", "ls", "say", "ask"],

  // Native Codex SDK step → OC taxonomy. Tool events come from the MCP host, not here.
  translate: createCodexTranslator(),
});
