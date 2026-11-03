import { spawn } from "node:child_process";

import { KILL_GRACE_MS, killGroup, track } from "./children.js";
import { LIMITS } from "./config.js";
import { ToolError } from "./errors.js";
import { cleanTerminalText, tail } from "./parse.js";
import { cliNotFoundMessage, isSignInError, signInMessage } from "./prereq.js";

export interface CliResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface CliOptions {
  timeoutMs: number;
  cwd: string;
  /** Written to stdin, which is then closed. Stdin is closed at once when unset. */
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run `bin` with an argv array (never a shell) in its own tracked process
 * group, with a hard timeout (SIGTERM, then SIGKILL after the grace period)
 * and a per-stream output cap. Resolves with the outcome for any process that
 * started; rejects with CLI_NOT_FOUND when the binary is missing.
 */
export function runCli(bin: string, argv: string[], opts: CliOptions): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const child = spawn(bin, argv, {
      shell: false,
      cwd: opts.cwd,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...(opts.env ?? process.env), NO_COLOR: "1" },
      windowsHide: true,
      detached: true,
    });
    track(child);
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(opts.stdin);
    }
    const stdout = collector();
    const stderr = collector();
    child.stdout?.on("data", stdout.push);
    child.stderr?.on("data", stderr.push);

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    }, opts.timeoutMs);

    child.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (err.code === "ENOENT" || err.code === "EACCES") {
        reject(new ToolError("CLI_NOT_FOUND", cliNotFoundMessage(bin)));
      } else {
        reject(new ToolError("CLI_EXIT", `failed to start ${bin}: ${err.message}`));
      }
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

/** `details.cli` for a tool error: exit code and cleaned, capped output tails. */
export function cliDetails(result: CliResult): { exitCode: number | null; stdoutTail: string; stderrTail: string } {
  return {
    exitCode: result.exitCode,
    stdoutTail: tail(cleanTerminalText(result.stdout), LIMITS.outputTailChars),
    stderrTail: tail(cleanTerminalText(result.stderr), LIMITS.outputTailChars),
  };
}

/**
 * Run a subcommand and map failures to tool errors: TIMEOUT, CLI_NOT_SIGNED_IN
 * when the output reads like a missing login, and CLI_EXIT for any other
 * nonzero exit. Returns the result for a zero exit.
 */
export async function runChecked(bin: string, argv: string[], opts: CliOptions): Promise<CliResult> {
  const result = await runCli(bin, argv, opts);
  if (result.timedOut) {
    throw new ToolError("TIMEOUT", `kiro-cli ${argv[0] ?? ""} timed out after ${opts.timeoutMs} ms`, {
      cli: cliDetails(result),
    });
  }
  if (result.exitCode !== 0) {
    const text = `${cleanTerminalText(result.stderr)}\n${cleanTerminalText(result.stdout)}`;
    if (isSignInError(text)) throw new ToolError("CLI_NOT_SIGNED_IN", signInMessage(), { cli: cliDetails(result) });
    throw new ToolError("CLI_EXIT", `kiro-cli ${argv.slice(0, 2).join(" ")} exited with ${result.exitCode ?? result.signal}`, {
      cli: cliDetails(result),
    });
  }
  return result;
}

function collector() {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push: (chunk: Buffer) => {
      if (size >= LIMITS.cliOutputBytes) return;
      const room = LIMITS.cliOutputBytes - size;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(piece);
      size += piece.length;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}
