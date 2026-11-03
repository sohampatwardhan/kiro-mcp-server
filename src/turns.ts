import { randomBytes } from "node:crypto";

import type { AcpHost } from "./acp/host.js";
import type { ContentBlock } from "./acp/types.js";
import { LIMITS } from "./config.js";
import { ToolError } from "./errors.js";
import type { CreditSummary, FailureReason, Keyed, StateChange, ToolCallStatus } from "./events.js";
import type { AttachedSession, SessionObserver, SessionRegistry } from "./sessions.js";

export const TURN_ID_PATTERN = /^turn_[0-9a-f]{16}$/;

export type TurnStatus = "queued" | "running" | "waiting_permission" | "completed" | "cancelled" | "failed";
const FINAL: ReadonlySet<TurnStatus> = new Set(["completed", "cancelled", "failed"]);

export interface ToolCallSummary {
  toolCallId: string;
  title: string;
  kind?: string;
  status: ToolCallStatus;
  failureReason?: FailureReason;
}

/** One session/prompt request and the updates it produced (the turn lifecycle in the requirements). */
export class Turn {
  readonly turnId = `turn_${randomBytes(8).toString("hex")}`;
  status: TurnStatus = "queued";
  stopReason: string | null = null;
  error: { code: string; message: string } | null = null;
  credits: CreditSummary[] = [];
  kiroElapsedMs: number | null = null;
  startedAt: number | null = null;
  settledAt: number | null = null;
  startCursor = 0;
  readonly segments = new Map<number, string>();
  readonly toolCalls = new Map<string, ToolCallSummary>();
  readonly settled: Promise<void>;
  private resolveSettled!: () => void;

  constructor(
    readonly sessionId: string,
    readonly blocks: ContentBlock[],
    readonly preview: string,
  ) {
    this.settled = new Promise((resolve) => {
      this.resolveSettled = resolve;
    });
  }

  get final(): boolean {
    return FINAL.has(this.status);
  }

  get finalText(): string {
    return [...this.segments.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text)
      .join("\n\n");
  }

  get elapsedMs(): number | null {
    if (this.kiroElapsedMs !== null) return this.kiroElapsedMs;
    if (this.startedAt === null) return null;
    return (this.settledAt ?? Date.now()) - this.startedAt;
  }

  settle(status: "completed" | "cancelled" | "failed", fields: { stopReason?: string | null; error?: { code: string; message: string } }): void {
    if (this.final) return;
    this.status = status;
    if (fields.stopReason !== undefined) this.stopReason = fields.stopReason;
    if (fields.error !== undefined) this.error = fields.error;
    this.settledAt = Date.now();
    this.resolveSettled();
  }
}

/** The turn as tool output. */
export function turnView(turn: Turn) {
  return {
    turn_id: turn.turnId,
    session_id: turn.sessionId,
    status: turn.status,
    stop_reason: turn.stopReason,
    final_text: turn.final || turn.segments.size > 0 ? turn.finalText : null,
    tool_calls: [...turn.toolCalls.values()].map((t) => ({
      tool_call_id: t.toolCallId,
      title: t.title,
      kind: t.kind ?? null,
      status: t.status,
      failure_reason: t.failureReason ?? null,
    })),
    credits: turn.credits,
    elapsed_ms: turn.elapsedMs,
    error: turn.error,
  };
}

export interface TurnHooks {
  /** True while a permission for this turn waits for an answer. */
  waitingOnPermission?: (turn: Turn) => boolean;
}

/**
 * Starts, queues, and settles turns. A turn settles only from its
 * session/prompt response (Requirement 10.6); a `turn_end` update never
 * settles it. Prompts are never resent after a host exit.
 */
export class TurnManager implements SessionObserver {
  private readonly active = new Map<string, Turn>();
  private readonly queues = new Map<string, Turn[]>();
  private readonly recent = new Map<string, Turn>();
  private readonly latestBySession = new Map<string, Turn>();
  hooks: TurnHooks = {};

  constructor(
    private readonly host: AcpHost,
    private readonly sessions: SessionRegistry,
  ) {
    sessions.observer = this;
    host.on("exited", () => {
      for (const turn of [...this.active.values()]) this.fail(turn, "HOST_EXITED", "the Kiro ACP host exited during this turn; the prompt was not resent");
      for (const [sessionId, queue] of this.queues) {
        for (const turn of queue) this.fail(turn, "HOST_EXITED", "the Kiro ACP host exited before this queued prompt was sent");
        this.queues.delete(sessionId);
      }
    });
  }

  turnIdFor(session: AttachedSession): string | undefined {
    return this.active.get(session.sessionId)?.turnId;
  }

  onEvents(session: AttachedSession, events: Keyed[], state: StateChange): void {
    const turn = this.active.get(session.sessionId);
    if (turn === undefined) return;
    for (const { event } of events) {
      if (event.turnId !== turn.turnId) continue;
      if (event.type === "message") turn.segments.set(event.segment, event.text);
      if (event.type === "tool_call") {
        turn.toolCalls.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          title: event.title,
          ...(event.kind !== undefined ? { kind: event.kind } : {}),
          status: event.status,
          ...(event.failureReason !== undefined ? { failureReason: event.failureReason } : {}),
        });
      }
    }
    if (state.credits !== undefined && !session.replaying) {
      turn.credits = state.credits;
      session.addCredits(state.credits);
    }
    if (state.elapsedMs !== undefined && !session.replaying) turn.kiroElapsedMs = state.elapsedMs;
  }

  get(turnId: string): Turn | undefined {
    return this.recent.get(turnId);
  }

  activeTurn(sessionId: string): Turn | undefined {
    return this.active.get(sessionId);
  }

  latest(sessionId: string): Turn | undefined {
    return this.active.get(sessionId) ?? this.latestBySession.get(sessionId);
  }

  queued(sessionId: string): Turn[] {
    return this.queues.get(sessionId) ?? [];
  }

  /** Current status, with waiting_permission while a permission is pending. */
  statusOf(turn: Turn): TurnStatus {
    if (turn.status === "running" && this.hooks.waitingOnPermission?.(turn) === true) return "waiting_permission";
    return turn.status;
  }

  /** Start a prompt now, or queue it behind the running turn (Requirement 9.1, 9.6, 9.7). */
  start(session: AttachedSession, blocks: ContentBlock[], whenBusy: "reject" | "queue"): Turn {
    const preview = blocks.find((b) => b.type === "text")?.text.slice(0, 120) ?? "";
    const turn = new Turn(session.sessionId, blocks, preview);
    this.remember(turn);
    if (this.active.has(session.sessionId)) {
      if (whenBusy === "reject") {
        throw new ToolError("TURN_ACTIVE", "this session already has a running turn; wait for it, cancel it, or pass when_busy: queue", {
          turn_id: this.active.get(session.sessionId)?.turnId,
        });
      }
      const queue = this.queues.get(session.sessionId) ?? [];
      if (queue.length >= LIMITS.promptQueue) throw new ToolError("QUEUE_FULL", `at most ${LIMITS.promptQueue} prompts can wait per session`);
      queue.push(turn);
      this.queues.set(session.sessionId, queue);
      return turn;
    }
    this.run(session, turn);
    return turn;
  }

  private run(session: AttachedSession, turn: Turn): void {
    this.active.set(session.sessionId, turn);
    this.latestBySession.set(session.sessionId, turn);
    turn.status = "running";
    turn.startedAt = Date.now();
    turn.startCursor = session.feed.latestSeq;
    session.turnCount++;
    session.pendingPreview = turn.preview;
    session.normalizer.breakSegment();
    void (async () => {
      try {
        await this.sessions.ensureAttached(session.sessionId);
        const result = (await this.host.call("session/prompt", { sessionId: session.sessionId, prompt: turn.blocks }, { timeoutMs: null })) as {
          stopReason?: unknown;
        } | null;
        const stopReason = typeof result?.stopReason === "string" ? result.stopReason : "end_turn";
        turn.settle(stopReason === "cancelled" ? "cancelled" : "completed", { stopReason });
      } catch (err) {
        const code = err instanceof ToolError ? err.code : "KIRO_ERROR";
        turn.settle("failed", { error: { code, message: err instanceof Error ? err.message : String(err) } });
      } finally {
        this.finish(session, turn);
      }
    })();
  }

  private fail(turn: Turn, code: string, message: string): void {
    turn.settle("failed", { error: { code, message } });
  }

  private finish(session: AttachedSession, turn: Turn): void {
    if (this.active.get(session.sessionId) === turn) this.active.delete(session.sessionId);
    session.normalizer.breakSegment();
    session.feed.append({
      type: "turn",
      phase: "settled",
      turnId: turn.turnId,
      ...(turn.stopReason !== null ? { stopReason: turn.stopReason } : {}),
      status: turn.status,
      credits: turn.credits,
      ...(turn.elapsedMs !== null ? { elapsedMs: turn.elapsedMs } : {}),
    });
    const queue = this.queues.get(session.sessionId);
    const next = queue?.shift();
    if (queue !== undefined && queue.length === 0) this.queues.delete(session.sessionId);
    if (next !== undefined && !session.closed) this.run(session, next);
  }

  /** Resolve true once the turn settles, false after `ms` or when `signal` aborts. The turn keeps running. */
  async waitSettled(turn: Turn, ms: number, signal?: AbortSignal): Promise<boolean> {
    if (turn.final) return true;
    if (ms <= 0 || signal?.aborted === true) return false;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const stop = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      onAbort = () => resolve(false);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([turn.settled.then(() => true as const), stop]);
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Send _session/steer to the running turn (Requirement 11.1, 11.2). */
  async steer(session: AttachedSession, text: string): Promise<Turn> {
    const turn = this.active.get(session.sessionId);
    if (turn === undefined) throw new ToolError("NO_ACTIVE_TURN", "this session has no running turn to steer; send a new prompt instead");
    await this.host.call("_session/steer", { sessionId: session.sessionId, message: text });
    return turn;
  }

  /**
   * Cancel the running turn: the caller has already answered its pending
   * permissions; this sends session/cancel and waits for the prompt response
   * up to `settleMs` (Requirement 11.3). Queued prompts are dropped.
   */
  async cancel(session: AttachedSession, settleMs: number = LIMITS.cancelSettleMs): Promise<Turn | undefined> {
    this.dropQueue(session.sessionId, "cancelled before it was sent");
    const turn = this.active.get(session.sessionId);
    if (turn === undefined) return undefined;
    this.host.notify("session/cancel", { sessionId: session.sessionId });
    const settled = await this.waitSettled(turn, settleMs);
    if (!settled) turn.settle("cancelled", { stopReason: "cancelled", error: { code: "TIMEOUT", message: `Kiro did not answer the cancelled prompt within ${settleMs} ms` } });
    return turn;
  }

  /** Drop queued prompts for a session (close or cancel). */
  dropQueue(sessionId: string, reason: string): void {
    for (const turn of this.queues.get(sessionId) ?? []) turn.settle("cancelled", { stopReason: "cancelled", error: { code: "NO_ACTIVE_TURN", message: reason } });
    this.queues.delete(sessionId);
  }

  private remember(turn: Turn): void {
    this.recent.set(turn.turnId, turn);
    if (this.recent.size > 500) {
      for (const [id, t] of this.recent) {
        if (this.recent.size <= 400) break;
        if (t.final) this.recent.delete(id);
      }
    }
  }
}
