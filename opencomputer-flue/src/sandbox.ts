// ocSandbox — flue's SandboxApi implemented over the adapter's MCP host (contracts 9+17).
// Flue's BUILT-IN read/write/edit/bash (+grep/glob, which compose over these) execute on
// the session's WORKSPACE sandbox — a separate machine — via the MCP host's four sandbox
// tools. Custom defineTool code stays in-process. cwd = /workspace, CONSTANT (contract 17:
// one shared contract with the adapter; flue resolves skills at ${cwd}/.agents/skills, so
// the constant cwd is what makes the aggregated mount discoverable).
//
// stat/exists/mkdir/rm/readdir compose over `bash`/`ls` — the MCP host's frozen response
// shapes are {exitCode,stdout,stderr} / {content} / {ok} / {entries}; operational errors
// ride {error} at HTTP 200 and surface here as thrown Errors (flue turns tool throws into
// error results the model sees — S0a/verified reviewer note: the run survives).

import { createSandboxSessionEnv } from "@flue/runtime";
import { mcpCall } from "./mcp-client.js";

export const WORKSPACE_CWD = "/workspace";

function q(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

interface FileStatLike {
  isFile: boolean;
  isDirectory: boolean;
  size?: number;
}

// Structural SandboxApi (flue public type; declared locally so the compiled package keeps
// zero value-imports beyond the two public helpers — the peer range is checked at runtime).
export interface OcSandboxApi {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStatLike>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

async function bash(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const wrapped = cwd ? `cd ${q(cwd)} && ${command}` : command;
  const out = await mcpCall("bash", { command: wrapped });
  // The MCP host returns the exec result as text (stdout; failures are isError → thrown by
  // mcpCall). Exit code 0 on the happy path by construction.
  return { stdout: out, stderr: "", exitCode: 0 };
}

export const ocSandboxApi: OcSandboxApi = {
  async readFile(path) {
    return mcpCall("read", { path });
  },
  async readFileBuffer(path) {
    const b64 = await bash(`base64 < ${q(path)}`);
    return Buffer.from(b64.stdout.replace(/\s+/g, ""), "base64");
  },
  async writeFile(path, content) {
    const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
    await mcpCall("write", { path, content: text });
  },
  async stat(path) {
    const r = await bash(`if [ -d ${q(path)} ]; then echo DIR; elif [ -f ${q(path)} ]; then echo FILE $(wc -c < ${q(path)}); else echo NONE; fi`);
    const line = r.stdout.trim();
    if (line === "NONE" || !line) throw new Error(`ENOENT: ${path}`);
    if (line === "DIR") return { isFile: false, isDirectory: true };
    const size = Number(line.split(/\s+/)[1] ?? 0);
    return { isFile: true, isDirectory: false, size };
  },
  async readdir(path) {
    const out = await mcpCall("ls", { path });
    // ls tool returns entries as text lines (frozen shape {entries} rendered to text by the host)
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  },
  async exists(path) {
    const r = await bash(`[ -e ${q(path)} ] && echo YES || echo NO`);
    return r.stdout.trim().startsWith("YES");
  },
  async mkdir(path, options) {
    await bash(`mkdir ${options?.recursive ? "-p " : ""}${q(path)}`);
  },
  async rm(path, options) {
    await bash(`rm ${options?.recursive ? "-r " : ""}${options?.force ? "-f " : ""}${q(path)}`);
  },
  async exec(command, options) {
    return bash(command, options?.cwd ?? WORKSPACE_CWD);
  },
};

/** flue SandboxFactory: every session env is the workspace sandbox at the constant cwd. */
export function ocSandbox(): { createSessionEnv(options: { id: string }): Promise<unknown> } {
  return {
    async createSessionEnv() {
      return createSandboxSessionEnv(ocSandboxApi as never, WORKSPACE_CWD);
    },
  };
}
