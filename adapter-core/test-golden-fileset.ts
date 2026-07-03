// Golden fileset-digest vector test (flue-slice.md contract 4, finding #14) — adapter-core is the
// box-side digest impl that gates EVERY materialize (materializeBundle refuses on mismatch), yet it
// had no golden pin. This asserts adapter-core's computeFilesetDigest + parseTar reproduce the shared
// vector, which INCLUDES a binary PNG so a utf8-decode-before-hash regression (#13) is caught here too.
//
// The vector is byte-identical to sessions-api src/v3/core/testdata/golden-fileset.json and opencomputer
// cmd/oc filesetdigest/testdata/golden-fileset.json. A drift means the three impls diverged.
//
// Run: npx -y tsx test-golden-fileset.ts   (self-contained — only node built-ins + ./src/skills.js)

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { computeFilesetDigest, parseTar, type UnpackedFile } from "./src/skills.js";

interface GoldenFile { path: string; mode: number; contentBase64: string }
interface Golden { digest: string; files: GoldenFile[]; canonicalTarGzBase64: string }

const golden = JSON.parse(
  readFileSync(new URL("./testdata/golden-fileset.json", import.meta.url), "utf8"),
) as Golden;

let failed = 0;
const ok = (n: string, c: boolean, e = "") => { console.log(`${c ? "ok  " : "FAIL"} ${n}${c ? "" : "  <<< " + e}`); if (!c) failed++; };

// Raw-byte entries from the vector (base64 → Buffer).
const files: UnpackedFile[] = golden.files.map((f) => ({ path: f.path, mode: f.mode, content: Buffer.from(f.contentBase64, "base64") }));

// 1. adapter-core's digest reproduces the shared vector.
const digest = computeFilesetDigest(files);
ok("computeFilesetDigest matches the golden vector", digest === golden.digest, `${digest} vs ${golden.digest}`);

// 2. Order-independence (contract 4 sorts bytewise by path).
ok("digest is input-order independent", computeFilesetDigest([...files].reverse()) === golden.digest);

// 3. parseTar round-trip: unpack the reference canonical tar.gz and re-derive the digest.
const parsed = parseTar(gunzipSync(Buffer.from(golden.canonicalTarGzBase64, "base64")));
ok("parseTar(gunzip(ref)) re-derives the golden digest", computeFilesetDigest(parsed) === golden.digest);
ok("parsed fileset count matches", parsed.length === golden.files.length, `${parsed.length} vs ${golden.files.length}`);

// 4. Regression guard: the vector carries a real binary file, and a utf8 round-trip corrupts the digest.
const png = files.find((f) => f.path.endsWith(".png"));
ok("vector includes a binary PNG entry", !!png);
const utf8Rehash = computeFilesetDigest(files.map((f) => ({ path: f.path, mode: f.mode, content: Buffer.from(f.content.toString("utf8"), "utf8") })));
ok("a utf8 round-trip corrupts the digest (proves raw-bytes matters)", utf8Rehash !== golden.digest);

console.log(`\n${failed === 0 ? "PASS" : "FAIL (" + failed + ")"}`);
process.exit(failed === 0 ? 0 : 1);
