import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { MCP_SERVER_NAME_PATTERN, NAME_PATTERN, SETTING_KEY_PATTERN, subcommandArgv, type SubcommandSpec } from "../argv.js";
import { cliDetails, runChecked, runCli } from "../cli.js";
import { LIMITS } from "../config.js";
import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import { cleanTerminalText, parseKeyValues, parseMcpList, parseSettings, tail } from "../parse.js";
import type { AttachedSession } from "../sessions.js";
import { defineTool } from "./define.js";
import { json, pathInput, sessionId } from "./schemas.js";
import { modesOf } from "./views.js";

const APPLY_NOTE = "Running sessions pick up MCP server changes by hot reload; other changes apply to new sessions.";

/** Keys a calling agent may never set or delete (Requirement 23.7). */
export function settingWithheld(key: string): boolean {
  return /^chat\.agentEngine/i.test(key) || /^acp\./i.test(key) || /token|secret|apikey|api_key|password/i.test(key) || ["open", "list", "help"].includes(key);
}

/** HTTPS anywhere, or plain HTTP only to this machine (Requirement 23.6). */
export function allowedMcpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

const writeResult = z.object({ action: z.string(), ok: z.boolean(), output: z.string(), note: z.string() });

export function registerConfigTools(server: McpServer, core: Core): void {
  const { config, roots, sessions } = core;

  const gate = (what: string) => {
    if (!config.allowConfigWrites) throw new ToolError("CONFIG_WRITES_DISABLED", `${what} changes Kiro configuration and needs the operator's KIRO_MCP_ALLOW_CONFIG_WRITES=1`);
  };
  const run = (spec: SubcommandSpec, cwd: string = roots.primary) => runChecked(config.kiroBin, subcommandArgv(spec), { timeoutMs: config.cliTimeoutMs, cwd });
  const write = async (action: string, spec: SubcommandSpec, cwd?: string) => {
    const result = await run(spec, cwd);
    return { action, ok: true, output: tail(cleanTerminalText(result.stdout + result.stderr).trim(), LIMITS.outputTailChars), note: APPLY_NOTE };
  };
  const anySession = async (id: string | undefined): Promise<AttachedSession> => {
    if (id !== undefined) return (await sessions.attachById(id)).session;
    const first = sessions.all().find((s) => !s.closed);
    if (first === undefined) throw new ToolError("SESSION_NOT_FOUND", "pass session_id (agents and powers come from a session's snapshot)");
    return core.sessions.ensureAttached(first.sessionId);
  };

  defineTool(
    server,
    "kiro_agents",
    {
      title: "Kiro custom agents",
      description:
        "Kiro custom agents: `list` (the custom agents a session advertises as modes, with their source, plus agent config errors) and `validate` " +
        "(`kiro-cli agent validate --path`). The writes `create`, `set_default`, and `upgrade` need KIRO_MCP_ALLOW_CONFIG_WRITES. Editing an agent " +
        "opens $EDITOR and is not available; `agent migrate` is withheld as potentially destructive.",
      input: z
        .object({
          action: z.enum(["list", "validate", "create", "set_default", "upgrade"]),
          session_id: sessionId.optional(),
          path: pathInput("Agent config file inside KIRO_MCP_ROOTS (validate).").optional(),
          name: z.string().regex(NAME_PATTERN).optional(),
          from: z.string().regex(NAME_PATTERN).optional(),
          directory: pathInput("Directory inside KIRO_MCP_ROOTS (create, upgrade).").optional(),
          dry_run: z.boolean().optional(),
        })
        .strict(),
      output: z.object({ action: z.string(), agents: z.array(json).nullable(), errors: z.array(json).nullable(), valid: z.boolean().nullable(), output: z.string().nullable(), note: z.string().nullable() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const empty = { agents: null, errors: null, valid: null, output: null, note: null };
      switch (args.action) {
        case "list": {
          const session = await anySession(args.session_id);
          const errors = (session.snapshots.get("agent_errors")?.data as unknown[] | undefined) ?? [];
          return { ...empty, action: args.action, agents: modesOf(session).filter((m) => m.custom), errors };
        }
        case "validate": {
          if (args.path === undefined) throw new ToolError("VALUE_NOT_ADVERTISED", "validate needs path");
          const path = await roots.resolveInside(args.path);
          const result = await runCli(config.kiroBin, subcommandArgv({ cmd: "agent_validate", path }), { timeoutMs: config.cliTimeoutMs, cwd: roots.primary });
          if (result.timedOut) throw new ToolError("TIMEOUT", "kiro-cli agent validate timed out", { cli: cliDetails(result) });
          return { ...empty, action: args.action, valid: result.exitCode === 0, output: tail(cleanTerminalText(result.stdout + result.stderr).trim(), LIMITS.outputTailChars) };
        }
        case "create": {
          gate("kiro_agents create");
          if (args.name === undefined) throw new ToolError("VALUE_NOT_ADVERTISED", "create needs name");
          const directory = args.directory !== undefined ? await roots.resolveInside(args.directory) : undefined;
          const r = await write(args.action, { cmd: "agent_create", name: args.name, ...(args.from !== undefined ? { from: args.from } : {}), ...(directory !== undefined ? { directory } : {}) });
          return { ...empty, action: r.action, output: r.output, note: r.note };
        }
        case "set_default": {
          gate("kiro_agents set_default");
          if (args.name === undefined) throw new ToolError("VALUE_NOT_ADVERTISED", "set_default needs name");
          const r = await write(args.action, { cmd: "agent_set_default", name: args.name });
          return { ...empty, action: r.action, output: r.output, note: r.note };
        }
        case "upgrade": {
          gate("kiro_agents upgrade");
          if (args.directory === undefined) throw new ToolError("VALUE_NOT_ADVERTISED", "upgrade needs directory");
          const directory = await roots.resolveInside(args.directory);
          const r = await write(args.action, { cmd: "agent_upgrade", directory, ...(args.dry_run === true ? { dryRun: true } : {}) });
          return { ...empty, action: r.action, output: r.output, note: r.note };
        }
      }
    },
  );

  defineTool(
    server,
    "kiro_mcp_config",
    {
      title: "Kiro MCP server configuration",
      description:
        "Read Kiro's MCP configuration: `list` (`kiro-cli mcp list`, optional scope) and `status` (`kiro-cli mcp status --name`), parsed from text with the raw " +
        "text alongside. `add` (HTTP servers only: an https URL, or http to localhost) and `remove` need KIRO_MCP_ALLOW_CONFIG_WRITES. Stdio (command) servers " +
        "and `mcp import` are withheld because they run arbitrary commands. For live server status in a session, use kiro_session_state include mcp.",
      input: z
        .object({
          action: z.enum(["list", "status", "add", "remove"]),
          cwd: pathInput("Workspace directory inside KIRO_MCP_ROOTS for workspace scope (default: the first root).").optional(),
          scope: z.enum(["default", "workspace", "global"]).optional(),
          name: z.string().regex(MCP_SERVER_NAME_PATTERN).optional(),
          url: z.string().min(1).max(2_000).optional(),
          command: z.string().max(4_096).optional().describe("Not accepted: stdio servers are withheld."),
          agent: z.string().regex(NAME_PATTERN).optional(),
          timeout_ms: z.number().int().min(1).max(600_000).optional(),
          disabled: z.boolean().optional(),
          force: z.boolean().optional(),
        })
        .strict(),
      output: z.object({ action: z.string(), servers: z.array(json).nullable(), status: z.record(z.string(), z.string()).nullable(), raw: z.string(), note: z.string().nullable() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const cwd = args.cwd !== undefined ? await roots.resolveInside(args.cwd) : roots.primary;
      if (args.action === "list") {
        const r = await run({ cmd: "mcp_list", ...(args.scope !== undefined ? { scope: args.scope } : {}) }, cwd);
        return { action: args.action, servers: parseMcpList(r.stdout), status: null, raw: tail(cleanTerminalText(r.stdout), LIMITS.outputTailChars), note: null };
      }
      if (args.name === undefined) throw new ToolError("VALUE_NOT_ADVERTISED", `${args.action} needs name`);
      if (args.action === "status") {
        const r = await run({ cmd: "mcp_status", name: args.name }, cwd);
        return { action: args.action, servers: null, status: parseKeyValues(r.stdout), raw: tail(cleanTerminalText(r.stdout), LIMITS.outputTailChars), note: null };
      }
      if (args.action === "add") {
        if (args.command !== undefined) throw new ToolError("STDIO_SERVER_WITHHELD", "stdio MCP servers run an arbitrary command and cannot be added through this server; add an HTTP server with url");
        gate("kiro_mcp_config add");
        if (args.url === undefined || !allowedMcpUrl(args.url)) throw new ToolError("VALUE_NOT_ADVERTISED", "add needs url: https://..., or http:// to localhost, without credentials");
        const r = await write(
          args.action,
          {
            cmd: "mcp_add",
            name: args.name,
            url: args.url,
            ...(args.scope !== undefined ? { scope: args.scope } : {}),
            ...(args.agent !== undefined ? { agent: args.agent } : {}),
            ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
            ...(args.disabled === true ? { disabled: true } : {}),
            ...(args.force === true ? { force: true } : {}),
          },
          cwd,
        );
        return { action: r.action, servers: null, status: null, raw: r.output, note: r.note };
      }
      gate("kiro_mcp_config remove");
      const r = await write(args.action, { cmd: "mcp_remove", name: args.name, ...(args.scope !== undefined ? { scope: args.scope } : {}), ...(args.agent !== undefined ? { agent: args.agent } : {}) }, cwd);
      return { action: r.action, servers: null, status: null, raw: r.output, note: r.note };
    },
  );

  defineTool(
    server,
    "kiro_settings",
    {
      title: "Kiro settings",
      description:
        "Read Kiro settings (`kiro-cli settings list --format json`, with all: true for every available setting); `get` returns only the given keys. " +
        "`set` and `delete` need KIRO_MCP_ALLOW_CONFIG_WRITES; keys under chat.agentEngine and acp.*, and any key naming a token, secret, API key, or " +
        "password, are withheld. Use set chat.defaultModel for /model set-current-as-default.",
      input: z
        .object({
          action: z.enum(["list", "get", "set", "delete"]),
          keys: z.array(z.string().regex(SETTING_KEY_PATTERN)).min(1).max(100).optional(),
          all: z.boolean().optional(),
          key: z.string().regex(SETTING_KEY_PATTERN).optional(),
          value: z.string().max(10_000).optional(),
          workspace: z.boolean().optional(),
          cwd: pathInput("Workspace directory inside KIRO_MCP_ROOTS for workspace settings (default: the first root).").optional(),
        })
        .strict(),
      output: z.object({ action: z.string(), settings: z.record(z.string(), json).nullable(), output: z.string().nullable(), note: z.string().nullable() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const cwd = args.cwd !== undefined ? await roots.resolveInside(args.cwd) : roots.primary;
      if (args.action === "list" || args.action === "get") {
        const r = await run({ cmd: "settings_list", ...(args.all === true || args.action === "get" ? { all: true } : {}) }, cwd);
        let settings: Record<string, unknown>;
        try {
          settings = parseSettings(r.stdout);
        } catch {
          throw new ToolError("OUTPUT_PARSE_FAILED", "kiro-cli settings list --format json did not print a JSON object");
        }
        for (const key of Object.keys(settings)) if (/token|secret|apikey|api_key|password/i.test(key)) settings[key] = "[withheld]";
        if (args.action === "get") {
          if (args.keys === undefined) throw new ToolError("VALUE_NOT_ADVERTISED", "get needs keys");
          settings = Object.fromEntries(args.keys.map((k) => [k, k in settings ? settings[k] : null]));
        }
        return { action: args.action, settings, output: null, note: null };
      }
      if (args.key === undefined) throw new ToolError("VALUE_NOT_ADVERTISED", `${args.action} needs key`);
      if (settingWithheld(args.key)) throw new ToolError("SETTING_WITHHELD", `setting ${args.key} cannot be changed through this server`);
      gate(`kiro_settings ${args.action}`);
      if (args.action === "set") {
        if (args.value === undefined) throw new ToolError("VALUE_NOT_ADVERTISED", "set needs value");
        const r = await write(args.action, { cmd: "settings_set", key: args.key, value: args.value, ...(args.workspace === true ? { workspace: true } : {}) }, cwd);
        return { action: r.action, settings: null, output: r.output, note: r.note };
      }
      const r = await write(args.action, { cmd: "settings_delete", key: args.key, ...(args.workspace === true ? { workspace: true } : {}) }, cwd);
      return { action: r.action, settings: null, output: r.output, note: r.note };
    },
  );

  defineTool(
    server,
    "kiro_powers",
    {
      title: "Kiro powers",
      description:
        "Kiro powers: `list` returns a session's powers snapshot (like /powers). `install` (a catalog name, or a local path inside KIRO_MCP_ROOTS) and " +
        "`uninstall` run `kiro-cli powers` and need KIRO_MCP_ALLOW_CONFIG_WRITES.",
      input: z
        .object({
          action: z.enum(["list", "install", "uninstall"]),
          session_id: sessionId.optional(),
          name_or_path: z.string().min(1).max(4_096).optional(),
        })
        .strict(),
      output: z.object({ action: z.string(), powers: json, output: z.string().nullable(), note: z.string().nullable() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      if (args.action === "list") {
        const session = await anySession(args.session_id);
        const snapshot = session.snapshots.get("powers");
        return { action: args.action, powers: snapshot === undefined ? { received: false } : { received: true, ...(snapshot.data as Record<string, unknown>) }, output: null, note: null };
      }
      if (args.name_or_path === undefined) throw new ToolError("VALUE_NOT_ADVERTISED", `${args.action} needs name_or_path`);
      gate(`kiro_powers ${args.action}`);
      if (args.action === "uninstall") {
        if (!NAME_PATTERN.test(args.name_or_path)) throw new ToolError("VALUE_NOT_ADVERTISED", "uninstall takes a power name");
        const r = await write(args.action, { cmd: "powers_uninstall", name: args.name_or_path });
        return { action: r.action, powers: null, output: r.output, note: r.note };
      }
      const isPath = args.name_or_path.includes("/") || args.name_or_path.startsWith(".");
      if (!isPath && !NAME_PATTERN.test(args.name_or_path)) throw new ToolError("VALUE_NOT_ADVERTISED", "install takes a catalog name or a path inside KIRO_MCP_ROOTS");
      const target = isPath ? await roots.resolveInside(args.name_or_path) : args.name_or_path;
      const r = await write(args.action, { cmd: "powers_install", nameOrPath: target });
      return { action: r.action, powers: null, output: r.output, note: r.note };
    },
  );
}
