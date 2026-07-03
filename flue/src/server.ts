// The v3-flue LAUNCHER — what the adapter-core driver spawns as the brain (dist/server.js,
// beside dist/adapter.js; the driver's spawn path is unchanged, design 012 §11.6). It is a
// thin bootstrap: resolve the materialized artifact, validate its profile version, then
// dynamic-import its entry — which calls @opencomputer/flue's serveOC(), binding the brain
// port. This file NEVER links @flue/runtime; it only reads artifact.json and import()s the
// self-contained bundle, so it launches whichever conformant artifact was materialized.
//
// Boot semantics:
//   - SPAWNED (node dist/server.js): bootFlueBrain() runs; any failure → distinct message +
//     non-zero exit fast (the driver's start-deadline turns it into a turn error; in practice
//     deploy-time verification, 012 §11.7.7, makes a missing artifact unreachable in prod).
//   - IMPORTED (no auto-run): the module only defines exports. The fork-verify variant
//     (build-runtime-snapshot.ts, ARTIFACT_HOSTED, §11.7.5 / W3.5) imports this file and
//     calls bootFlueBrain() against an image with NO artifact, asserting it rejects with
//     ArtifactMissingError — proof the launcher runs and fails the RIGHT way, without a real
//     brain boot. The main-module guard below is what keeps import side-effect-free.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/** Thrown when the artifact (or its entry) is absent — the fork-verify sentinel (W3.5). */
export class ArtifactMissingError extends Error {
  readonly code = "artifact_missing";
  constructor(message: string) {
    super(message);
    this.name = "ArtifactMissingError";
  }
}

/** profile_versions this image can host. A newer package emitting an unsupported version is
 *  rejected at DEPLOY validation (012 §11.7.7); this is defense in depth at boot. */
const SUPPORTED_PROFILE_VERSIONS: ReadonlySet<number> = new Set([1]);

interface ArtifactManifest {
  entry?: string;
  profile_version?: number;
}

function stateDir(): string {
  return process.env.OC_RUNTIME_STATE_DIR ?? join(process.env.HOME ?? "/home/sandbox", ".oc/runtime-state");
}

/**
 * Resolve + import the materialized artifact's entry (which calls serveOC and binds the port).
 * Rejects with ArtifactMissingError if the artifact or its entry is absent, or Error on an
 * unsupported profile version. On success it never resolves in the meaningful sense — the
 * imported entry starts the resident HTTP server and keeps the process alive.
 */
export async function bootFlueBrain(): Promise<void> {
  const artifactDir = join(stateDir(), "artifact");
  const manifestPath = join(artifactDir, "artifact.json");
  if (!existsSync(manifestPath)) {
    throw new ArtifactMissingError(`flue artifact manifest not found at ${manifestPath} — the driver did not materialize an artifact for this session`);
  }

  let manifest: ArtifactManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ArtifactManifest;
  } catch (err) {
    throw new Error(`flue artifact.json is unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const profileVersion = manifest.profile_version;
  if (typeof profileVersion !== "number" || !SUPPORTED_PROFILE_VERSIONS.has(profileVersion)) {
    throw new Error(`flue artifact profile_version ${String(profileVersion)} is not supported by this runtime image (supported: ${[...SUPPORTED_PROFILE_VERSIONS].join(", ")})`);
  }

  const entryPath = join(artifactDir, manifest.entry ?? "oc.js");
  if (!existsSync(entryPath)) {
    throw new ArtifactMissingError(`flue artifact entry not found at ${entryPath}`);
  }

  // The entry is a self-contained ESM bundle; importing it runs serveOC() → binds the port.
  await import(pathToFileURL(entryPath).href);
}

// Main-module guard: run only when spawned directly, so `import()` stays side-effect-free
// for the fork-verify probe. (NodeNext ESM: no require.main; compare argv[1] to this file.)
const invokedDirectly = process.argv[1] != null && process.argv[1] === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  bootFlueBrain().catch((err: unknown) => {
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[flue-launcher] ${name}: ${message}`);
    process.exit(1);
  });
}
