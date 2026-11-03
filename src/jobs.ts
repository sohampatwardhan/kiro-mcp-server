import { randomBytes } from "node:crypto";

import { LIMITS } from "./config.js";
import { EventFeed, SessionNormalizer } from "./events.js";

/** Ids handed to callers: `job_` and 24 lowercase hex characters. */
export const JOB_ID_PATTERN = /^job_[0-9a-f]{24}$/;

/** `done` covers every exit, including 3 and 4; `error` carries a timeout or spawn failure. */
export type JobStatus = "starting" | "running" | "done" | "cancelled";

export type ExitMeaning = "success" | "mcp_startup_failed" | "agent_not_found" | "failure" | "killed";

export function exitMeaning(code: number | null): ExitMeaning {
  if (code === null) return "killed";
  if (code === 0) return "success";
  if (code === 3) return "mcp_startup_failed";
  if (code === 4) return "agent_not_found";
  return "failure";
}

export interface Job {
  readonly id: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly feed: EventFeed;
  readonly normalizer: SessionNormalizer;
  status: JobStatus;
  finishedAt: number | null;
  sessionId: string | null;
  runStatus: string | null;
  stopReason: string | null;
  finalText: string | null;
  finalTextTruncated: boolean;
  interruption: unknown;
  exitCode: number | null;
  signal: string | null;
  stderrTail: string;
  error: { code: string; message: string } | null;
  /** Stops the job's process group; set by the runner. */
  kill: (() => void) | null;
  readonly settled: Promise<void>;
  resolveSettled: () => void;
}

/** In-memory headless jobs with a TTL and a cap on finished jobs (Requirement 22.8). */
export class JobStore {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits: { ttlMs: number; maxFinished: number } = { ttlMs: LIMITS.jobTtlMs, maxFinished: LIMITS.maxFinishedJobs },
  ) {}

  create(cwd: string): Job {
    this.prune();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const job: Job = {
      id: `job_${randomBytes(12).toString("hex")}`,
      cwd,
      startedAt: this.now(),
      feed: new EventFeed(),
      normalizer: new SessionNormalizer(),
      status: "starting",
      finishedAt: null,
      sessionId: null,
      runStatus: null,
      stopReason: null,
      finalText: null,
      finalTextTruncated: false,
      interruption: null,
      exitCode: null,
      signal: null,
      stderrTail: "",
      error: null,
      kill: null,
      settled,
      resolveSettled,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | null {
    this.prune();
    return this.jobs.get(id) ?? null;
  }

  running(): Job[] {
    return [...this.jobs.values()].filter((j) => j.finishedAt === null);
  }

  /** Mark a job finished. A finished or cancelled job keeps its status. Returns false when it already finished. */
  finish(job: Job, status: "done" | "cancelled"): boolean {
    if (job.finishedAt !== null) return false;
    if (job.status !== "cancelled") job.status = status;
    job.finishedAt = this.now();
    job.feed.poke();
    job.resolveSettled();
    this.prune();
    return true;
  }

  async settleWithin(job: Job, ms: number): Promise<boolean> {
    if (job.finishedAt !== null) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([job.settled.then(() => true as const), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  private prune(): void {
    const now = this.now();
    const finished: Job[] = [];
    for (const job of this.jobs.values()) {
      if (job.finishedAt === null) continue;
      if (now - job.finishedAt > this.limits.ttlMs) this.jobs.delete(job.id);
      else finished.push(job);
    }
    finished.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const job of finished.slice(0, Math.max(0, finished.length - this.limits.maxFinished))) this.jobs.delete(job.id);
  }
}

/** A job as tool output. */
export function jobView(job: Job, now: number = Date.now()) {
  return {
    job_id: job.id,
    status: job.status,
    cwd: job.cwd,
    session_id: job.sessionId,
    run_status: job.runStatus,
    stop_reason: job.stopReason,
    final_text: job.finalText,
    final_text_truncated: job.finalTextTruncated,
    interruption: job.interruption,
    exit_code: job.exitCode,
    signal: job.signal,
    exit_meaning: job.finishedAt === null ? null : exitMeaning(job.exitCode),
    stderr_tail: job.stderrTail,
    error: job.error,
    started_at: new Date(job.startedAt).toISOString(),
    finished_at: job.finishedAt === null ? null : new Date(job.finishedAt).toISOString(),
    elapsed_ms: (job.finishedAt ?? now) - job.startedAt,
    cursor: job.feed.latestSeq,
  };
}
