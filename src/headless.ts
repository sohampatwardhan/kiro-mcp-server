import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { headlessArgv, type HeadlessOptions } from "./argv.js";
import { KILL_GRACE_MS, killGroup, track } from "./children.js";
import { LIMITS } from "./config.js";
import type { Job, JobStore } from "./jobs.js";
import { cleanTerminalText, tail } from "./parse.js";
import { cliNotFoundMessage } from "./prereq.js";

export interface HeadlessRun {
  bin: string;
  cwd: string;
  prompt: string;
  options: HeadlessOptions;
  timeoutMs: number;
  /** KIRO_HEADLESS_WORKFLOW_TIMEOUT_SECS for this child only (Requirement 22.6). */
  workflowTimeoutS?: number;
}

const MAX_STDERR_NOTICES = 20;

/**
 * Start `kiro-cli chat --v3 --no-interactive --output-format=stream-json` for
 * a job: the prompt goes on stdin, runStarted / sessionUpdate / runFinished
 * lines feed the job, and the exit code settles it. KIRO_API_KEY, when the
 * operator set it, is inherited from the server's environment (Requirement 22.7).
 */
export function runHeadlessJob(store: JobStore, job: Job, run: HeadlessRun): void {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  if (run.workflowTimeoutS !== undefined) env.KIRO_HEADLESS_WORKFLOW_TIMEOUT_SECS = String(run.workflowTimeoutS);
  else delete env.KIRO_HEADLESS_WORKFLOW_TIMEOUT_SECS;
  const child = spawn(run.bin, headlessArgv(run.options), {
    cwd: run.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: true,
    windowsHide: true,
    env,
  });
  track(child);
  job.kill = () => {
    killGroup(child, "SIGTERM");
    const t = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
    t.unref();
  };
  child.stdin.on("error", () => undefined);
  child.stdin.end(run.prompt);

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => onLine(job, line));
  let stderrNotices = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    const text = cleanTerminalText(chunk.toString("utf8"));
    job.stderrTail = tail(job.stderrTail + text, LIMITS.outputTailChars);
    for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (stderrNotices++ >= MAX_STDERR_NOTICES) break;
      job.feed.append({ type: "notice", kind: "headless_stderr", message: line.slice(0, 500) });
    }
  });

  const timer = setTimeout(() => {
    job.error = { code: "TIMEOUT", message: `the headless run exceeded ${run.timeoutMs} ms and was stopped` };
    job.kill?.();
  }, run.timeoutMs);
  timer.unref();

  child.once("error", (err: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    job.error =
      err.code === "ENOENT" || err.code === "EACCES"
        ? { code: "CLI_NOT_FOUND", message: cliNotFoundMessage(run.bin) }
        : { code: "CLI_EXIT", message: `failed to start kiro-cli: ${err.message}` };
    store.finish(job, "done");
  });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    job.exitCode = code;
    job.signal = signal;
    store.finish(job, "done");
  });
}

function onLine(job: Job, line: string): void {
  let message: { type?: unknown; data?: unknown };
  try {
    message = JSON.parse(line) as { type?: unknown; data?: unknown };
  } catch {
    return;
  }
  const data = (typeof message.data === "object" && message.data !== null ? message.data : {}) as Record<string, unknown>;
  switch (message.type) {
    case "runStarted":
      if (job.status === "starting") job.status = "running";
      return;
    case "sessionUpdate": {
      if (job.status === "starting") job.status = "running";
      if (typeof data.sessionId === "string") job.sessionId = data.sessionId;
      for (const { event, key } of job.normalizer.apply(data, { replay: false }).events) job.feed.append(event, key);
      return;
    }
    case "runFinished":
    case "runInterrupted":
      if (typeof data.sessionId === "string") job.sessionId = data.sessionId;
      job.runStatus = typeof data.status === "string" ? data.status : message.type === "runInterrupted" ? "interrupted" : null;
      job.stopReason = typeof data.stopReason === "string" ? data.stopReason : null;
      job.finalText = typeof data.finalText === "string" ? data.finalText : null;
      job.finalTextTruncated = data.finalTextTruncated === true;
      if (data.interruption !== undefined || job.runStatus === "interrupted") job.interruption = data.interruption ?? { status: job.runStatus };
      job.feed.append({ type: "turn", phase: "settled", ...(job.stopReason !== null ? { stopReason: job.stopReason } : {}), ...(job.runStatus !== null ? { status: job.runStatus } : {}) });
      return;
    default:
      job.feed.append({ type: "unknown", method: `headless:${String(message.type)}` });
  }
}
