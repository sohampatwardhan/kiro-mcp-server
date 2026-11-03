import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Core } from "../core.js";
import { PERMISSION_ID_PATTERN, permissionView, type PermissionBroker } from "../permissions.js";
import { defineTool } from "./define.js";
import { pendingPermissionView, sessionId } from "./schemas.js";

export function registerPermissionTools(server: McpServer, core: Core, broker: PermissionBroker): void {
  defineTool(
    server,
    "kiro_permissions",
    {
      title: "Pending Kiro permissions",
      description:
        "List Kiro's pending permission requests (all sessions, or one), with the options exactly as offered, the consent details (capability, resource, " +
        "workspace root), and the MCP tool identity, which is untrusted display data. Answer with kiro_permission_respond before expires_at, or the request is rejected.",
      input: z.object({ session_id: sessionId.optional() }).strict(),
      output: z.object({ pending: z.array(pendingPermissionView), policy: z.string(), shell_approvals: z.boolean(), persistent_consent: z.boolean() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => ({
      pending: broker.list(args.session_id).map(permissionView),
      policy: core.config.permissions,
      shell_approvals: core.config.allowShell,
      persistent_consent: core.config.allowPersistentConsent,
    }),
  );

  defineTool(
    server,
    "kiro_permission_respond",
    {
      title: "Answer a Kiro permission",
      description:
        "Answer a pending permission with one of its offered option_ids (never anything else). allow_always needs the operator's " +
        "KIRO_MCP_ALLOW_PERSISTENT_CONSENT; reject_always is always allowed because it only narrows Kiro. For an always option, `scope` (session, workspace, " +
        "or user) and `resource` (a pattern; default the request's resource) are sent as Kiro consent. Shell commands can be approved only when the " +
        "operator sets KIRO_MCP_ALLOW_SHELL. A denied tool call fails and the turn continues.",
      input: z
        .object({
          permission_id: z.string().regex(PERMISSION_ID_PATTERN),
          option_id: z.string().min(1).max(200),
          scope: z.enum(["session", "workspace", "user"]).optional(),
          resource: z.string().min(1).max(1_000).optional(),
        })
        .strict(),
      output: z.object({ permission_id: z.string(), resolved: z.boolean(), option_id: z.string(), option_kind: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const option = broker.respond(args.permission_id, args.option_id, {
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
        ...(args.resource !== undefined ? { resource: args.resource } : {}),
      });
      return { permission_id: args.permission_id, resolved: true, option_id: option.optionId, option_kind: option.kind };
    },
  );
}
