import { randomBytes } from "node:crypto";

import type { PermissionOption, RequestPermissionParams } from "./acp/types.js";
import type { PermissionPolicy } from "./config.js";
import { ToolError } from "./errors.js";

export const PERMISSION_ID_PATTERN = /^perm_[0-9a-f]{16}$/;

export interface PendingPermission {
  /** Server-assigned id the calling agent answers with. */
  permissionId: string;
  sessionId: string;
  toolCallId: string;
  title: string;
  /** Options exactly as Kiro offered them. */
  options: PermissionOption[];
  consent?: { capability?: string; resource?: string; askType?: string; triggeringResource?: string; workspaceRoot?: string; persistableConsent?: boolean };
  /** Display only: MCP annotations are untrusted claims. */
  mcpTool?: { serverName?: string; toolName?: string; annotations?: Record<string, boolean> };
  toolKind: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface BrokerConfig {
  permissions: PermissionPolicy;
  allowShell: boolean;
  allowPersistentConsent: boolean;
  permissionTimeoutMs: number;
  /** `off` never forwards pending requests as form elicitations (Requirement 12.12). Unset means `on`. */
  elicitation?: "on" | "off";
}

export type Policy = "caller" | "shell_disabled" | "deny" | "allow" | "timeout" | "cancel" | "elicitation";

export type Decision =
  | { kind: "pending" }
  | { kind: "answer"; optionId: string; policy: "shell_disabled" | "deny" | "allow" }
  | { kind: "cancelled" };

export interface PermissionOutcome {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
  _meta?: { kiro: { consent: { scope: string; resource?: string } } };
}

export interface ElicitParams {
  mode: "form";
  message: string;
  requestedSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
}
export type ElicitResult = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

export interface BrokerDeps {
  now?: () => number;
  /** Schedule `fn` after `ms`; returns a canceller. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Present a form elicitation to the client's user; absent when the client lacks the capability. */
  elicit?: (params: ElicitParams) => Promise<ElicitResult>;
  /** Kind of the tool call, from the session's normalizer, when the request omits it. */
  toolKind?: (sessionId: string, toolCallId: string) => string | undefined;
}

/** True when the request asks to run a shell command (Requirement 12.7). */
export function isShell(p: PendingPermission): boolean {
  if (p.consent?.capability !== undefined) return p.consent.capability === "shell";
  return p.toolKind === "execute";
}

const optionOf = (p: PendingPermission, kind: PermissionOption["kind"]) => p.options.find((o) => o.kind === kind);

/** The operator policy for a new request (Requirement 12.2, 12.7, 12.8). Never synthesizes an option. */
export function decideByPolicy(p: PendingPermission, cfg: BrokerConfig): Decision {
  const reject = optionOf(p, "reject_once");
  if (isShell(p) && !cfg.allowShell) return reject !== undefined ? { kind: "answer", optionId: reject.optionId, policy: "shell_disabled" } : { kind: "cancelled" };
  if (cfg.permissions === "deny") return reject !== undefined ? { kind: "answer", optionId: reject.optionId, policy: "deny" } : { kind: "cancelled" };
  if (cfg.permissions === "allow") {
    const allow = optionOf(p, "allow_once");
    if (allow !== undefined) return { kind: "answer", optionId: allow.optionId, policy: "allow" };
  }
  return { kind: "pending" };
}

interface Live {
  pending: PendingPermission;
  resolve: (outcome: PermissionOutcome) => void;
  cancelTimer: () => void;
}

interface Resolved {
  pending: PendingPermission;
  policy: Policy;
  at: number;
}

/**
 * Holds Kiro's session/request_permission requests until the calling agent,
 * the client's user (elicitation), the policy, a timeout, or a cancel answers
 * them. All state is in memory.
 */
export class PermissionBroker {
  private readonly live = new Map<string, Live>();
  private readonly resolved = new Map<string, Resolved>();
  /** Called when a request is recorded and when it is answered, for feed events. */
  onRecord: ((p: PendingPermission) => void) | null = null;
  onDecision: ((p: PendingPermission, d: { policy: Policy; optionId?: string; optionKind?: string; cancelled: boolean }) => void) | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;

  constructor(
    private readonly cfg: BrokerConfig,
    private readonly deps: BrokerDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return () => clearTimeout(t);
      });
  }

  /** Normalize a request into a pending record (no side effects). */
  record(params: RequestPermissionParams): PendingPermission {
    const kiro = params._meta?.kiro ?? {};
    const toolCallId = params.toolCall?.toolCallId ?? "";
    const created = this.now();
    const toolKind = params.toolCall?.kind ?? this.deps.toolKind?.(params.sessionId, toolCallId) ?? null;
    return {
      permissionId: `perm_${randomBytes(8).toString("hex")}`,
      sessionId: params.sessionId,
      toolCallId,
      title: params.toolCall?.title ?? kiro.command ?? "",
      options: (params.options ?? []).filter((o) => typeof o?.optionId === "string").map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      ...(kiro.consent !== undefined ? { consent: { ...kiro.consent } } : {}),
      ...(kiro.mcpTool !== undefined ? { mcpTool: { ...kiro.mcpTool } } : {}),
      toolKind,
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + this.cfg.permissionTimeoutMs).toISOString(),
    };
  }

  /** Handle a session/request_permission request; resolves with the ACP result. */
  handle(params: RequestPermissionParams): Promise<PermissionOutcome> {
    const pending = this.record(params);
    this.onRecord?.(pending);
    const decision = decideByPolicy(pending, this.cfg);
    if (decision.kind === "answer") {
      this.finish(pending, decision.policy, decision.optionId);
      return Promise.resolve({ outcome: { outcome: "selected", optionId: decision.optionId } });
    }
    if (decision.kind === "cancelled") {
      this.finish(pending, "cancel");
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    return new Promise((resolve) => {
      const cancelTimer = this.setTimer(() => this.timeout(pending.permissionId), this.cfg.permissionTimeoutMs);
      this.live.set(pending.permissionId, { pending, resolve, cancelTimer });
      if (this.deps.elicit !== undefined && this.cfg.elicitation !== "off") void this.elicit(pending);
    });
  }

  list(sessionId?: string): PendingPermission[] {
    return [...this.live.values()].map((l) => l.pending).filter((p) => sessionId === undefined || p.sessionId === sessionId);
  }

  hasPending(sessionId: string): boolean {
    for (const l of this.live.values()) if (l.pending.sessionId === sessionId) return true;
    return false;
  }

  /** Options the calling agent may pick for this request (Requirement 12.5, 12.7). */
  acceptable(p: PendingPermission): PermissionOption[] {
    return p.options.filter((o) => {
      if (o.kind.startsWith("allow") && isShell(p) && !this.cfg.allowShell) return false;
      if (o.kind === "allow_always" && !this.cfg.allowPersistentConsent) return false;
      return true;
    });
  }

  /** Answer with an offered option (Requirement 12.3–12.6). */
  respond(permissionId: string, optionId: string, opts: { scope?: string; resource?: string; policy?: Policy }): PermissionOption {
    const entry = this.live.get(permissionId);
    if (entry === undefined) {
      const done = this.resolved.get(permissionId);
      const option = done?.pending.options.find((o) => o.optionId === optionId);
      if (done?.policy === "shell_disabled" && option?.kind.startsWith("allow")) {
        throw new ToolError("SHELL_APPROVAL_DISABLED", "shell commands cannot be approved unless the operator sets KIRO_MCP_ALLOW_SHELL; this request was rejected", { permissionId });
      }
      throw new ToolError("PERMISSION_NOT_FOUND", `permission ${permissionId} is not pending`, { permissionId });
    }
    const p = entry.pending;
    const option = p.options.find((o) => o.optionId === optionId);
    if (option === undefined) throw new ToolError("OPTION_NOT_OFFERED", `option ${JSON.stringify(optionId)} was not offered`, { offered: p.options.map((o) => o.optionId) });
    if (option.kind.startsWith("allow") && isShell(p) && !this.cfg.allowShell) {
      throw new ToolError("SHELL_APPROVAL_DISABLED", "shell commands cannot be approved unless the operator sets KIRO_MCP_ALLOW_SHELL");
    }
    if (option.kind === "allow_always" && !this.cfg.allowPersistentConsent) {
      throw new ToolError("PERSISTENT_CONSENT_DISABLED", "allow_always needs KIRO_MCP_ALLOW_PERSISTENT_CONSENT; pick allow_once instead");
    }
    const persistent = option.kind === "allow_always" || option.kind === "reject_always";
    const scope = persistent ? opts.scope : undefined;
    const resource = opts.resource ?? p.consent?.resource;
    this.settle(p.permissionId, opts.policy ?? "caller", {
      outcome: { outcome: "selected", optionId: option.optionId },
      ...(scope !== undefined ? { _meta: { kiro: { consent: { scope, ...(resource !== undefined ? { resource } : {}) } } } } : {}),
    }, option);
    return option;
  }

  /** Answer every pending request of a session: reject_once when offered, else cancelled (Requirement 11.3). */
  cancelSession(sessionId: string): void {
    for (const p of this.list(sessionId)) this.rejectOrCancel(p, "cancel");
  }

  /** Answer everything (shutdown). */
  cancelAll(): void {
    for (const p of this.list()) this.rejectOrCancel(p, "cancel");
  }

  private rejectOrCancel(p: PendingPermission, policy: Policy): void {
    const reject = optionOf(p, "reject_once");
    if (reject !== undefined) this.settle(p.permissionId, policy, { outcome: { outcome: "selected", optionId: reject.optionId } }, reject);
    else this.settle(p.permissionId, policy, { outcome: { outcome: "cancelled" } });
  }

  private timeout(permissionId: string): void {
    const entry = this.live.get(permissionId);
    if (entry !== undefined) this.rejectOrCancel(entry.pending, "timeout");
  }

  private settle(permissionId: string, policy: Policy, outcome: PermissionOutcome, option?: PermissionOption): void {
    const entry = this.live.get(permissionId);
    if (entry === undefined) return;
    this.live.delete(permissionId);
    entry.cancelTimer();
    this.finish(entry.pending, policy, option?.optionId);
    entry.resolve(outcome);
  }

  private finish(p: PendingPermission, policy: Policy, optionId?: string): void {
    this.resolved.set(p.permissionId, { pending: p, policy, at: this.now() });
    if (this.resolved.size > 500) {
      const oldest = this.resolved.keys().next().value;
      if (oldest !== undefined) this.resolved.delete(oldest);
    }
    const option = p.options.find((o) => o.optionId === optionId);
    this.onDecision?.(p, { policy, ...(optionId !== undefined ? { optionId } : {}), ...(option !== undefined ? { optionKind: option.kind } : {}), cancelled: optionId === undefined });
  }

  /** Forward to the client's user as a form elicitation (Requirement 12.11). */
  private async elicit(p: PendingPermission): Promise<void> {
    const choices = this.acceptable(p);
    if (choices.length === 0 || this.deps.elicit === undefined) return;
    const resource = p.consent?.resource ? ` (${p.consent.resource})` : "";
    let result: ElicitResult;
    try {
      result = await this.deps.elicit({
        mode: "form",
        message: `Kiro asks for permission: ${p.title}${resource}`,
        requestedSchema: {
          type: "object",
          properties: { option: { type: "string", title: "Choice", oneOf: choices.map((o) => ({ const: o.optionId, title: o.name })) } },
          required: ["option"],
        },
      });
    } catch {
      return; // stays pending for kiro_permission_respond
    }
    if (!this.live.has(p.permissionId)) return;
    if (result.action === "accept") {
      const chosen = typeof result.content?.option === "string" ? result.content.option : undefined;
      if (chosen === undefined || !choices.some((o) => o.optionId === chosen)) return;
      try {
        this.respond(p.permissionId, chosen, { policy: "elicitation" });
      } catch {
        // gates refused it; it stays pending
      }
    } else if (result.action === "decline") {
      const reject = optionOf(p, "reject_once");
      if (reject !== undefined) this.settle(p.permissionId, "elicitation", { outcome: { outcome: "selected", optionId: reject.optionId } }, reject);
    }
  }
}

/** A pending permission as tool output. */
export function permissionView(p: PendingPermission) {
  return {
    permission_id: p.permissionId,
    session_id: p.sessionId,
    tool_call_id: p.toolCallId,
    title: p.title,
    options: p.options.map((o) => ({ option_id: o.optionId, name: o.name, kind: o.kind })),
    consent: p.consent ?? null,
    mcp_tool: p.mcpTool ? { ...p.mcpTool, untrusted: true } : null,
    tool_kind: p.toolKind,
    created_at: p.createdAt,
    expires_at: p.expiresAt,
  };
}
