/**
 * The only place kiro-cli argv is built. Values are attached as
 * `--flag=value`, and positional values follow `--`, so a value that starts
 * with `-` is never read as a flag (Requirement 24.1). Prompts go on stdin.
 */

/** Modes, commands, models, agents, recipes, and power names. */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
/** Kiro settings keys, such as `chat.defaultModel`. */
export const SETTING_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
/** MCP server names in Kiro's MCP config. */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export type McpScope = "default" | "workspace" | "global";

export type SubcommandSpec =
  | { cmd: "version" }
  | { cmd: "whoami" }
  | { cmd: "profile" }
  | { cmd: "diagnostic" }
  | { cmd: "doctor_all" }
  | { cmd: "list_models" }
  | { cmd: "settings_list"; all?: boolean }
  | { cmd: "settings_set"; key: string; value: string; workspace?: boolean }
  | { cmd: "settings_delete"; key: string; workspace?: boolean }
  | { cmd: "agent_validate"; path: string }
  | { cmd: "agent_create"; name: string; from?: string; directory?: string }
  | { cmd: "agent_set_default"; name: string }
  | { cmd: "agent_upgrade"; directory: string; dryRun?: boolean }
  | { cmd: "mcp_list"; scope?: McpScope }
  | { cmd: "mcp_status"; name: string }
  | {
      cmd: "mcp_add";
      name: string;
      url: string;
      scope?: McpScope;
      agent?: string;
      timeoutMs?: number;
      disabled?: boolean;
      force?: boolean;
    }
  | { cmd: "mcp_remove"; name: string; scope?: McpScope; agent?: string }
  | { cmd: "powers_install"; nameOrPath: string }
  | { cmd: "powers_uninstall"; name: string };

export class ArgvError extends Error {
  override name = "ArgvError";
}

function check(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) throw new ArgvError(`${what} ${JSON.stringify(value)} does not match ${pattern}`);
  return value;
}

/** Fixed argv for each kiro-cli subcommand the server runs. */
export function subcommandArgv(spec: SubcommandSpec): string[] {
  switch (spec.cmd) {
    case "version":
      return ["--version"];
    case "whoami":
      return ["whoami", "--format=json"];
    case "profile":
      return ["profile"];
    case "diagnostic":
      return ["diagnostic", "--format=json"];
    case "doctor_all":
      // Never `doctor` without `--all`: that form may apply fixes (Requirement 2.4).
      return ["doctor", "--all"];
    case "list_models":
      return ["chat", "--list-models", "--format=json"];
    case "settings_list":
      return ["settings", "list", "--format=json", ...(spec.all === true ? ["--all"] : [])];
    case "settings_set":
      check(spec.key, SETTING_KEY_PATTERN, "setting key");
      return ["settings", ...(spec.workspace === true ? ["--workspace"] : []), "--", spec.key, spec.value];
    case "settings_delete":
      check(spec.key, SETTING_KEY_PATTERN, "setting key");
      return ["settings", "--delete", ...(spec.workspace === true ? ["--workspace"] : []), "--", spec.key];
    case "agent_validate":
      return ["agent", "validate", `--path=${spec.path}`];
    case "agent_create":
      check(spec.name, NAME_PATTERN, "agent name");
      if (spec.from !== undefined) check(spec.from, NAME_PATTERN, "agent name");
      return [
        "agent",
        "create",
        `--name=${spec.name}`,
        ...(spec.from !== undefined ? [`--from=${spec.from}`] : []),
        ...(spec.directory !== undefined ? [`--directory=${spec.directory}`] : []),
      ];
    case "agent_set_default":
      check(spec.name, NAME_PATTERN, "agent name");
      return ["agent", "set-default", `--name=${spec.name}`];
    case "agent_upgrade":
      return ["agent", "upgrade", ...(spec.dryRun === true ? ["--dry-run"] : []), "--", spec.directory];
    case "mcp_list":
      return ["mcp", "list", ...(spec.scope !== undefined ? ["--", spec.scope] : [])];
    case "mcp_status":
      check(spec.name, MCP_SERVER_NAME_PATTERN, "MCP server name");
      return ["mcp", "status", `--name=${spec.name}`];
    case "mcp_add":
      check(spec.name, MCP_SERVER_NAME_PATTERN, "MCP server name");
      if (spec.agent !== undefined) check(spec.agent, NAME_PATTERN, "agent name");
      return [
        "mcp",
        "add",
        `--name=${spec.name}`,
        `--url=${spec.url}`,
        ...(spec.scope !== undefined ? [`--scope=${spec.scope}`] : []),
        ...(spec.agent !== undefined ? [`--agent=${spec.agent}`] : []),
        ...(spec.timeoutMs !== undefined ? [`--timeout=${spec.timeoutMs}`] : []),
        ...(spec.disabled === true ? ["--disabled"] : []),
        ...(spec.force === true ? ["--force"] : []),
      ];
    case "mcp_remove":
      check(spec.name, MCP_SERVER_NAME_PATTERN, "MCP server name");
      if (spec.agent !== undefined) check(spec.agent, NAME_PATTERN, "agent name");
      return [
        "mcp",
        "remove",
        `--name=${spec.name}`,
        ...(spec.scope !== undefined ? [`--scope=${spec.scope}`] : []),
        ...(spec.agent !== undefined ? [`--agent=${spec.agent}`] : []),
      ];
    case "powers_install":
      return ["powers", "install", "--", spec.nameOrPath];
    case "powers_uninstall":
      check(spec.name, NAME_PATTERN, "power name");
      return ["powers", "uninstall", "--", spec.name];
  }
}

// ---- ACP host ----------------------------------------------------------------

/** Flags the v3 `acp` command rejects. Agent, model, and effort are set after initialize. */
const ACP_FORBIDDEN = /^(?:--agent|--model|--effort|--trust-all-tools|--trust-tools|-a)(?:=|$)/;

/** argv for the long-lived ACP host (Requirement 5.1, 5.2). */
export function acpArgv(): string[] {
  const argv = ["acp", "--agent-engine=v3", "--auth-method=cli"];
  assertAcp(argv);
  return argv;
}

export function assertAcp(argv: string[]): void {
  for (const arg of argv) {
    if (ACP_FORBIDDEN.test(arg)) throw new ArgvError(`${arg} must not be passed to kiro-cli acp --agent-engine=v3`);
  }
}

// ---- headless ----------------------------------------------------------------

export const TRUST_TOOL_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_:.-]{0,127}$/;

export interface HeadlessOptions {
  agent?: string;
  model?: string;
  effort?: string;
  mode?: "default" | "spec";
  resumeId?: string;
  cloud?: boolean;
  repos?: string[];
  requireMcpStartup?: boolean;
  requireSandbox?: boolean;
  trustAllTools?: boolean;
  trustTools?: string[];
  trustWorkspace?: boolean;
}

/** Fixed-order argv for a headless run. The prompt goes on stdin, never here (Requirement 22.1). */
export function headlessArgv(o: HeadlessOptions): string[] {
  const argv = ["chat", "--v3", "--no-interactive", "--output-format=stream-json", "--wrap=never"];
  if (o.agent !== undefined) argv.push(`--agent=${check(o.agent, NAME_PATTERN, "agent")}`);
  if (o.model !== undefined) argv.push(`--model=${check(o.model, NAME_PATTERN, "model")}`);
  if (o.effort !== undefined) argv.push(`--effort=${check(o.effort, NAME_PATTERN, "effort")}`);
  if (o.mode !== undefined) argv.push(`--mode=${o.mode}`);
  if (o.resumeId !== undefined) argv.push(`--resume-id=${check(o.resumeId, /^[A-Za-z0-9_-]{1,128}$/, "session id")}`);
  if (o.cloud === true) argv.push("--cloud");
  if (o.repos !== undefined && o.repos.length > 0) {
    for (const repo of o.repos) check(repo, /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)?$/, "repo");
    argv.push(`--repo=${o.repos.join(",")}`);
  }
  if (o.requireMcpStartup === true) argv.push("--require-mcp-startup");
  if (o.requireSandbox === true) argv.push("--sandbox");
  if (o.trustAllTools === true) argv.push("--trust-all-tools");
  else if (o.trustTools !== undefined) {
    for (const tool of o.trustTools) check(tool, TRUST_TOOL_PATTERN, "tool id");
    argv.push(`--trust-tools=${o.trustTools.join(",")}`);
  }
  if (o.trustWorkspace === true) argv.push("--trust-workspace");
  assertHeadless(argv);
  return argv;
}

const HEADLESS_ALLOWED =
  /^--(?:v3|no-interactive|output-format=stream-json|wrap=never|agent=.+|model=.+|effort=.+|mode=(?:default|spec)|resume-id=.+|cloud|repo=.+|require-mcp-startup|sandbox|trust-all-tools|trust-tools=.*|trust-workspace)$/;

/** Refuses a positional prompt and any flag outside the fixed set. */
export function assertHeadless(argv: string[]): void {
  if (argv[0] !== "chat") throw new ArgvError("headless argv must start with chat");
  for (const arg of argv.slice(1)) {
    if (!HEADLESS_ALLOWED.test(arg)) throw new ArgvError(`${JSON.stringify(arg)} is not an allowed headless argument`);
  }
}
