import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { LIMITS } from "../config.js";
import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import type { AttachedSession } from "../sessions.js";
import { defineTool } from "./define.js";
import { commandsView, configOptionView, contextUsageView, modeView, name, pathInput } from "./schemas.js";
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

export function registerSessionTools(server: McpServer, core: Core): void {
  const { roots, host, sessions } = core;

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
}
