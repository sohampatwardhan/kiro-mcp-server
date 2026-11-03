import { LIMITS } from "./config.js";
import { tail } from "./parse.js";

/**
 * Normalized events for one session or headless job, and the bounded feed
 * that holds them. Coalesced items (a message or thought segment, a tool
 * call) keep a single entry in the feed under a key: each change removes the
 * old entry and appends the merged one with a new seq, so a reader whose
 * cursor passed the old entry still receives the latest state, and reading
 * the same cursor twice returns the same events.
 */

export interface CreditSummary {
  unit?: string;
  usage?: number;
  usedTools?: string[];
}

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
export type FailureReason = "cancelled" | "denied" | "error";

type Base = { seq: number; at: string; replay?: true; turnId?: string };

export type KiroEvent = Base &
  (
    | { type: "message"; text: string; segment: number }
    | { type: "thought"; text: string; segment: number }
    | { type: "user_message"; text: string; segment: number }
    | {
        type: "tool_call";
        toolCallId: string;
        title: string;
        kind?: string;
        status: ToolCallStatus;
        failureReason?: FailureReason;
        rawInput?: unknown;
        rawOutputTail?: string;
      }
    | { type: "plan"; entries: { content: string; status: string; priority?: string }[] }
    | {
        type: "permission_requested" | "permission_resolved";
        permissionId: string;
        toolCallId: string;
        title?: string;
        optionId?: string;
        optionKind?: string;
        policy?: "caller" | "shell_disabled" | "deny" | "allow" | "timeout" | "cancel" | "elicitation";
      }
    | {
        type: "turn";
        phase: "start" | "completion" | "end" | "settled";
        stopReason?: string;
        status?: string;
        credits?: CreditSummary[];
        elapsedMs?: number;
      }
    | {
        type: "state";
        kind: "mode" | "config" | "commands" | "context_usage" | "title" | "focus" | "user_message_id";
        value?: unknown;
      }
    | { type: "steering"; kind: "queued" | "injected" | "cleared"; message?: string }
    | { type: "workflow"; workflowId?: string; status?: string; detail: unknown }
    | {
        type: "notice";
        kind: "rate_limit" | "model_fallback" | "host_exited" | "config_error" | "headless_stderr";
        message: string;
      }
    | { type: "unknown"; method: string; sessionUpdate?: string }
  );

export type EventType = KiroEvent["type"];

/** An event before the feed assigns `seq` and `at`. */
export type NewEvent = KiroEvent extends infer E ? (E extends KiroEvent ? Omit<E, "seq" | "at"> : never) : never;

export interface Keyed {
  event: NewEvent;
  /** Coalescing key: an existing entry with the same key is replaced. */
  key?: string;
}

/** Cached session state an update changed. */
export interface StateChange {
  modeId?: string;
  configOptions?: unknown[];
  commands?: unknown[];
  contextUsage?: Record<string, unknown>;
  title?: string;
  userMessageId?: string;
  credits?: CreditSummary[];
  elapsedMs?: number;
}

export interface NormalizeContext {
  replay: boolean;
  /** The server's id for the running turn, when there is one. */
  turnId?: string;
}

interface ToolRecord {
  toolCallId: string;
  title: string;
  kind?: string;
  status: ToolCallStatus;
  failureReason?: FailureReason;
  rawInput?: unknown;
  rawOutputTail?: string;
}

type ChunkKind = "message" | "thought" | "user_message";

const CHUNK_KINDS: Record<string, ChunkKind> = {
  agent_message_chunk: "message",
  agent_thought_chunk: "thought",
  user_message_chunk: "user_message",
};

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textOf(content: unknown): string {
  const c = obj(content);
  if (typeof c.text === "string") return c.text;
  if (Array.isArray(content)) return content.map(textOf).join("");
  return "";
}

function outputTail(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = typeof raw === "string" ? raw : (str(obj(raw).message) ?? JSON.stringify(raw));
  return tail(text, LIMITS.outputTailChars);
}

/**
 * Turns ACP `session/update` params (or the `update` inside them) into typed
 * events. One instance per session or job, because chunks coalesce and tool
 * calls merge across updates.
 */
export class SessionNormalizer {
  private segment = 0;
  private open: { kind: ChunkKind; text: string; key: string; replay: boolean } | null = null;
  private readonly tools = new Map<string, ToolRecord>();
  private readonly decisions = new Map<string, FailureReason>();

  toolCall(toolCallId: string): Readonly<ToolRecord> | undefined {
    return this.tools.get(toolCallId);
  }

  /** Record how a permission for `toolCallId` ended, for the tool call's failure reason. */
  noteDecision(toolCallId: string, reason: FailureReason): void {
    this.decisions.set(toolCallId, reason);
  }

  /** End the current text segment (a turn boundary). */
  breakSegment(): void {
    this.open = null;
  }

  apply(params: unknown, ctx: NormalizeContext): { events: Keyed[]; state: StateChange } {
    const p = obj(params);
    const update = "update" in p ? obj(p.update) : p;
    const kind = str(update.sessionUpdate);
    const kiro = obj(obj(update._meta).kiro);
    const replay = ctx.replay || kiro.replay === true;
    const extra = { ...(replay ? { replay: true as const } : {}), ...(ctx.turnId !== undefined && !replay ? { turnId: ctx.turnId } : {}) };
    const state: StateChange = {};
    const events: Keyed[] = [];
    const emit = (event: NewEvent, key?: string) => events.push({ event: { ...event, ...extra } as NewEvent, ...(key ? { key } : {}) });

    if (kind === undefined) {
      this.open = null;
      emit({ type: "unknown", method: "session/update" });
      return { events, state };
    }

    const chunkKind = CHUNK_KINDS[kind];
    if (chunkKind !== undefined) {
      const text = textOf(update.content);
      if (this.open === null || this.open.kind !== chunkKind || this.open.replay !== replay) {
        this.segment++;
        this.open = { kind: chunkKind, text: "", key: `${chunkKind}:${this.segment}`, replay };
      }
      this.open.text += text;
      emit({ type: chunkKind, text: this.open.text, segment: this.segment }, this.open.key);
      return { events, state };
    }
    this.open = null;

    switch (kind) {
      case "tool_call":
      case "tool_call_update": {
        const id = str(update.toolCallId);
        if (id === undefined) {
          emit({ type: "unknown", method: "session/update", sessionUpdate: kind });
          break;
        }
        const prev = this.tools.get(id);
        const status = (str(update.status) as ToolCallStatus | undefined) ?? prev?.status ?? "pending";
        const record: ToolRecord = {
          toolCallId: id,
          title: str(update.title) ?? prev?.title ?? "",
          ...(str(update.kind) ?? prev?.kind ? { kind: str(update.kind) ?? prev?.kind } : {}),
          status,
          ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : prev?.rawInput !== undefined ? { rawInput: prev.rawInput } : {}),
          ...(outputTail(update.rawOutput) ?? prev?.rawOutputTail ? { rawOutputTail: outputTail(update.rawOutput) ?? prev?.rawOutputTail } : {}),
        };
        if (status === "failed") record.failureReason = this.decisions.get(id) ?? "error";
        this.tools.set(id, record);
        emit({ type: "tool_call", ...record }, `tool:${id}`);
        break;
      }
      case "plan": {
        const entries = Array.isArray(update.entries)
          ? update.entries.map((e) => {
              const entry = obj(e);
              return {
                content: str(entry.content) ?? "",
                status: str(entry.status) ?? "pending",
                ...(str(entry.priority) ? { priority: str(entry.priority) } : {}),
              };
            })
          : [];
        emit({ type: "plan", entries }, "plan");
        break;
      }
      case "current_mode_update": {
        const modeId = str(update.currentModeId) ?? str(update.modeId);
        if (modeId !== undefined) state.modeId = modeId;
        emit({ type: "state", kind: "mode", value: modeId });
        break;
      }
      case "config_option_update": {
        const options = Array.isArray(update.configOptions) ? update.configOptions : [];
        state.configOptions = options;
        emit({ type: "state", kind: "config", value: options.map((o) => ({ id: obj(o).id, currentValue: obj(o).currentValue })) });
        break;
      }
      case "available_commands_update": {
        const commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
        state.commands = commands;
        emit({ type: "state", kind: "commands", value: { count: commands.length } });
        break;
      }
      case "session_info_update":
        this.info(update, kiro, state, emit);
        break;
      default:
        emit({ type: "unknown", method: "session/update", sessionUpdate: kind });
    }
    return { events, state };
  }

  /** Typed events for `_kiro/*` notifications that belong in the feed. Others return none. */
  notification(method: string, params: unknown, ctx: NormalizeContext): Keyed[] {
    const p = obj(params);
    const extra = { ...(ctx.replay ? { replay: true as const } : {}), ...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {}) };
    if (method === "_kiro/error/rate_limit") {
      return [{ event: { type: "notice", kind: "rate_limit", message: str(p.message) ?? "rate limited", ...extra } }];
    }
    if (method === "_kiro/customAgent/config_error" || method === "_kiro/customAgent/not_found") {
      const message = str(p.error) ?? str(p.message) ?? `${method.endsWith("not_found") ? "agent not found" : "agent config error"}${str(p.path) ? `: ${str(p.path)}` : ""}`;
      return [{ event: { type: "notice", kind: "config_error", message, ...extra } }];
    }
    if (method.startsWith("_kiro/workflow/")) {
      const workflowId = str(p.workflowId) ?? str(obj(p.workflow).workflowId) ?? str(obj(p.run).workflowId);
      const status = str(p.status) ?? str(obj(p.workflow).status) ?? str(obj(p.run).status);
      const detail = { method, ...p };
      delete (detail as Record<string, unknown>).sessionId;
      return [{ event: { type: "workflow", ...(workflowId ? { workflowId } : {}), ...(status ? { status } : {}), detail, ...extra } }];
    }
    return [];
  }

  private info(update: Record<string, unknown>, kiro: Record<string, unknown>, state: StateChange, emit: (e: NewEvent, key?: string) => void): void {
    const infoKind = str(kiro.kind);
    switch (infoKind) {
      case "context_usage": {
        const usage = obj(kiro.contextUsage);
        const value = {
          usagePercentage: num(kiro.usagePercentage) ?? num(usage.usagePercentage),
          summarizationThreshold: num(kiro.summarizationThreshold) ?? num(usage.summarizationThreshold),
          breakdown: kiro.breakdown ?? null,
        };
        state.contextUsage = value;
        emit({ type: "state", kind: "context_usage", value: { usagePercentage: value.usagePercentage, summarizationThreshold: value.summarizationThreshold } });
        return;
      }
      case "user_message_id_assigned": {
        const id = str(kiro.userMessageId);
        if (id !== undefined) state.userMessageId = id;
        emit({ type: "state", kind: "user_message_id", value: id });
        return;
      }
      case "focus_update": {
        const title = str(obj(kiro.focus).title) ?? str(kiro.title) ?? str(update.title);
        if (title !== undefined) state.title = title;
        emit({ type: "state", kind: "focus", value: title });
        return;
      }
      case "turn_start":
        emit({ type: "turn", phase: "start" });
        return;
      case "turn_completion": {
        const credits = Array.isArray(kiro.promptTurnSummaries)
          ? kiro.promptTurnSummaries.map((s) => {
              const summary = obj(s);
              return {
                ...(str(summary.unit) ? { unit: str(summary.unit) } : {}),
                ...(num(summary.usage) !== undefined ? { usage: num(summary.usage) } : {}),
                ...(Array.isArray(summary.usedTools) ? { usedTools: summary.usedTools.filter((t): t is string => typeof t === "string") } : {}),
              };
            })
          : [];
        state.credits = credits;
        const elapsed = num(kiro.elapsedTime);
        if (elapsed !== undefined) state.elapsedMs = elapsed;
        emit({ type: "turn", phase: "completion", credits, ...(elapsed !== undefined ? { elapsedMs: elapsed } : {}), ...(str(kiro.status) ? { status: str(kiro.status) } : {}) });
        return;
      }
      case "turn_end":
        emit({ type: "turn", phase: "end", ...(str(kiro.stopReason) ?? str(obj(kiro.turnEnd).stopReason) ? { stopReason: str(kiro.stopReason) ?? str(obj(kiro.turnEnd).stopReason) } : {}) });
        return;
      case "steering_queued":
      case "steering_injected":
      case "steering_cleared":
        emit({ type: "steering", kind: infoKind.slice("steering_".length) as "queued" | "injected" | "cleared", ...(str(kiro.message) ? { message: str(kiro.message) } : {}) });
        return;
      case "model_fallback":
        emit({ type: "notice", kind: "model_fallback", message: str(kiro.message) ?? `model fell back to ${str(kiro.toModel) ?? "another model"}` });
        return;
      default:
        if (str(update.title) !== undefined && infoKind === undefined) {
          state.title = str(update.title);
          emit({ type: "state", kind: "title", value: str(update.title) });
          return;
        }
        emit({ type: "unknown", method: "session/update", sessionUpdate: `session_info_update${infoKind ? `:${infoKind}` : ""}` });
    }
  }
}

export interface FeedPage {
  events: KiroEvent[];
  nextCursor: number;
  lowestCursor: number;
  /** True when events after the cursor were already dropped by the caps. */
  gap: boolean;
}

interface Entry {
  event: KiroEvent;
  key: string | undefined;
  bytes: number;
}

/** Ring buffer of events with cursors and long-poll waiters (Requirement 10.4, 10.8). */
export class EventFeed {
  private entries: Entry[] = [];
  private readonly keys = new Map<string, Entry>();
  private nextSeq = 1;
  private droppedThrough = 0;
  private totalBytes = 0;
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<(event: KiroEvent) => void>();
  private closedFlag = false;

  constructor(
    private readonly caps: { maxEvents: number; maxBytes: number } = { maxEvents: LIMITS.feedEvents, maxBytes: LIMITS.feedBytes },
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The newest seq assigned, or 0. */
  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  /** Cursors at or above this value have lost nothing to the caps. */
  get lowestCursor(): number {
    return this.droppedThrough;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get size(): number {
    return this.entries.length;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  append(event: NewEvent, key?: string): KiroEvent {
    const full = { ...event, seq: this.nextSeq++, at: this.now().toISOString() } as KiroEvent;
    if (key !== undefined) {
      const old = this.keys.get(key);
      if (old !== undefined) {
        const index = this.entries.indexOf(old);
        if (index !== -1) this.entries.splice(index, 1);
        this.totalBytes -= old.bytes;
      }
    }
    const entry: Entry = { event: full, key, bytes: JSON.stringify(full).length };
    this.entries.push(entry);
    this.totalBytes += entry.bytes;
    if (key !== undefined) this.keys.set(key, entry);
    while (this.entries.length > 1 && (this.entries.length > this.caps.maxEvents || this.totalBytes > this.caps.maxBytes)) {
      const dropped = this.entries.shift();
      if (dropped === undefined) break;
      this.totalBytes -= dropped.bytes;
      this.droppedThrough = Math.max(this.droppedThrough, dropped.event.seq);
      if (dropped.key !== undefined && this.keys.get(dropped.key) === dropped) this.keys.delete(dropped.key);
    }
    for (const wake of [...this.waiters]) wake();
    for (const listener of this.listeners) listener(full);
    return full;
  }

  /** Events with seq above `cursor`, at most `limit` that pass `filter`; skipped events still advance the cursor. */
  read(cursor: number, limit: number, filter?: (event: KiroEvent) => boolean): FeedPage {
    const events: KiroEvent[] = [];
    let next = Math.max(cursor, 0);
    for (const { event } of this.entries) {
      if (event.seq <= cursor) continue;
      if (filter !== undefined && !filter(event)) {
        next = event.seq;
        continue;
      }
      if (events.length >= limit) break;
      events.push(event);
      next = event.seq;
    }
    // Nothing left out: the cursor may move past keyed entries that were re-sequenced away.
    if (events.length < limit) next = Math.max(next, this.latestSeq);
    return { events, nextCursor: next, lowestCursor: this.droppedThrough, gap: cursor < this.droppedThrough };
  }

  /** The newest events, oldest first, whose serialized size stays under `maxBytes`. */
  newest(maxBytes: number): KiroEvent[] {
    const out: KiroEvent[] = [];
    let size = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry === undefined) continue;
      if (size + entry.bytes > maxBytes && out.length > 0) break;
      size += entry.bytes;
      out.push(entry.event);
    }
    return out.reverse();
  }

  /** Resolve true once an event newer than `cursor` exists, false on timeout, abort, or close. */
  waitFor(cursor: number, ms: number, signal?: AbortSignal): Promise<boolean> {
    if (this.entries.some((e) => e.event.seq > cursor)) return Promise.resolve(true);
    if (this.closedFlag || ms <= 0 || signal?.aborted === true) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (value: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const wake = () => {
        if (this.closedFlag) finish(false);
        else if (this.entries.some((e) => e.event.seq > cursor)) finish(true);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), ms);
      this.waiters.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Wake every waiter without an event, for example when a turn settles with no new update. */
  poke(): void {
    for (const wake of [...this.waiters]) wake();
  }

  onAppend(listener: (event: KiroEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stop accepting waiters; pending waits resolve false. Events stay readable. */
  close(): void {
    this.closedFlag = true;
    for (const wake of [...this.waiters]) wake();
  }
}
