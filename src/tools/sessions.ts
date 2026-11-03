import { existsSync, statSync } from "node:fs";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { LIMITS } from "../config.js";
import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import type { AttachedSession } from "../sessions.js";
import { defineTool } from "./define.js";
import { commandsView, configOptionView, contextUsageView, json, modeView, name, pathInput, sessionId } from "./schemas.js";
import { commandsOf, configOptionsOf, contextUsageOf, currentValue, modesOf } from "./views.js";

export const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/;

/** How long session/new waits for the first command catalog before returning. */
const CATALOG_WAIT_MS = 300;

export function sessionSummary(session: AttachedSession) {
  return {
    session_id: session.sessionId,
    modes: modesOf(session),
    current_mode: session.currentModeId ?? null,
    config_options: configOptionsOf(session),
    commands: commandsOf(session),
    context_usage: contextUsageOf(session),
    cursor: session.feed.latestSeq,
  };
}

export const sessionSummaryShape = {
  session_id: z.string(),
  modes: z.array(modeView),
  current_mode: z.string().nullable(),
  config_options: z.array(configOptionView),
  commands: commandsView,
  context_usage: contextUsageView,
  cursor: z.number(),
};

export async function waitForCatalog(session: AttachedSession, ms = CATALOG_WAIT_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (session.commands.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

export function replaySummary(session: AttachedSession) {
  const replayed = session.feed.read(0, LIMITS.feedEvents).events.filter((e) => e.replay === true);
  const messages = replayed.filter((e) => e.type === "message" || e.type === "user_message");
  const lastAgent = [...replayed].reverse().find((e) => e.type === "message");
  const text = lastAgent !== undefined && lastAgent.type === "message" ? lastAgent.text : null;
  return { message_count: messages.length, last_agent_message: text === null ? null : text.slice(0, 500) };
}

export function registerSessionTools(server: McpServer, core: Core): void {
  const { roots, host, sessions } = core;

  defineTool(
    server,
    "kiro_session_list",
    {
      title: "List Kiro sessions",
      description:
        "List saved Kiro sessions with session/list: scope `workspace` (sessions whose cwd is `cwd`, default the first root) or `user` " +
        "(every workspace; local sessions outside KIRO_MCP_ROOTS are left out and only counted). Filters by source (local or remote cloud sessions), " +
        "title substring, and limit run on this server and report how many were left out.",
      input: z
        .object({
          scope: z.enum(["workspace", "user"]).optional(),
          cwd: pathInput("Workspace directory inside KIRO_MCP_ROOTS (default: the first root).").optional(),
          source: z.enum(["local", "remote"]).optional(),
          title_contains: z.string().min(1).max(200).optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .strict(),
      output: z.object({
        sessions: z.array(
          z.object({
            session_id: z.string(),
            cwd: z.string().nullable(),
            title: z.string().nullable(),
            updated_at: z.string().nullable(),
            source: z.string(),
            execution_target: z.string().nullable(),
            status: z.string().nullable(),
            agent_mode: z.string().nullable(),
            attached: z.boolean(),
          }),
        ),
        omitted_count: z.number(),
        omitted_outside_roots: z.number(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const scope = args.scope ?? "workspace";
      const cwd = args.cwd !== undefined ? await roots.resolveInside(args.cwd) : roots.primary;
      let list = await sessions.listStore(scope, cwd);
      let outsideRoots = 0;
      if (scope === "user") {
        const kept = list.filter((s) => s.source === "remote" || (s.cwd !== null && roots.contains(s.cwd)));
        outsideRoots = list.length - kept.length;
        list = kept;
      }
      const before = list.length;
      if (args.source !== undefined) list = list.filter((s) => s.source === args.source);
      if (args.title_contains !== undefined) {
        const needle = args.title_contains.toLowerCase();
        list = list.filter((s) => (s.title ?? "").toLowerCase().includes(needle));
      }
      list.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      const limited = args.limit !== undefined ? list.slice(0, args.limit) : list;
      return {
        sessions: limited.map((s) => ({
          session_id: s.sessionId,
          cwd: s.cwd,
          title: s.title,
          updated_at: s.updatedAt,
          source: s.source,
          execution_target: s.executionTarget,
          status: s.status,
          agent_mode: s.agentMode,
          attached: sessions.get(s.sessionId)?.closed === false,
        })),
        omitted_count: before - limited.length,
        omitted_outside_roots: outsideRoots,
      };
    },
  );

  defineTool(
    server,
    "kiro_session_load",
    {
      title: "Load a Kiro session",
      description:
        "Resume a saved local or cloud session (session/load) and attach it to this server, like `kiro-cli chat --resume-id`. " +
        "Pass `session_id`, or `latest: true` with `cwd` for the most recently updated session in that workspace (`--resume`). " +
        "Replayed history goes into the session's event feed marked replay; the result has a short replay summary and the cursor to poll from. " +
        "Cloud sessions keep streaming, and approvals that were waiting are returned in pending_permissions.",
      input: z
        .object({
          session_id: sessionId.optional(),
          latest: z.boolean().optional(),
          cwd: pathInput("Workspace directory inside KIRO_MCP_ROOTS.").optional(),
          additional_directories: z.array(pathInput("Extra directory inside KIRO_MCP_ROOTS.")).max(10).optional(),
        })
        .strict(),
      output: z.object({
        ...sessionSummaryShape,
        source: z.string(),
        execution_target: z.string(),
        already_attached: z.boolean(),
        replay_summary: z.object({ message_count: z.number(), last_agent_message: z.string().nullable() }),
        pending_permissions: z.array(json),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      let id = args.session_id;
      if (id === undefined) {
        if (args.latest !== true) throw new ToolError("SESSION_NOT_FOUND", "pass session_id, or latest: true with cwd");
        const cwd = args.cwd !== undefined ? await roots.resolveInside(args.cwd) : roots.primary;
        const list = await sessions.listStore("workspace", cwd);
        list.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
        const newest = list[0];
        if (newest === undefined) throw new ToolError("SESSION_NOT_FOUND", `no saved session for ${cwd}`, { cwd });
        id = newest.sessionId;
      }
      const { session, loaded } = await sessions.attachById(id, {
        ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
        ...(args.additional_directories !== undefined ? { additionalDirectories: args.additional_directories } : {}),
      });
      await waitForCatalog(session, loaded ? 300 : 0);
      return {
        ...sessionSummary(session),
        source: session.source,
        execution_target: session.executionTarget,
        already_attached: !loaded,
        replay_summary: replaySummary(session),
        pending_permissions: core.pendingPermissions(session.sessionId),
      };
    },
  );

  defineTool(
    server,
    "kiro_session_new",
    {
      title: "New Kiro session",
      description:
        "Create a Kiro CLI V3 session (session/new) in a workspace inside KIRO_MCP_ROOTS and attach it to this server. " +
        "Optionally pick the agent mode (vibe, plan, spec, quick-spec, bug-fix, autonomous, or a custom agent), model, and effort; " +
        "values Kiro did not apply are listed in `warnings`. execution_target `cloud` creates a cloud sandbox session on the given repos. " +
        "Caller-supplied MCP servers are never accepted. Also how to compose /clear (start a new session) and /spawn (a new session plus kiro_prompt).",
      input: z
        .object({
          cwd: pathInput("Workspace directory, inside KIRO_MCP_ROOTS (relative paths resolve against the first root)."),
          additional_directories: z.array(pathInput("Extra directory inside KIRO_MCP_ROOTS.")).max(10).optional(),
          mode: name("Initial agent mode id, as advertised by Kiro.").optional(),
          model: name("Initial model id.").optional(),
          effort: name("Initial effort level, when the model supports it.").optional(),
          title: z.string().min(1).max(200).optional().describe("Session title, set with _kiro/session/rename."),
          execution_target: z.enum(["local", "cloud"]).optional().describe("`cloud` runs the session in a Kiro cloud sandbox."),
          repos: z.array(z.string().regex(REPO_PATTERN)).min(1).max(LIMITS.maxRepos).optional().describe("owner/name repositories for a cloud session."),
        })
        .strict(),
      output: z.object({ ...sessionSummaryShape, title: z.string().nullable(), execution_target: z.string(), warnings: z.array(z.string()) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const cwd = await roots.resolveInside(args.cwd);
      const additional = await Promise.all((args.additional_directories ?? []).map((d) => roots.resolveInside(d, cwd)));
      const cloud = args.execution_target === "cloud";
      if (args.repos !== undefined && !cloud) throw new ToolError("VALUE_NOT_ADVERTISED", "repos are only valid with execution_target `cloud`");
      await host.ensureStarted();
      if (cloud && !(host.kiro.executionTargets ?? []).includes("cloud-sandbox")) {
        throw new ToolError("UNSUPPORTED_BY_KIRO", "this Kiro host does not advertise the cloud-sandbox execution target", {
          executionTargets: host.kiro.executionTargets ?? [],
        });
      }
      const kiroMeta: Record<string, unknown> = {};
      if (args.mode !== undefined) kiroMeta.modeId = args.mode;
      if (args.model !== undefined) kiroMeta.modelId = args.model;
      if (args.effort !== undefined) kiroMeta.effortLevel = args.effort;
      if (cloud) {
        kiroMeta.executionTarget = "cloud-sandbox";
        if (args.repos !== undefined) kiroMeta.repos = args.repos;
      }
      const result = (await host.call("session/new", {
        cwd,
        ...(additional.length > 0 ? { additionalDirectories: additional } : {}),
        // Never caller-supplied: a stdio MCP server definition is an arbitrary command (Requirement 6.4).
        mcpServers: [],
        ...(Object.keys(kiroMeta).length > 0 ? { _meta: { kiro: kiroMeta } } : {}),
      })) as Record<string, unknown>;
      const id = typeof result?.sessionId === "string" ? result.sessionId : null;
      if (id === null) throw new ToolError("OUTPUT_PARSE_FAILED", "session/new returned no sessionId");
      const session = sessions.attach(id, result, {
        cwd,
        additionalDirectories: additional,
        source: cloud ? "remote" : "local",
        executionTarget: cloud ? "cloud-sandbox" : "local",
      });
      const warnings: string[] = [];
      if (args.title !== undefined) {
        try {
          await host.call("_kiro/session/rename", { sessionId: id, title: args.title });
          session.title = args.title;
        } catch (err) {
          warnings.push(`title not set: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const checks: [string, string | undefined, unknown][] = [
        ["mode", args.mode, session.currentModeId ?? currentValue(session, "mode")],
        ["model", args.model, currentValue(session, "model")],
        ["effort", args.effort, currentValue(session, "effortLevel")],
      ];
      for (const [what, wanted, actual] of checks) {
        if (wanted !== undefined && actual !== wanted) {
          warnings.push(`Kiro did not apply ${what} ${JSON.stringify(wanted)}; current value is ${JSON.stringify(actual ?? null)}`);
        }
      }
      await waitForCatalog(session);
      return {
        ...sessionSummary(session),
        title: session.title ?? null,
        execution_target: session.executionTarget,
        warnings,
      };
    },
  );

  defineTool(
    server,
    "kiro_session_close",
    {
      title: "Close a Kiro session",
      description:
        "Close an attached session (session/close), like /quit: cancels its running turn, rejects its pending permissions, and returns the final cursor. " +
        "The session stays in Kiro's store (use kiro_session_load to resume it), and its event feed stays readable for an hour so streams can drain.",
      input: z.object({ session_id: sessionId }).strict(),
      output: z.object({ session_id: z.string(), closed: z.boolean(), final_cursor: z.number() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const session = sessions.require(args.session_id);
      await closeSession(core, session);
      return { session_id: session.sessionId, closed: true, final_cursor: session.feed.latestSeq };
    },
  );

  defineTool(
    server,
    "kiro_session_delete",
    {
      title: "Delete a Kiro session",
      description:
        "Permanently delete a session from Kiro's store (session/delete), like `kiro-cli chat --delete-session`. Requires confirm: true. " +
        "Closes the session first when it is attached. Local sessions must live inside KIRO_MCP_ROOTS.",
      input: z.object({ session_id: sessionId, confirm: z.boolean().optional() }).strict(),
      output: z.object({ session_id: z.string(), deleted: z.boolean() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      if (args.confirm !== true) throw new ToolError("CONFIRMATION_REQUIRED", "kiro_session_delete needs confirm: true; nothing was deleted");
      const attached = sessions.get(args.session_id);
      if (attached === undefined || attached.closed) {
        await host.ensureStarted();
        const stored = await sessions.findStored(args.session_id);
        if (stored === null) throw new ToolError("SESSION_NOT_FOUND", `Kiro has no session ${args.session_id}`);
        if (stored.source === "local" && (stored.cwd === null || !roots.contains(stored.cwd))) {
          throw new ToolError("PATH_OUTSIDE_ROOTS", "the session's workspace is outside KIRO_MCP_ROOTS; nothing was deleted");
        }
      } else {
        await closeSession(core, attached);
      }
      await host.call("session/delete", { sessionId: args.session_id });
      sessions.forget(args.session_id);
      return { session_id: args.session_id, deleted: true };
    },
  );

  defineTool(
    server,
    "kiro_session_export",
    {
      title: "Export a Kiro session",
      description:
        "Export a session to a file inside KIRO_MCP_ROOTS with _kiro/session/export, like /chat save. Fails with PATH_EXISTS unless overwrite is true. " +
        "Importing an archive is not possible over ACP.",
      input: z
        .object({
          session_id: sessionId,
          path: pathInput("Destination file inside KIRO_MCP_ROOTS (relative paths resolve against the session's cwd)."),
          overwrite: z.boolean().optional(),
        })
        .strict(),
      output: z.object({ session_id: z.string(), path: z.string(), bytes: z.number() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const { session } = await sessions.attachById(args.session_id);
      const path = await roots.resolveForWrite(args.path, session.cwd);
      if (existsSync(path) && args.overwrite !== true) throw new ToolError("PATH_EXISTS", `${path} already exists; pass overwrite: true to replace it`, { path });
      const result = (await host.call("_kiro/session/export", { sessionId: session.sessionId, path })) as { path?: unknown; success?: unknown } | null;
      if (result?.success === false) throw new ToolError("KIRO_REFUSED", "Kiro refused the export", { kiro: result });
      const written = typeof result?.path === "string" ? result.path : path;
      let bytes = 0;
      try {
        bytes = statSync(written).size;
      } catch {
        throw new ToolError("KIRO_ERROR", `Kiro reported an export but ${written} does not exist`);
      }
      return { session_id: session.sessionId, path: written, bytes };
    },
  );
}

/** Cancel, reject, close on the host, and mark closed (Requirement 8.1). */
export async function closeSession(core: Core, session: AttachedSession): Promise<void> {
  for (const hook of core.closeHooks) await hook(session);
  if (!session.detached && core.host.state === "ready") {
    try {
      await core.host.call("session/close", { sessionId: session.sessionId });
    } catch (err) {
      if (!(err instanceof ToolError) || (err.code !== "HOST_EXITED" && err.code !== "UNSUPPORTED_BY_KIRO")) throw err;
    }
  }
  core.sessions.markClosed(session);
}
