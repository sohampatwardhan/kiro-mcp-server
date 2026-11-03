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
