import { isAbsolute, resolve } from "node:path";

export class RootsError extends Error {
  override name = "RootsError";
}

/**
 * Parse KIRO_MCP_ROOTS: comma-separated absolute directories. Unset or blank
 * means the single root `fallback` (KIRO_MCP_CWD or the process cwd).
 */
export function parseRoots(raw: string | undefined, fallback: string): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) return [resolve(fallback)];
  return entries.map((entry) => {
    if (!isAbsolute(entry)) throw new RootsError(`${JSON.stringify(entry)} is not an absolute path`);
    return resolve(entry);
  });
}
