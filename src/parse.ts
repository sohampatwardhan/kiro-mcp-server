/**
 * Parsers for the few kiro-cli subcommands whose output the server reads.
 * Everything that has a JSON form is read as JSON; text output is cleaned of
 * terminal control sequences first.
 */

/**
 * Terminal control sequences: OSC, DCS/PM/APC strings, CSI (7-bit and C1),
 * two-byte ESC sequences, then stray C0/C1 bytes other than tab, LF, and CR.
 * Order matters: a generic ESC-final sequence would otherwise swallow the `[`
 * of a CSI.
 */
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL_REGEX = new RegExp(
  [
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)",
    "\\u001b[P^_][\\s\\S]*?(?:\\u001b\\\\|\\u0007)",
    "\\u001b\\[[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]",
    "\\u009b[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]",
    "\\u001b[\\x20-\\x2f]*[\\x30-\\x7e]",
    "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u0080-\\u009f]",
  ].join("|"),
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(TERMINAL_CONTROL_REGEX, "");
}

/** Escape-free text with `\r` newlines folded into `\n`. */
export function cleanTerminalText(text: string): string {
  return stripAnsi(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** The last `max` characters of `text`. */
export function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

export interface Account {
  accountType: string | null;
  email: string | null;
  profile: string | null;
}

/** Only accountType, email, and the profile name are copied from `whoami --format json` (Requirement 2.2). */
export function parseWhoami(stdout: string): Account {
  const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const profileObj = parsed.profile as Record<string, unknown> | string | undefined;
  const profile = typeof profileObj === "string" ? str(profileObj) : str(profileObj?.name ?? profileObj?.profileName);
  return { accountType: str(parsed.accountType ?? parsed.account_type), email: str(parsed.email), profile };
}

/** `kiro-cli profile` prints the IdC profile; returns its name, or null. */
export function parseProfile(stdout: string): string | null {
  const text = cleanTerminalText(stdout).trim();
  if (text === "" || /no profile|not (?:an )?idc|not signed/i.test(text)) return null;
  const labeled = /profile(?:\s+name)?\s*[:=]\s*(\S.*)$/im.exec(text);
  const name = (labeled?.[1] ?? text.split("\n")[0] ?? "").trim();
  return name.length > 0 && name.length <= 200 ? name : null;
}

/** Parse JSON output, or throw OUTPUT_PARSE_FAILED-style errors to the caller. */
export function parseJson(stdout: string): unknown {
  return JSON.parse(stdout.trim());
}

export interface McpListEntry {
  name: string;
  target: string | null;
  scope: string | null;
  disabled: boolean;
}

/** `kiro-cli mcp list` prints text: scope headings, then `• name  command-or-url` lines. */
export function parseMcpList(stdout: string): McpListEntry[] {
  const servers: McpListEntry[] = [];
  let scope: string | null = null;
  for (const raw of cleanTerminalText(stdout).split("\n")) {
    const line = raw.trim();
    const heading = /^(?:📄\s*)?([A-Za-z][A-Za-z ]*?)\s*:\s*(\S.*)?$/u.exec(line);
    if (heading !== null && !/^[•*-]/.test(line)) {
      scope = (heading[1] ?? "").toLowerCase();
      continue;
    }
    const item = /^[•*-]\s+(\S+)(?:\s+(.*?))?\s*$/u.exec(line);
    if (item === null) continue;
    let target = item[2] ?? null;
    const disabled = target !== null && /\(disabled\)\s*$/i.test(target);
    if (target !== null) target = target.replace(/\s*\(disabled\)\s*$/i, "").trim() || null;
    servers.push({ name: item[1] ?? "", target, scope, disabled });
  }
  return servers;
}

/** `Key: value` lines from text output such as `kiro-cli mcp status`. */
export function parseKeyValues(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of cleanTerminalText(stdout).split("\n")) {
    const m = /^\s*([A-Za-z][A-Za-z /_-]{0,40}?)\s*:\s*(.+?)\s*$/.exec(line);
    if (m !== null) out[(m[1] ?? "").toLowerCase().replace(/[ /-]+/g, "_")] = m[2] ?? "";
  }
  return out;
}

/** `kiro-cli settings list --format json`: an object of key to value, or an array of `{ key, value }`. */
export function parseSettings(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (Array.isArray(parsed)) {
    const out: Record<string, unknown> = {};
    for (const entry of parsed) {
      const e = (entry ?? {}) as Record<string, unknown>;
      if (typeof e.key === "string") out[e.key] = e.value;
    }
    return out;
  }
  if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  throw new Error("settings output is not an object");
}
