import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Config } from "./config.js";
import type { RequestPermissionParams } from "./acp/types.js";
import { createCore, type Core } from "./core.js";
import { PermissionBroker, permissionView, type ElicitParams, type ElicitResult } from "./permissions.js";
import { registerBranchingTools } from "./tools/branching.js";
import { registerConfigureTools } from "./tools/configure.js";
import { registerExtensionTools } from "./tools/extensions.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerPermissionTools } from "./tools/permissions.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerSpecTools } from "./tools/specs.js";
import { registerStatusTools } from "./tools/status.js";
import { registerControlTools, registerTurnTools } from "./tools/turns.js";

export const SERVER_NAME = "kiro-mcp-server";
export const SERVER_VERSION = "0.1.0";

/** Server-level guidance sent to clients in the initialize result (Requirement 25.5). */
export const SERVER_INSTRUCTIONS = "Orchestrates Kiro CLI V3 sessions. Call kiro_status first.";

export interface KiroServer {
  server: McpServer;
  core: Core;
}

/** Composition root: builds the core modules and registers every tool in src/tools. */
export function createServer(config: Config): KiroServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const core = createCore(config, SERVER_VERSION);
  const broker = wirePermissions(server, core);
  registerStatusTools(server, core);
  registerSessionTools(server, core);
  registerConfigureTools(server, core);
  registerHistoryTools(server, core);
  registerTurnTools(server, core);
  registerControlTools(server, core);
  registerPermissionTools(server, core, broker);
  registerBranchingTools(server, core);
  registerSpecTools(server, core);
  registerExtensionTools(server, core);
  core.closeHooks.push(async (session) => {
    core.cancelPermissions(session.sessionId);
    await core.turns.cancel(session, 5_000);
  });
  return { server, core };
}

/** The permission broker on the host's session/request_permission requests, with feed events and elicitation. */
function wirePermissions(server: McpServer, core: Core): PermissionBroker {
  const { config, sessions, turns, host } = core;
  const broker = new PermissionBroker(config, {
    toolKind: (sessionId, toolCallId) => sessions.get(sessionId)?.normalizer.toolCall(toolCallId)?.kind,
    elicit: (params: ElicitParams): Promise<ElicitResult> => {
      if (server.server.getClientCapabilities()?.elicitation?.form === undefined) return Promise.reject(new Error("no form elicitation"));
      return server.server.elicitInput(params as Parameters<typeof server.server.elicitInput>[0]) as Promise<ElicitResult>;
    },
  });
  broker.onRecord = (p) => {
    const session = sessions.get(p.sessionId);
    const turnId = turns.activeTurn(p.sessionId)?.turnId;
    session?.feed.append({ type: "permission_requested", permissionId: p.permissionId, toolCallId: p.toolCallId, title: p.title, ...(turnId ? { turnId } : {}) });
  };
  broker.onDecision = (p, d) => {
    const session = sessions.get(p.sessionId);
    if (session === undefined) return;
    if (d.cancelled || d.policy === "cancel") session.normalizer.noteDecision(p.toolCallId, "cancelled");
    else if (d.optionKind?.startsWith("reject")) session.normalizer.noteDecision(p.toolCallId, "denied");
    const turnId = turns.activeTurn(p.sessionId)?.turnId;
    session.feed.append({
      type: "permission_resolved",
      permissionId: p.permissionId,
      toolCallId: p.toolCallId,
      policy: d.policy,
      ...(d.optionId !== undefined ? { optionId: d.optionId } : {}),
      ...(d.optionKind !== undefined ? { optionKind: d.optionKind } : {}),
      ...(turnId ? { turnId } : {}),
    });
  };
  host.onRequest("session/request_permission", (params) => broker.handle(params as RequestPermissionParams));
  host.on("exited", () => broker.cancelAll());
  turns.hooks.waitingOnPermission = (turn) => broker.hasPending(turn.sessionId);
  core.pendingPermissions = (sessionId) => broker.list(sessionId).map(permissionView);
  core.cancelPermissions = (sessionId) => broker.cancelSession(sessionId);
  return broker;
}
