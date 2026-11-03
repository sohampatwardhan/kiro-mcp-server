/**
 * Server configuration, read once from the environment at startup. Invalid
 * values are rejected up front, so tool calls never run with a half-valid
 * configuration. `src/index.ts` exits with code 2 on a ConfigError.
 */

import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { parseRoots, RootsError } from "./paths.js";

export type PermissionPolicy = "ask" | "deny" | "allow";
export type HeadlessTrust = "none" | "tools" | "all";

export interface Config {
  /** Path or name of the `kiro-cli` binary. */
  kiroBin: string;
  /** Default root when KIRO_MCP_ROOTS is unset. */
  cwd: string;
  /** Real paths of the directories Kiro may run in. The first is the host cwd. */
  roots: string[];
  permissions: PermissionPolicy;
  permissionTimeoutMs: number;
  allowShell: boolean;
  allowPersistentConsent: boolean;
  headlessTrust: HeadlessTrust;
  allowTrustWorkspace: boolean;
  allowConfigWrites: boolean;
  cliTimeoutMs: number;
  requestTimeoutMs: number;
  headlessTimeoutMs: number;
}

/** Fixed limits from the design's configuration section. */
export const LIMITS = {
  defaultWaitS: 20,
  maxWaitS: 55,
  maxLineBytes: 16 * 1024 * 1024,
  feedEvents: 2_000,
  feedBytes: 4 * 1024 * 1024,
  embedBytes: 256 * 1024,
  maxFiles: 20,
  imageBytes: 5 * 1024 * 1024,
  maxImages: 10,
  promptQueue: 5,
  cancelSettleMs: 30_000,
  jobTtlMs: 60 * 60_000,
  maxFinishedJobs: 100,
  outputTailChars: 8_000,
  snapshotFieldChars: 4_000,
  specReadBytes: 200 * 1024,
  maxRepos: 10,
  maxTextChars: 100_000,
  streamDefaultWaitS: 1,
  streamDefaultMaxChars: 20_000,
  streamMaxChars: 200_000,
  transcriptResourceBytes: 256 * 1024,
  resourceCoalesceMs: 250,
  maxClosedSessions: 50,
  cliOutputBytes: 4 * 1024 * 1024,
} as const;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const kiroBin = (env.KIRO_BIN ?? "").trim() || "kiro-cli";
  const cwd = resolveCwd(env.KIRO_MCP_CWD);
  let roots: string[];
  try {
    roots = parseRoots(env.KIRO_MCP_ROOTS, cwd);
  } catch (err) {
    if (err instanceof RootsError) throw new ConfigError(`KIRO_MCP_ROOTS: ${err.message}`);
    throw err;
  }
  return {
    kiroBin,
    cwd,
    roots,
    permissions: parseEnum("KIRO_MCP_PERMISSIONS", env.KIRO_MCP_PERMISSIONS, ["ask", "deny", "allow"], "ask"),
    permissionTimeoutMs: parseMilliseconds("KIRO_MCP_PERMISSION_TIMEOUT_MS", env.KIRO_MCP_PERMISSION_TIMEOUT_MS) ?? 600_000,
    allowShell: parseBooleanFlag("KIRO_MCP_ALLOW_SHELL", env.KIRO_MCP_ALLOW_SHELL),
    allowPersistentConsent: parseBooleanFlag("KIRO_MCP_ALLOW_PERSISTENT_CONSENT", env.KIRO_MCP_ALLOW_PERSISTENT_CONSENT),
    headlessTrust: parseEnum("KIRO_MCP_HEADLESS_TRUST", env.KIRO_MCP_HEADLESS_TRUST, ["none", "tools", "all"], "none"),
    allowTrustWorkspace: parseBooleanFlag("KIRO_MCP_ALLOW_TRUST_WORKSPACE", env.KIRO_MCP_ALLOW_TRUST_WORKSPACE),
    allowConfigWrites: parseBooleanFlag("KIRO_MCP_ALLOW_CONFIG_WRITES", env.KIRO_MCP_ALLOW_CONFIG_WRITES),
    cliTimeoutMs: parseMilliseconds("KIRO_MCP_CLI_TIMEOUT_MS", env.KIRO_MCP_CLI_TIMEOUT_MS) ?? 120_000,
    requestTimeoutMs: parseMilliseconds("KIRO_MCP_REQUEST_TIMEOUT_MS", env.KIRO_MCP_REQUEST_TIMEOUT_MS) ?? 120_000,
    headlessTimeoutMs: parseMilliseconds("KIRO_MCP_HEADLESS_TIMEOUT_MS", env.KIRO_MCP_HEADLESS_TIMEOUT_MS) ?? 3_600_000,
  };
}

/** Unset or blank uses `process.cwd()`. A set value must be an existing directory. */
function resolveCwd(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return process.cwd();
  if (!isAbsolute(trimmed)) throw new ConfigError(`KIRO_MCP_CWD must be an absolute path, got ${JSON.stringify(raw)}`);
  const cwd = resolve(trimmed);
  let info;
  try {
    info = statSync(cwd);
  } catch {
    throw new ConfigError(`KIRO_MCP_CWD does not exist: ${JSON.stringify(cwd)}`);
  }
  if (!info.isDirectory()) throw new ConfigError(`KIRO_MCP_CWD is not a directory: ${JSON.stringify(cwd)}`);
  return cwd;
}

function parseEnum<T extends string>(name: string, raw: string | undefined, allowed: readonly T[], fallback: T): T {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ConfigError(`${name} must be one of ${allowed.join(", ")}, got ${JSON.stringify(raw)}`);
}

/** Unset or blank is null. A set value must be a positive integer number of milliseconds. */
function parseMilliseconds(name: string, raw: string | undefined): number | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ConfigError(`${name} must be a positive integer (milliseconds), got ${JSON.stringify(raw)}`);
  }
  return Number(value);
}

/** Empty means false. `1` / `true` / `yes` (any case) mean true; `0` / `false` / `no` mean false. */
function parseBooleanFlag(name: string, raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "0" || value === "false" || value === "no") return false;
  if (value === "1" || value === "true" || value === "yes") return true;
  throw new ConfigError(`${name} must be 1, true, yes, 0, false, or no, got ${JSON.stringify(raw)}`);
}
