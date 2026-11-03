// Starts the built server over stdio, exactly as an MCP client would, with
// KIRO_BIN pointed at the fake CLI so no real Kiro session is created.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { fakeKiro, readMeta, repoRoot, tempDir, type MetaRecord } from "./helpers.js";

export const serverEntry = join(repoRoot, "dist/src/index.js");

export interface ToolOutcome<T = Record<string, unknown>> {
  isError: boolean;
  body: T;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  raw: CallToolResult;
}

export interface Connected {
  client: Client;
  work: string;
  dir: string;
  meta: () => MetaRecord[];
  stderr: () => string;
  call: <T = Record<string, unknown>>(name: string, args?: Record<string, unknown>, opts?: { timeout?: number; signal?: AbortSignal; onprogress?: (p: unknown) => void }) => Promise<ToolOutcome<T>>;
  ok: <T = Record<string, unknown>>(name: string, args?: Record<string, unknown>) => Promise<T>;
  fail: (name: string, args?: Record<string, unknown>) => Promise<{ code: string; message: string; details: Record<string, unknown> }>;
  close: () => Promise<void>;
  serverPid: number | null;
}

export interface ConnectOptions {
  env?: Record<string, string>;
  capabilities?: Record<string, unknown>;
  /** Run before connecting, with the work directory, to seed files. */
  setup?: (work: string, dir: string) => void;
}

export async function connect(opts: ConnectOptions = {}): Promise<Connected> {
  const dir = tempDir("kiro-mcp-smoke-");
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  opts.setup?.(work, dir);
  const metaPath = join(dir, "meta.jsonl");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("KIRO_") && !k.startsWith("FAKE_KIRO_")) env[k] = v;
  }
  Object.assign(
    env,
    {
      KIRO_BIN: fakeKiro,
      KIRO_MCP_ROOTS: work,
      KIRO_MCP_CWD: work,
      FAKE_KIRO_META: metaPath,
      FAKE_KIRO_STORE: join(dir, "store.json"),
      HOME: dir,
    },
    opts.env ?? {},
  );
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], env, stderr: "pipe", cwd: work });
  const client = new Client({ name: "smoke-test", version: "0.0.0" }, { capabilities: opts.capabilities ?? {} });
  let stderrText = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString("utf8");
  });
  await client.connect(transport);
  const call = async <T,>(name: string, args: Record<string, unknown> = {}, o: { timeout?: number; signal?: AbortSignal; onprogress?: (p: unknown) => void } = {}): Promise<ToolOutcome<T>> => {
    const raw = (await client.callTool({ name, arguments: args }, CallToolResultSchema, {
      timeout: o.timeout ?? 60_000,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.onprogress ? { onprogress: o.onprogress } : {}),
    })) as CallToolResult;
    const first = raw.content[0];
    const text = first !== undefined && first.type === "text" ? first.text : "{}";
    if (raw.isError === true) {
      let error: ToolOutcome["error"];
      try {
        error = (JSON.parse(text) as { error: NonNullable<ToolOutcome["error"]> }).error;
      } catch {
        error = { code: "UNPARSED", message: text, details: {} };
      }
      return { isError: true, body: {} as T, error, raw };
    }
    return { isError: false, body: (raw.structuredContent ?? JSON.parse(text)) as T, error: null, raw };
  };
  return {
    client,
    work,
    dir,
    meta: () => readMeta(metaPath),
    stderr: () => stderrText,
    call,
    ok: async <T,>(name: string, args: Record<string, unknown> = {}) => {
      const r = await call<T>(name, args);
      if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.error)}`);
      return r.body;
    },
    fail: async (name: string, args: Record<string, unknown> = {}) => {
      const r = await call(name, args);
      if (!r.isError || r.error === null) throw new Error(`${name} unexpectedly succeeded: ${JSON.stringify(r.body)}`);
      return r.error;
    },
    close: () => client.close(),
    serverPid: transport.pid,
  };
}

/** Requests the fake received, by method. */
export function requests(c: Connected, method: string): MetaRecord[] {
  return c.meta().filter((m) => m.kind === "request" && m.method === method);
}
