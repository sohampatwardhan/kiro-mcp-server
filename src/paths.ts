import { realpathSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { ToolError } from "./errors.js";

export class RootsError extends Error {
  override name = "RootsError";
}

/**
 * Parse KIRO_MCP_ROOTS: comma-separated absolute directories, stored as real
 * paths. Unset or blank means the single root `fallback` (KIRO_MCP_CWD or the
 * process cwd). `/`, missing paths, and non-directories are refused.
 */
export function parseRoots(raw: string | undefined, fallback: string): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const list = entries.length === 0 ? [resolve(fallback)] : entries;
  const roots: string[] = [];
  for (const entry of list) {
    if (!isAbsolute(entry)) throw new RootsError(`${JSON.stringify(entry)} is not an absolute path`);
    let real: string;
    try {
      real = realpathSync(entry);
    } catch {
      throw new RootsError(`${JSON.stringify(entry)} does not exist`);
    }
    if (!statSync(real).isDirectory()) throw new RootsError(`${JSON.stringify(entry)} is not a directory`);
    if (real === sep || dirname(real) === real) throw new RootsError(`${JSON.stringify(entry)} resolves to the filesystem root`);
    if (!roots.includes(real)) roots.push(real);
  }
  return roots;
}

/** True when `path` is `root` or below it. Both must be normalized absolute paths. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The directories Kiro may run in (Requirement 4). */
export class Roots {
  constructor(readonly list: string[]) {}

  /** The first root: the ACP host cwd and the default for relative paths. */
  get primary(): string {
    const first = this.list[0];
    if (first === undefined) throw new Error("no roots configured");
    return first;
  }

  contains(realPath: string): boolean {
    return this.list.some((root) => isInside(root, realPath));
  }

  /**
   * Resolve an existing path with realpath and accept it only inside a root.
   * Relative paths resolve against `base` (default: the primary root).
   */
  async resolveInside(path: string, base: string = this.primary): Promise<string> {
    const absolute = resolve(base, path);
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      throw outside(path, "does not exist");
    }
    if (!this.contains(real)) throw outside(path);
    return real;
  }

  /** Resolve a path that may not exist yet: its parent directory must exist inside a root. */
  async resolveForWrite(path: string, base: string = this.primary): Promise<string> {
    const absolute = resolve(base, path);
    try {
      return await this.resolveInside(absolute);
    } catch (err) {
      if (!(err instanceof ToolError) || err.details.reason !== "does not exist") throw err;
    }
    const parent = await this.resolveInside(dirname(absolute));
    return resolve(parent, basename(absolute));
  }
}

function outside(path: string, reason = "outside every root"): ToolError {
  return new ToolError("PATH_OUTSIDE_ROOTS", `${JSON.stringify(path)} is not inside KIRO_MCP_ROOTS (${reason})`, {
    path,
    reason,
  });
}
