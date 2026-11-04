import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { NAME_PATTERN } from "../argv.js";
import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import { defineTool } from "./define.js";
import { contextUsageView, json, pathInput, sessionId } from "./schemas.js";
import { contextUsageOf } from "./views.js";

/** Call an extension method; Kiro's `success: false` becomes KIRO_REFUSED (Requirement 19.4, 20.5). */
async function callKiro(core: Core, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  let result: unknown;
  try {
    result = await core.host.call(method, params);
  } catch (err) {
    if (err instanceof ToolError && err.code === "KIRO_ERROR") {
      const kiro = err.details.kiro as { message?: string; errorType?: string } | undefined;
      if (/access|trust|denied|disabled|forbidden|permission/i.test(`${kiro?.errorType ?? ""} ${kiro?.message ?? ""}`)) {
        throw new ToolError("KIRO_REFUSED", kiro?.message ?? err.message, { kiro });
      }
    }
    throw err;
  }
  const r = (typeof result === "object" && result !== null ? result : { value: result }) as Record<string, unknown>;
  if (r.success === false) throw new ToolError("KIRO_REFUSED", typeof r.message === "string" ? r.message : `Kiro refused ${method}`, { kiro: r });
  return r;
}

const kiroResult = z.object({ success: z.boolean().nullable(), message: z.string().nullable(), data: json });
const view = (r: Record<string, unknown>) => ({
  success: typeof r.success === "boolean" ? r.success : null,
  message: typeof r.message === "string" ? r.message : null,
  data: "data" in r ? r.data : r,
});

export function registerExtensionTools(server: McpServer, core: Core): void {
  const { sessions, turns, roots } = core;
  const attached = async (id: string) => (await sessions.attachById(id)).session;

  defineTool(
    server,
    "kiro_session_compact",
    {
      title: "Compact a Kiro session",
      description: "Compact an idle session's context with _kiro/session/compact, like /compact, and return the context usage reported afterwards. Fails with TURN_ACTIVE while a turn runs.",
      input: z.object({ session_id: sessionId }).strict(),
      output: z.object({ session_id: z.string(), context_usage: contextUsageView, kiro: json }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const session = await attached(args.session_id);
      if (turns.activeTurn(session.sessionId) !== undefined) throw new ToolError("TURN_ACTIVE", "compaction needs an idle session; wait for the turn or cancel it");
      const before = session.feed.latestSeq;
      const result = await callKiro(core, "_kiro/session/compact", { sessionId: session.sessionId });
      const deadline = Date.now() + 500;
      while (Date.now() < deadline && !session.feed.read(before, 100).events.some((e) => e.type === "state" && e.kind === "context_usage")) {
        await new Promise((r) => setTimeout(r, 10));
      }
      return { session_id: session.sessionId, context_usage: contextUsageOf(session), kiro: result };
    },
  );

  defineTool(
    server,
    "kiro_memory",
    {
      title: "Kiro memories",
      description:
        "List, read, create, update, or delete Kiro memories (_kiro/memory/*), like /memories, and read the memory sync status. Delete needs confirm: true. " +
        "Kiro refuses writes in untrusted workspaces or below the configured memory access level (KIRO_REFUSED with Kiro's message).",
      input: z
        .object({
          action: z.enum(["list", "get", "create", "update", "delete", "sync_status"]),
          session_id: sessionId,
          memory_id: z.string().min(1).max(200).optional(),
          content: z.string().min(1).max(20_000).optional(),
          confirm: z.boolean().optional(),
        })
        .strict(),
      output: z.object({ action: z.string(), result: json }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const session = await attached(args.session_id);
      const sid = session.sessionId;
      const need = (v: string | undefined, what: string) => {
        if (v === undefined) throw new ToolError("VALUE_NOT_ADVERTISED", `action ${args.action} needs ${what}`);
        return v;
      };
      switch (args.action) {
        case "list":
          return { action: args.action, result: await callKiro(core, "_kiro/memory/list", { sessionId: sid }) };
        case "get":
          return { action: args.action, result: await callKiro(core, "_kiro/memory/get", { sessionId: sid, memoryId: need(args.memory_id, "memory_id") }) };
        case "create":
          return { action: args.action, result: await callKiro(core, "_kiro/memory/create", { sessionId: sid, content: need(args.content, "content") }) };
        case "update":
          return {
            action: args.action,
            result: await callKiro(core, "_kiro/memory/update", { sessionId: sid, memoryId: need(args.memory_id, "memory_id"), content: need(args.content, "content") }),
          };
        case "delete":
          if (args.confirm !== true) throw new ToolError("CONFIRMATION_REQUIRED", "deleting a memory needs confirm: true; nothing was deleted");
          return { action: args.action, result: await callKiro(core, "_kiro/memory/delete", { sessionId: sid, memoryId: need(args.memory_id, "memory_id") }) };
        case "sync_status":
          return { action: args.action, result: sessions.memorySyncStatus ?? (await callKiro(core, "_kiro/memory/getSyncStatus", { sessionId: sid })) };
      }
    },
  );

  defineTool(
    server,
    "kiro_knowledge",
    {
      title: "Kiro knowledge bases",
      description:
        "Kiro knowledge bases (_kiro/knowledge), like /knowledge: show, add (a path inside KIRO_MCP_ROOTS), remove, search, update, clear, status, cancel. " +
        "Returns Kiro's success, message, and data; success false is KIRO_REFUSED.",
      input: z
        .object({
          session_id: sessionId,
          subcommand: z.enum(["show", "add", "remove", "search", "update", "clear", "status", "cancel"]),
          path: pathInput("For add and update: a file or directory inside KIRO_MCP_ROOTS.").optional(),
          name: z.string().min(1).max(200).optional(),
          query: z.string().min(1).max(2_000).optional(),
          context_id: z.string().min(1).max(200).optional(),
          include: z.array(z.string().min(1).max(200)).max(50).optional(),
          exclude: z.array(z.string().min(1).max(200)).max(50).optional(),
        })
        .strict(),
      output: kiroResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const session = await attached(args.session_id);
      const params: Record<string, unknown> = { sessionId: session.sessionId, subcommand: args.subcommand };
      if (args.subcommand === "add" && args.path === undefined) throw new ToolError("VALUE_NOT_ADVERTISED", "add needs a path inside KIRO_MCP_ROOTS");
      if (args.path !== undefined) params.path = await roots.resolveInside(args.path, session.cwd);
      if (args.name !== undefined) params.name = args.name;
      if (args.query !== undefined) params.query = args.query;
      if (args.context_id !== undefined) params.contextId = args.context_id;
      if (args.include !== undefined) params.include = args.include;
      if (args.exclude !== undefined) params.exclude = args.exclude;
      return view(await callKiro(core, "_kiro/knowledge", params));
    },
  );

  defineTool(
    server,
    "kiro_code_intelligence",
    {
      title: "Kiro code intelligence",
      description: "LSP-backed code intelligence (_kiro/codeIntelligence), like /code: init, status, overview, logs. Kiro's success false (for example when it is not enabled) is KIRO_REFUSED.",
      input: z.object({ session_id: sessionId, subcommand: z.enum(["init", "status", "overview", "logs"]), force: z.boolean().optional() }).strict(),
      output: kiroResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const session = await attached(args.session_id);
      return view(await callKiro(core, "_kiro/codeIntelligence", { sessionId: session.sessionId, subcommand: args.subcommand, ...(args.force !== undefined ? { force: args.force } : {}) }));
    },
  );

  defineTool(
    server,
    "kiro_workflow",
    {
      title: "Kiro workflows",
      description:
        "Kiro workflows (_kiro/workflow/*), like /workflow: list_recipes, list runs, invoke a recipe with inputs (checked against the recipe's declared input names), " +
        "and inspect, pause, resume, cancel, retry (optionally from node_id), or delete a run. Lifecycle notifications appear as workflow events in kiro_events. " +
        "For /goal, invoke the goal or iterate recipe when one is listed; otherwise prompt in autonomous mode with explicit acceptance criteria.",
      input: z
        .object({
          action: z.enum(["list_recipes", "list", "invoke", "inspect", "pause", "resume", "cancel", "retry", "delete"]),
          session_id: sessionId,
          recipe: z.string().regex(NAME_PATTERN).optional(),
          inputs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/), z.union([z.string().max(20_000), z.number(), z.boolean()])).optional(),
          workflow_id: z.string().min(1).max(200).optional(),
          node_id: z.string().min(1).max(200).optional(),
        })
        .strict(),
      output: z.object({ action: z.string(), workflow_id: z.string().nullable(), result: json }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const session = await attached(args.session_id);
      const sid = session.sessionId;
      if (args.action === "list_recipes") return { action: args.action, workflow_id: null, result: await callKiro(core, "_kiro/workflow/listRecipes", { sessionId: sid }) };
      if (args.action === "list") return { action: args.action, workflow_id: null, result: await callKiro(core, "_kiro/workflow/list", { sessionId: sid }) };
      if (args.action === "invoke") {
        if (args.recipe === undefined) throw new ToolError("VALUE_NOT_ADVERTISED", "invoke needs recipe");
        const listed = await callKiro(core, "_kiro/workflow/listRecipes", { sessionId: sid });
        const recipes = Array.isArray(listed.recipes) ? (listed.recipes as Record<string, unknown>[]) : [];
        const recipe = recipes.find((r) => r.name === args.recipe);
        if (recipe === undefined) throw new ToolError("VALUE_NOT_ADVERTISED", `recipe ${JSON.stringify(args.recipe)} is not listed`, { allowed: recipes.map((r) => r.name) });
        const declared = Object.keys((recipe.inputs ?? {}) as Record<string, unknown>);
        const unknown = Object.keys(args.inputs ?? {}).filter((k) => !declared.includes(k));
        if (unknown.length > 0) throw new ToolError("VALUE_NOT_ADVERTISED", `recipe ${args.recipe} does not declare inputs ${unknown.join(", ")}`, { allowed: declared });
        await core.usage.guard();
        const result = await callKiro(core, "_kiro/workflow/invoke", { sessionId: sid, recipeName: args.recipe, inputs: args.inputs ?? {} });
        const workflowId = typeof result.workflowId === "string" ? result.workflowId : null;
        return { action: args.action, workflow_id: workflowId, result };
      }
      if (args.workflow_id === undefined) throw new ToolError("VALUE_NOT_ADVERTISED", `${args.action} needs workflow_id`);
      const result = await callKiro(core, `_kiro/workflow/${args.action}`, {
        sessionId: sid,
        workflowId: args.workflow_id,
        ...(args.action === "retry" && args.node_id !== undefined ? { nodeId: args.node_id } : {}),
      });
      return { action: args.action, workflow_id: args.workflow_id, result };
    },
  );

  defineTool(
    server,
    "kiro_cloud_sources",
    {
      title: "Kiro cloud source providers",
      description:
        "Connected source providers for cloud sessions (_kiro/sourceProviders/list), or, with provider (for example GITHUB), that provider's repositories " +
        "(_kiro/sourceProviders/listResources). Use the owner/name values as repos for kiro_session_new with execution_target cloud.",
      input: z.object({ session_id: sessionId, provider: z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/).optional() }).strict(),
      output: z.object({ providers: z.array(json).nullable(), resources: z.array(json).nullable() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const session = await attached(args.session_id);
      if (args.provider === undefined) {
        const r = await callKiro(core, "_kiro/sourceProviders/list", { sessionId: session.sessionId });
        return { providers: Array.isArray(r.providers) ? r.providers : [], resources: null };
      }
      const r = await callKiro(core, "_kiro/sourceProviders/listResources", { sessionId: session.sessionId, providerType: args.provider });
      return { providers: null, resources: Array.isArray(r.resources) ? r.resources : [] };
    },
  );
}
