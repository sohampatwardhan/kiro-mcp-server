import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** true: saved trust; false: no saved trust; null: the file could not be read or understood. */
export type TrustState = true | false | null;

/** Kiro's per-workspace store: the first 16 hex of sha256(real path), confirmed on kiro-cli 2.37.1 (design Decision 9). */
export function workspaceRootsFile(root: string, home: string = homedir()): string {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(home, ".kiro", "workspace-roots", key, "permissions.yaml");
}

/**
 * Read-only check of the `workspaceTrusted` flag Kiro saves when the operator
 * picks "Trust, continue" in `kiro-cli --v3` (Requirement 2.6). The home
 * directory always reports false: Kiro never saves trust for it.
 */
export async function workspaceTrust(root: string, home: string = homedir()): Promise<TrustState> {
  let realHome = home;
  try {
    realHome = realpathSync(home);
  } catch {
    // keep the given path
  }
  if (root === realHome) return false;
  let text: string;
  try {
    text = await readFile(workspaceRootsFile(root, home), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
  }
  const match = /^\s*workspaceTrusted\s*:\s*(\S+)\s*$/m.exec(text);
  if (match === null) return /^\s*[A-Za-z_]+\s*:/m.test(text) || text.trim() === "" ? false : null;
  return match[1] === "true";
}

export function trustInstruction(root: string): string {
  return `Kiro has not saved workspace trust for ${root}: run \`kiro-cli --v3\` once in that folder and choose "Trust, continue". Until then Kiro does not load its agents, steering, MCP servers, or skills, and asks before every shell and MCP call.`;
}
