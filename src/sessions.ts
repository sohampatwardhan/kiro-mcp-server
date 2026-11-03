import { EventEmitter } from "node:events";

import type { AcpHost } from "./acp/host.js";
import type { CommandInfo, ConfigOption, ModeInfo } from "./acp/types.js";
import { LIMITS } from "./config.js";
import { ToolError } from "./errors.js";
import { EventFeed, SessionNormalizer, type CreditSummary, type Keyed, type StateChange } from "./events.js";
import type { Roots } from "./paths.js";

/** `sess_` and a UUID, or a bare UUID for sessions imported from CLI 2.x. */
export const SESSION_ID_PATTERN =
  /^(?:sess_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Snapshot kinds the host sends as full replacements (Requirement 15.1). */
export const SNAPSHOT_METHODS: Record<string, SnapshotKind> = {
  "_kiro/mcp/status": "mcp",
  "_kiro/tools/didChange": "tools",
  "_kiro/steering/documents_changed": "steering",
  "_kiro/progressive_context/items_changed": "skills",
  "_kiro/powers/items_changed": "powers",
  "_kiro/governance/state": "governance",
};

export type SnapshotKind = "mcp" | "tools" | "steering" | "skills" | "powers" | "governance" | "agent_errors";

export interface Snapshot {
  data: unknown;
  receivedAt: string;
}

export interface UserMessageRef {
  messageId: string;
  turnIndex: number;
  preview: string;
}

export interface AttachInputs {
  cwd: string;
  additionalDirectories: string[];
  source: "local" | "remote";
  executionTarget: string;
}

/** Hooks the turn manager and permission broker install on each session's update stream. */
export interface SessionObserver {
  /** The running turn's id, stamped on live events. */
  turnIdFor(session: AttachedSession): string | undefined;
  /** Called for every normalized event and state change, after the feed append. */
  onEvents(session: AttachedSession, events: Keyed[], state: StateChange): void;
}

/** A Kiro session the server created or loaded on the current host. */
export class AttachedSession {
  readonly feed = new EventFeed();
  readonly normalizer = new SessionNormalizer();
  modes: ModeInfo[] = [];
  currentModeId: string | undefined;
  configOptions: ConfigOption[] = [];
  commands: CommandInfo[] = [];
  readonly snapshots = new Map<SnapshotKind, Snapshot>();
  contextUsage: Record<string, unknown> | null = null;
  title: string | undefined;
  readonly userMessages: UserMessageRef[] = [];
  /** Credits observed for this session's turns since it was attached (Requirement 3.3). */
  readonly creditTotals = new Map<string, number>();
  turnCount = 0;
  hostGeneration: number;
  detached = false;
  closed = false;
  closedAt: number | null = null;
  /** True while session/load replays history. */
  replaying = false;
  /** Drop replayed message events (re-attach after a host restart: the feed already holds them). */
  suppressReplay = false;
  /** Last user prompt text preview, recorded by the turn manager for rewind points. */
  pendingPreview: string | undefined;

  constructor(
    readonly sessionId: string,
    public cwd: string,
    public additionalDirectories: string[],
    public source: "local" | "remote",
    public executionTarget: string,
    generation: number,
  ) {
    this.hostGeneration = generation;
  }

  get modeIds(): string[] {
    const fromModes = this.modes.map((m) => m.id);
    const modeOption = this.configOptions.find((o) => o.id === "mode");
    const fromConfig = (modeOption?.options ?? []).map((o) => o.value);
    return [...new Set([...fromModes, ...fromConfig])];
  }

  addCredits(credits: CreditSummary[]): void {
    for (const c of credits) {
      if (typeof c.usage !== "number") continue;
      const unit = c.unit ?? "credit";
      this.creditTotals.set(unit, (this.creditTotals.get(unit) ?? 0) + c.usage);
    }
  }

  applyResult(result: Record<string, unknown>): void {
    const modes = result.modes as { availableModes?: ModeInfo[]; currentModeId?: string } | undefined;
    if (modes !== undefined && modes !== null) {
      if (Array.isArray(modes.availableModes)) this.modes = modes.availableModes.filter((m) => typeof m?.id === "string");
      if (typeof modes.currentModeId === "string") this.currentModeId = modes.currentModeId;
    }
    if (Array.isArray(result.configOptions)) this.configOptions = result.configOptions as ConfigOption[];
    const meta = result._meta as { title?: unknown; agentMode?: unknown } | undefined;
    if (typeof meta?.title === "string") this.title = meta.title;
    if (this.currentModeId === undefined && typeof meta?.agentMode === "string") this.currentModeId = meta.agentMode;
    this.syncModeFromConfig();
  }

  syncModeFromConfig(): void {
    const mode = this.configOptions.find((o) => o.id === "mode");
    if (typeof mode?.currentValue === "string") this.currentModeId = mode.currentValue;
  }
}

/**
 * Attached sessions on the shared host, routed by sessionId. Re-attaches a
 * session with session/load when the host restarted (Requirement 5.6) and
 * never resends a prompt.
 */
export class SessionRegistry extends EventEmitter {
  private readonly sessions = new Map<string, AttachedSession>();
  /** Updates for session ids not attached yet (they may precede the session/new response). */
  private readonly early = new Map<string, { method: string; params: unknown; at: number }[]>();
  private readonly loads = new Map<string, Promise<AttachedSession>>();
  observer: SessionObserver | null = null;
  memorySyncStatus: unknown = null;

  constructor(
    private readonly host: AcpHost,
    private readonly roots: Roots,
  ) {
    super();
    host.onNotification("session/update", (params) => this.route("session/update", params));
    host.onAnyNotification((params, method) => {
      if (method === "session/update") return;
      if (method === "_kiro/memory/syncStatus") {
        this.memorySyncStatus = params;
        return;
      }
      this.route(method, params);
    });
    host.on("exited", () => this.detachAll());
  }

  get(sessionId: string): AttachedSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Attached and recently closed sessions. */
  all(): AttachedSession[] {
    this.pruneClosed();
    return [...this.sessions.values()];
  }

  /** The session if attached (not closed), else SESSION_NOT_FOUND. Does not re-attach. */
  require(sessionId: string): AttachedSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.closed) {
      throw new ToolError("SESSION_NOT_FOUND", `session ${sessionId} is not attached to this server; load it with kiro_session_load`, { sessionId });
    }
    return session;
  }

  attach(sessionId: string, result: Record<string, unknown>, inputs: AttachInputs): AttachedSession {
    const existing = this.sessions.get(sessionId);
    const session =
      existing !== undefined && !existing.closed
        ? existing
        : new AttachedSession(sessionId, inputs.cwd, inputs.additionalDirectories, inputs.source, inputs.executionTarget, this.host.generation);
    session.cwd = inputs.cwd;
    session.additionalDirectories = inputs.additionalDirectories;
    session.source = inputs.source;
    session.executionTarget = inputs.executionTarget;
    session.hostGeneration = this.host.generation;
    session.detached = false;
    session.applyResult(result);
    this.sessions.set(sessionId, session);
    this.flushEarly(session);
    this.emit("attached", session);
    return session;
  }

  /**
   * Load a session from Kiro's store onto the host and attach it. Replayed
   * updates are marked `replay: true`. Concurrent loads of one id share a call.
   */
  load(sessionId: string, inputs: AttachInputs, opts: { reattach?: boolean } = {}): Promise<AttachedSession> {
    const running = this.loads.get(sessionId);
    if (running !== undefined) return running;
    const promise = this.doLoad(sessionId, inputs, opts).finally(() => this.loads.delete(sessionId));
    this.loads.set(sessionId, promise);
    return promise;
  }

  private async doLoad(sessionId: string, inputs: AttachInputs, opts: { reattach?: boolean }): Promise<AttachedSession> {
    await this.host.ensureStarted();
    // Register first, so replayed updates route to this session (Requirement 7.4).
    let session = this.sessions.get(sessionId);
    if (session === undefined || session.closed) {
      session = new AttachedSession(sessionId, inputs.cwd, inputs.additionalDirectories, inputs.source, inputs.executionTarget, this.host.generation);
      session.detached = true;
      this.sessions.set(sessionId, session);
    }
    session.replaying = true;
    session.suppressReplay = opts.reattach === true;
    try {
      const result = (await this.host.call("session/load", {
        sessionId,
        cwd: inputs.cwd,
        ...(inputs.additionalDirectories.length > 0 ? { additionalDirectories: inputs.additionalDirectories } : {}),
        mcpServers: [],
      })) as Record<string, unknown> | null;
      return this.attach(sessionId, result ?? {}, inputs);
    } catch (err) {
      if (opts.reattach !== true) this.sessions.delete(sessionId);
      throw toSessionError(err, sessionId);
    } finally {
      session.replaying = false;
      session.suppressReplay = false;
      session.normalizer.breakSegment();
    }
  }

  /**
   * The attached session, re-attached first when the host restarted since it
   * was attached. SESSION_NOT_FOUND when it was never attached here.
   */
  async ensureAttached(sessionId: string): Promise<AttachedSession> {
    const session = this.require(sessionId);
    if (!session.detached && session.hostGeneration === this.host.generation && this.host.state === "ready") return session;
    await this.host.ensureStarted();
    if (!session.detached && session.hostGeneration === this.host.generation) return session;
    return this.load(
      sessionId,
      { cwd: session.cwd, additionalDirectories: session.additionalDirectories, source: session.source, executionTarget: session.executionTarget },
      { reattach: true },
    );
  }

  /** Mark every session detached (host exit). Running turns are failed by the turn manager. */
  detachAll(): void {
    for (const session of this.sessions.values()) {
      if (session.closed) continue;
      session.detached = true;
      session.feed.append({ type: "notice", kind: "host_exited", message: "The Kiro ACP host exited; the session re-attaches on its next use" });
    }
    this.emit("detached");
  }

  /** Mark closed: the feed stays readable for the job TTL (Requirement 8.1, 26.7). */
  markClosed(session: AttachedSession): void {
    session.closed = true;
    session.closedAt = Date.now();
    session.feed.close();
    this.emit("closed", session);
    this.pruneClosed();
  }

  forget(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session !== undefined && !session.closed) this.markClosed(session);
    this.sessions.delete(sessionId);
  }

  private pruneClosed(): void {
    const now = Date.now();
    const closed = [...this.sessions.values()].filter((s) => s.closed).sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
    for (const session of closed) {
      if (now - (session.closedAt ?? now) > LIMITS.jobTtlMs) this.sessions.delete(session.sessionId);
    }
    const remaining = closed.filter((s) => this.sessions.has(s.sessionId));
    for (const session of remaining.slice(0, Math.max(0, remaining.length - LIMITS.maxClosedSessions))) this.sessions.delete(session.sessionId);
  }

  private route(method: string, params: unknown): void {
    const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : undefined;
    if (sessionId === undefined) return;
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.closed) {
      if (method === "_kiro/sessions/changed") return;
      const list = this.early.get(sessionId) ?? [];
      if (list.length < 500) list.push({ method, params, at: Date.now() });
      this.early.set(sessionId, list);
      this.pruneEarly();
      return;
    }
    this.deliver(session, method, params);
  }

  private flushEarly(session: AttachedSession): void {
    const list = this.early.get(session.sessionId);
    if (list === undefined) return;
    this.early.delete(session.sessionId);
    for (const item of list) this.deliver(session, item.method, item.params);
  }

  private pruneEarly(): void {
    const cutoff = Date.now() - 30_000;
    for (const [id, list] of this.early) if ((list.at(-1)?.at ?? 0) < cutoff) this.early.delete(id);
  }

  private deliver(session: AttachedSession, method: string, params: unknown): void {
    const p = params as Record<string, unknown>;
    const snapshotKind = SNAPSHOT_METHODS[method];
    if (snapshotKind !== undefined) {
      const data = { ...p };
      delete data.sessionId;
      session.snapshots.set(snapshotKind, { data, receivedAt: new Date().toISOString() });
      return;
    }
    const turnId = session.replaying ? undefined : this.observer?.turnIdFor(session);
    const ctx = { replay: session.replaying, ...(turnId !== undefined ? { turnId } : {}) };
    if (method === "_kiro/customAgent/config_error" || method === "_kiro/customAgent/not_found") {
      const prev = (session.snapshots.get("agent_errors")?.data as Record<string, unknown>[] | undefined) ?? [];
      const entry = { ...p, kind: method.endsWith("not_found") ? "not_found" : "config_error" };
      delete (entry as Record<string, unknown>).sessionId;
      const key = String(p.path ?? p.agent ?? p.name ?? prev.length);
      const next = [...prev.filter((e) => String(e.path ?? e.agent ?? e.name) !== key), entry];
      session.snapshots.set("agent_errors", { data: next, receivedAt: new Date().toISOString() });
    }
    let events: Keyed[];
    let state: StateChange = {};
    if (method === "session/update") {
      ({ events, state } = session.normalizer.apply(params, ctx));
    } else {
      events = session.normalizer.notification(method, params, ctx);
    }
    this.applyState(session, state);
    if (session.suppressReplay) events = events.filter((e) => e.event.type !== "message" && e.event.type !== "thought" && e.event.type !== "user_message" && e.event.type !== "tool_call");
    for (const { event, key } of events) session.feed.append(event, key);
    this.observer?.onEvents(session, events, state);
  }

  private applyState(session: AttachedSession, state: StateChange): void {
    if (state.modeId !== undefined) session.currentModeId = state.modeId;
    if (state.configOptions !== undefined) {
      session.configOptions = state.configOptions as ConfigOption[];
      session.syncModeFromConfig();
    }
    if (state.commands !== undefined) session.commands = state.commands as CommandInfo[];
    if (state.contextUsage !== undefined) session.contextUsage = state.contextUsage;
    if (state.title !== undefined) session.title = state.title;
    if (state.userMessageId !== undefined && !session.userMessages.some((m) => m.messageId === state.userMessageId)) {
      session.userMessages.push({
        messageId: state.userMessageId,
        turnIndex: session.userMessages.length + 1,
        preview: (session.pendingPreview ?? "").slice(0, 120),
      });
      session.pendingPreview = undefined;
    }
  }

  /** Check a session's root: local sessions must be inside a root, remote sessions skip the check. */
  async resolveCwd(cwd: string): Promise<string> {
    return this.roots.resolveInside(cwd);
  }
}

/** Map Kiro's "session not found" errors to SESSION_NOT_FOUND. */
export function toSessionError(err: unknown, sessionId: string): unknown {
  if (!(err instanceof ToolError) || err.code !== "KIRO_ERROR") return err;
  const kiro = err.details.kiro as { message?: string; errorType?: string } | undefined;
  if (/notfound/i.test(kiro?.errorType ?? "") || /\bnot found\b|unknown session|no such session/i.test(kiro?.message ?? "")) {
    return new ToolError("SESSION_NOT_FOUND", `Kiro has no session ${sessionId}`, { sessionId, kiro });
  }
  return err;
}
