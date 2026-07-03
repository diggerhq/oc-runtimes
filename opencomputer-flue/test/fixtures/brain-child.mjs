// A minimal crashable brain for the R4 boot-reconcile test: boots serveOC on
// OC_BRAIN_PORT over OC_RUNTIME_STATE_DIR and serves until killed.
import { defineAgent } from "@flue/runtime";
import { serveOC } from "../../dist/index.js";

serveOC(defineAgent(() => ({ model: "anthropic/claude-sonnet-5", tools: [], instructions: "t" })));
