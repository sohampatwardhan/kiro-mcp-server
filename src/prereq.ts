import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/** Install commands from https://kiro.dev/docs/getting-started/installation.md */
export const CLI_INSTALL_COMMAND = "curl -fsSL https://cli.kiro.dev/install | bash";
export const CLI_INSTALL_COMMAND_BREW = "brew install kiro-cli";

export const SIGN_IN_INSTRUCTION =
  "Run `kiro-cli login` in a terminal on this machine (or `kiro-cli login --use-device-flow` on a machine without a browser). " +
  "This server never starts a login flow.";

export function cliNotFoundMessage(bin: string): string {
  return (
    `Kiro CLI not found: ${bin}. Install it with \`${CLI_INSTALL_COMMAND}\` (or \`${CLI_INSTALL_COMMAND_BREW}\` on macOS), ` +
    "then run `kiro-cli login`, or set KIRO_BIN to the path of an installed kiro-cli binary."
  );
}

export function signInMessage(detail?: string): string {
  return `Kiro CLI is not signed in${detail ? ` (${detail})` : ""}. ${SIGN_IN_INSTRUCTION}`;
}

const SIGN_IN_PATTERNS: RegExp[] = [
  /\bnot (?:logged|signed) in\b/i,
  /\bkiro-cli login\b/i,
  /\b(?:auth|authentication) (?:failed|required|error)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\b(?:access|refresh) token (?:has )?(?:expired|is missing|missing|invalid)\b/i,
  /\bmust (?:log|sign) in\b/i,
];

/** True when CLI or Kiro error text reads like a missing or expired login. */
export function isSignInError(text: string): boolean {
  return SIGN_IN_PATTERNS.some((re) => re.test(text));
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `bin` the way spawn would: a value with a path separator is a file
 * path (relative to `cwd`), anything else is looked up on PATH. Returns the
 * resolved path, or null when no executable file is found.
 */
export function findCli(bin: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | null {
  if (bin.includes("/") || bin.includes("\\")) {
    const path = isAbsolute(bin) ? bin : resolve(cwd, bin);
    return isExecutableFile(path) ? path : null;
  }
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** `kiro-cli 2.37.1` -> `2.37.1`. */
export function parseVersion(text: string): string | null {
  return /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(text)?.[1] ?? null;
}
