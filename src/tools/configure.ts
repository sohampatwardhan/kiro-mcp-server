import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { subcommandArgv } from "../argv.js";
import { runChecked } from "../cli.js";
import { LIMITS } from "../config.js";
import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import type { AttachedSession, SnapshotKind } from "../sessions.js";
import { defineTool } from "./define.js";
import { configOptionView, json, name, sessionId } from "./schemas.js";
import { commandsOf, configOptionsOf, contextUsageOf, modesOf } from "./views.js";

export const STATE_KINDS = [
  "mcp",
  "tools",
  "steering",
  "skills",
  "powers",
  "governance",
  "agent_errors",
  "commands",
  "modes",
  "config",
  "context",
  "configuration",
  "models",
] as const;
type StateKind = (typeof STATE_KINDS)[number];

/** Fields left out unless verbose, then truncated at the snapshot cap (Requirement 15.4). */
const LARGE_KEYS = new Set(["inputSchema", "content", "outputSchema"]);

function truncateLarge(value: unknown, verbose: boolean, depth = 0, dropDescriptions = false): unknown {
  if (Array.isArray(value)) return value.map((v) => truncateLarge(v, verbose, depth + 1, dropDescriptions));
  if (typeof value === "string") return value.length > LIMITS.snapshotFieldChars ? `${value.slice(0, LIMITS.snapshotFieldChars)}…` : value;
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "_meta" && !verbose) continue;
    if (LARGE_KEYS.has(k) || (dropDescriptions && k === "description")) {
      if (!verbose) continue;
      const text = typeof v === "string" ? v : JSON.stringify(v);
      out[k] = text.length > LIMITS.snapshotFieldChars ? { truncated: true, preview: text.slice(0, LIMITS.snapshotFieldChars) } : v;
      continue;
    }
    out[k] = truncateLarge(v, verbose, depth + 1, dropDescriptions);
  }
  return out;
}

function mcpView(data: unknown, verbose: boolean): unknown {
  const servers = (data as { servers?: unknown[] } | null)?.servers ?? [];
  return {
    servers: servers.map((raw) => {
      const s = (raw ?? {}) as Record<string, unknown>;
      const kiro = ((s._meta as Record<string, unknown> | undefined)?.kiro ?? {}) as Record<string, unknown>;
      const tools = Array.isArray(s.tools) ? (s.tools as Record<string, unknown>[]) : [];
      return {
        name: s.name ?? null,
        status: s.status ?? null,
        ...(s.error !== undefined ? { error: truncateLarge(s.error, true) } : {}),
        authorization_failed: kiro.authorizationFailed === true || s.authorizationFailed === true,
        tool_names: tools.map((t) => t.name).filter((n) => typeof n === "string"),
        ...(verbose ? { tools: truncateLarge(tools, true) } : {}),
      };
    }),
  };
}

export function registerConfigureTools(server: McpServer, core: Core): void {
  const { host, sessions, config, roots } = core;

  defineTool(
    server,
    "kiro_session_configure",
    {
      title: "Configure a Kiro session",
      description:
        "Switch an attached session's agent mode (session/set_mode: vibe, plan, spec, quick-spec, bug-fix, autonomous, or a custom agent), " +
        "model and effort (session/set_config_option `model` and `effortLevel`), or any other advertised option such as autopilot or memoryReflection, " +
        "like /model, /effort, /agent, and /plan. Every value is checked against what Kiro last advertised for the session; on VALUE_NOT_ADVERTISED nothing changes. " +
        "Returns the options as Kiro reports them after the change. `title` renames the session. For /spec run, select mode `spec` and prompt the agent to run the named spec.",
      input: z
        .object({
          session_id: sessionId,
          mode: name("Agent mode id.").optional(),
          model: name("Model id.").optional(),
          effort: name("Effort level.").optional(),
          options: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/), z.string().max(200)).optional().describe("Config option id to value."),
          title: z.string().min(1).max(200).optional(),
        })
        .strict(),
      output: z.object({
        session_id: z.string(),
        title: z.string().nullable(),
        current_mode: z.string().nullable(),
        config_options: z.array(configOptionView),
        changed: z.array(z.string()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const { session } = await sessions.attachById(args.session_id);
      const sets: [string, string][] = [];
      if (args.model !== undefined) sets.push(["model", args.model]);
      if (args.effort !== undefined) sets.push(["effortLevel", args.effort]);
      for (const [id, value] of Object.entries(args.options ?? {})) sets.push([id, value]);
      // Check everything first: a refused value changes nothing (Requirement 13.4).
      if (args.mode !== undefined && !session.modeIds.includes(args.mode)) {
        throw notAdvertised(`mode ${JSON.stringify(args.mode)}`, session.modeIds);
      }
      for (const [id, value] of sets) {
        if (id === "effortLevel" && args.model !== undefined && !session.configOptions.some((o) => o.id === id)) continue;
        checkOption(session, id, value);
      }
      const changed: string[] = [];
      if (args.mode !== undefined) {
        await host.call("session/set_mode", { sessionId: session.sessionId, modeId: args.mode });
        await settleUntil(() => session.currentModeId === args.mode);
        session.currentModeId = args.mode;
        changed.push("mode");
      }
      for (const [id, value] of sets) {
        if (id === "effortLevel" && args.model !== undefined) checkOption(session, id, value);
        const result = (await host.call("session/set_config_option", { sessionId: session.sessionId, configId: id, value })) as { configOptions?: unknown } | null;
        if (Array.isArray(result?.configOptions)) {
          session.configOptions = result.configOptions as typeof session.configOptions;
          session.syncModeFromConfig();
        } else {
          await settleUntil(() => session.configOptions.find((o) => o.id === id)?.currentValue === value);
        }
        changed.push(id);
      }
      if (args.title !== undefined) {
        await host.call("_kiro/session/rename", { sessionId: session.sessionId, title: args.title });
        session.title = args.title;
        changed.push("title");
      }
      return {
        session_id: session.sessionId,
        title: session.title ?? null,
        current_mode: session.currentModeId ?? null,
        config_options: configOptionsOf(session),
        changed,
      };
    },
  );

  defineTool(
    server,
    "kiro_session_state",
    {
      title: "Kiro session state",
      description:
        "Snapshots of what a session will use: MCP servers (status, failed authorization, tool names), tool tags, steering documents, skills, powers, " +
        "governance flags, agent config errors, the command catalog, modes, config options, context usage (plus _kiro/session/context), and the " +
        "/config panel including hooks (_kiro/configuration/getState). A snapshot that has not arrived yet comes back with received: false. " +
        "Large fields (tool schemas, steering content, skill descriptions) are left out unless verbose. `models` works without a session " +
        "(`kiro-cli chat --list-models`).",
      input: z
        .object({
          session_id: sessionId.optional(),
          include: z.array(z.enum(STATE_KINDS)).min(1).max(STATE_KINDS.length),
          verbose: z.boolean().optional(),
        })
        .strict(),
      output: z.object({
        session_id: z.string().nullable(),
        state: z.record(z.string(), z.object({ received: z.boolean(), received_at: z.string().nullable(), data: json })),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const verbose = args.verbose === true;
      let session: AttachedSession | null = null;
      if (args.session_id !== undefined) session = (await sessions.attachById(args.session_id)).session;
      const state: Record<string, { received: boolean; received_at: string | null; data: unknown }> = {};
      for (const kind of new Set(args.include) as Set<StateKind>) {
        if (kind === "models") {
          state.models = await models(session);
          continue;
        }
        if (session === null) throw new ToolError("SESSION_NOT_FOUND", `include ${kind} needs session_id`);
        state[kind] = await sessionKind(session, kind, verbose);
      }
      return { session_id: session?.sessionId ?? null, state };
    },
  );

  async function models(session: AttachedSession | null) {
    if (session !== null) {
      const option = session.configOptions.find((o) => o.id === "model");
      return {
        received: option !== undefined,
        received_at: null,
        data: option === undefined ? null : { current: option.currentValue ?? null, models: (option.options ?? []).map((o) => ({ id: o.value, name: o.name ?? null })) },
      };
    }
    const result = await runChecked(config.kiroBin, subcommandArgv({ cmd: "list_models" }), { timeoutMs: config.cliTimeoutMs, cwd: roots.primary });
    try {
      return { received: true, received_at: new Date().toISOString(), data: JSON.parse(result.stdout) as unknown };
    } catch {
      throw new ToolError("OUTPUT_PARSE_FAILED", "kiro-cli chat --list-models --format json did not print JSON");
    }
  }

  async function sessionKind(session: AttachedSession, kind: Exclude<StateKind, "models">, verbose: boolean) {
    const now = new Date().toISOString();
    switch (kind) {
      case "commands":
        return {
          received: session.commands.length > 0,
          received_at: null,
          data: {
            ...commandsOf(session),
            commands: session.commands.map((c) => ({ name: c.name, type: c._meta?.kiro?.type ?? null, ...(verbose ? { description: c.description ?? null, hint: c.input?.hint ?? null } : {}) })),
          },
        };
      case "modes":
        return { received: session.modes.length > 0, received_at: null, data: { current: session.currentModeId ?? null, modes: modesOf(session) } };
      case "config":
        return { received: session.configOptions.length > 0, received_at: null, data: configOptionsOf(session) };
      case "context": {
        let live: unknown = null;
        if (host.supports("_kiro/session/context")) {
          try {
            live = await host.call("_kiro/session/context", { sessionId: session.sessionId });
          } catch (err) {
            live = { error: err instanceof ToolError ? err.code : String(err) };
          }
        }
        return {
          received: session.contextUsage !== null,
          received_at: null,
          data: { usage: contextUsageOf(session), breakdown: truncateLarge(session.contextUsage?.breakdown ?? null, verbose), kiro: truncateLarge(live, verbose) },
        };
      }
      case "configuration": {
        const result = await host.call("_kiro/configuration/getState", { observer: "session", sessionId: session.sessionId });
        return { received: true, received_at: now, data: truncateLarge(result, verbose) };
      }
      default: {
        const snapshot = session.snapshots.get(kind as SnapshotKind);
        if (snapshot === undefined) return { received: false, received_at: null, data: null };
        const data = kind === "mcp" ? mcpView(snapshot.data, verbose) : truncateLarge(snapshot.data, verbose, 0, kind === "skills");
        return { received: true, received_at: snapshot.receivedAt, data };
      }
    }
  }
}

function checkOption(session: AttachedSession, id: string, value: string): void {
  const option = session.configOptions.find((o) => o.id === id);
  if (option === undefined) throw notAdvertised(`config option ${JSON.stringify(id)}`, session.configOptions.map((o) => o.id));
  const values = (option.options ?? []).map((o) => o.value);
  if (!values.includes(value)) throw notAdvertised(`${id} value ${JSON.stringify(value)}`, values);
}

function notAdvertised(what: string, allowed: string[]): ToolError {
  return new ToolError("VALUE_NOT_ADVERTISED", `${what} is not advertised for this session; nothing was changed`, { allowed });
}

/** Wait briefly for a notification-driven state change. */
async function settleUntil(done: () => boolean, ms = 400): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}
