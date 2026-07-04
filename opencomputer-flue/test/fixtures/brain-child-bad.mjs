// A brain whose agent.initialize() throws — for the eager-configure test (finding 7). Boots
// serveOC; bootConfigure's validate must catch the throw and hold /healthz off "ready".
import { defineAgent } from "@flue/runtime";
import { serveOC } from "../../dist/index.js";

serveOC(defineAgent(() => { throw new Error("initialize boom (bad bundle)"); }));
