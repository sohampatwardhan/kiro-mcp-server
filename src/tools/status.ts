import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { subcommandArgv } from "../argv.js";
import { cliDetails, runCli } from "../cli.js";
import { LIMITS } from "../config.js";
import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import { cleanTerminalText, parseJson, parseProfile, parseWhoami, tail } from "../parse.js";
import { CLI_INSTALL_COMMAND, SIGN_IN_INSTRUCTION, cliNotFoundMessage, findCli, isSignInError, parseVersion } from "../prereq.js";
import { trustInstruction, workspaceTrust } from "../trust.js";
import { defineTool } from "./define.js";
import { json, sessionId } from "./schemas.js";

export function registerStatusTools(server: McpServer, core: Core): void {
  const { config, roots, host, sessions } = core;
  const cli = (argv: string[], timeoutMs = config.cliTimeoutMs) => runCli(config.kiroBin, argv, { timeoutMs, cwd: roots.primary });

  defineTool(
    server,
    "kiro_status",
    {
      title: "Kiro status",
      description:
        "Call first. Reports whether kiro-cli is installed (path, version), whether the V3 ACP engine starts, the host's capabilities (prompt and session " +
        "capabilities, extension methods, session sources, list scopes, execution targets, auto-compaction range), sign-in state from `kiro-cli whoami` " +
        "(account type, email, profile only), the roots and their saved workspace trust, the operator policy, and Kiro's log paths. " +
        "Signed out: run `kiro-cli login` in a terminal; this server never logs in. include_diagnostics adds `kiro-cli diagnostic` and `kiro-cli doctor --all`.",
      input: z.object({ include_diagnostics: z.boolean().optional() }).strict(),
      output: z.object({
        cli: z.object({ found: z.boolean(), path: z.string().nullable(), version: z.string().nullable(), install_command: z.string() }),
        engine_v3: z.object({ ready: z.boolean(), error: z.object({ code: z.string(), message: z.string() }).nullable() }),
        capabilities: json,
        signed_in: z.boolean().nullable(),
        account: z.object({ account_type: z.string().nullable(), email: z.string().nullable(), profile: z.string().nullable() }).nullable(),
        sign_in_instruction: z.string().nullable(),
        roots: z.array(z.object({ path: z.string(), trusted: z.boolean().nullable() })),
        policy: z.object({
          permissions: z.string(),
          permission_timeout_ms: z.number(),
          allow_shell: z.boolean(),
          allow_persistent_consent: z.boolean(),
          headless_trust: z.string(),
          allow_trust_workspace: z.boolean(),
          allow_config_writes: z.boolean(),
        }),
        log_paths: z.array(z.string()),
        dropped_lines: z.number(),
        attached_sessions: z.number(),
        warnings: z.array(z.string()),
        diagnostics: json,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const warnings: string[] = [];
      const path = findCli(config.kiroBin, process.env, config.cwd);
      let version: string | null = null;
      if (path !== null) {
        try {
          version = parseVersion((await cli(subcommandArgv({ cmd: "version" }), 15_000)).stdout);
        } catch {
          version = null;
        }
      } else {
        warnings.push(cliNotFoundMessage(config.kiroBin));
      }

      let engine: { ready: boolean; error: { code: string; message: string } | null } = { ready: false, error: null };
      if (path !== null) {
        try {
          await host.ensureStarted();
          engine = { ready: true, error: null };
        } catch (err) {
          const e = err instanceof ToolError ? err : new ToolError("ENGINE_V3_UNAVAILABLE", String(err));
          engine = { ready: false, error: { code: e.code, message: e.message } };
        }
      } else {
        engine = { ready: false, error: { code: "CLI_NOT_FOUND", message: cliNotFoundMessage(config.kiroBin) } };
      }

      let signedIn: boolean | null = null;
      let account: { account_type: string | null; email: string | null; profile: string | null } | null = null;
      if (path !== null) {
        try {
          const who = await cli(subcommandArgv({ cmd: "whoami" }));
          const text = `${cleanTerminalText(who.stderr)}\n${cleanTerminalText(who.stdout)}`;
          if (who.exitCode !== 0) {
            signedIn = isSignInError(text) ? false : null;
            if (signedIn === null) warnings.push(`kiro-cli whoami failed: ${tail(text.trim(), 300)}`);
          } else {
            const parsed = parseWhoami(who.stdout);
            signedIn = true;
            let profile = parsed.profile;
            if (profile === null && /idc|identity/i.test(parsed.accountType ?? "")) {
              const prof = await cli(subcommandArgv({ cmd: "profile" })).catch(() => null);
              if (prof !== null && prof.exitCode === 0) profile = parseProfile(prof.stdout);
            }
            account = { account_type: parsed.accountType, email: parsed.email, profile };
          }
        } catch (err) {
          warnings.push(`could not read sign-in state: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const rootStates = await Promise.all(roots.list.map(async (root) => ({ path: root, trusted: await workspaceTrust(root) })));
      for (const r of rootStates) if (r.trusted !== true) warnings.push(trustInstruction(r.path));
      if (!config.allowShell) warnings.push("Shell approvals are off: Kiro cannot run commands such as tests in ACP sessions until the operator sets KIRO_MCP_ALLOW_SHELL=1.");

      const kiro = host.kiro;
      const caps = host.capabilities;
      const logPaths = [kiro.logging?.logDir, ...(kiro.logging?.channels ?? []).map((c) => c.filePath)].filter((p): p is string => typeof p === "string");

      let diagnostics: unknown = null;
      if (args.include_diagnostics === true && path !== null) {
        const diag = await cli(subcommandArgv({ cmd: "diagnostic" })).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
        const doctor = await cli(subcommandArgv({ cmd: "doctor_all" })).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
        diagnostics = {
          diagnostic: diag instanceof Error ? { error: diag.message } : safeJson(diag.stdout) ?? cliDetails(diag),
          doctor: doctor instanceof Error ? { error: doctor.message } : { exit_code: doctor.exitCode, output: tail(cleanTerminalText(doctor.stdout + doctor.stderr), LIMITS.outputTailChars) },
        };
      }

      return {
        cli: { found: path !== null, path, version, install_command: CLI_INSTALL_COMMAND },
        engine_v3: engine,
        capabilities: caps === null
          ? null
          : {
              load_session: caps.loadSession === true,
              prompt: caps.promptCapabilities ?? {},
              session: Object.keys(caps.sessionCapabilities ?? {}),
              extension_methods: kiro.extensionMethods ?? [],
              session_sources: kiro.sessionSources ?? [],
              session_list_scopes: kiro.sessionListScopes ?? [],
              execution_targets: kiro.executionTargets ?? [],
              auto_compaction_threshold: kiro.autoCompactionThreshold ?? null,
            },
        signed_in: signedIn,
        account,
        sign_in_instruction: signedIn === false ? SIGN_IN_INSTRUCTION : null,
        roots: rootStates,
        policy: {
          permissions: config.permissions,
          permission_timeout_ms: config.permissionTimeoutMs,
          allow_shell: config.allowShell,
          allow_persistent_consent: config.allowPersistentConsent,
          headless_trust: config.headlessTrust,
          allow_trust_workspace: config.allowTrustWorkspace,
          allow_config_writes: config.allowConfigWrites,
        },
        log_paths: logPaths,
        dropped_lines: host.droppedLines,
        attached_sessions: sessions.all().filter((s) => !s.closed).length,
        warnings,
        diagnostics,
      };
    },
  );

  defineTool(
    server,
    "kiro_usage",
    {
      title: "Kiro usage and credits",
      description:
        "Plan usage from _kiro/account/getUsage, like /usage: plan name, billing cycle reset date, usage breakdowns (resource type, used, limit, percentage), " +
        "bonus and add-on credits, and whether overages are enabled. With session_id, also the credits this server observed for that session's turns since it " +
        "was attached. UNSUPPORTED_BY_KIRO errors still carry session_credits in their details.",
      input: z.object({ session_id: sessionId.optional() }).strict(),
      output: z.object({
        plan: z.string().nullable(),
        reset_date: z.string().nullable(),
        breakdowns: z.array(z.object({ resource_type: z.string().nullable(), display_name: z.string().nullable(), used: z.number().nullable(), limit: z.number().nullable(), percentage: z.number().nullable() })),
        bonus_credits: z.array(json),
        add_on_credits: z.array(json),
        overages_enabled: z.boolean().nullable(),
        session_credits: z.record(z.string(), z.number()).nullable(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const session = args.session_id !== undefined ? sessions.require(args.session_id) : undefined;
      const sessionCredits = session === undefined ? null : Object.fromEntries(session.creditTotals);
      let result: Record<string, unknown> | null;
      try {
        result = (await host.call("_kiro/account/getUsage", session !== undefined ? { sessionId: session.sessionId } : {})) as Record<string, unknown> | null;
      } catch (err) {
        if (err instanceof ToolError && err.code === "UNSUPPORTED_BY_KIRO") {
          throw new ToolError("UNSUPPORTED_BY_KIRO", "this Kiro host does not implement _kiro/account/getUsage", { ...err.details, session_credits: sessionCredits });
        }
        throw err;
      }
      if (result?.success === false) throw new ToolError("KIRO_REFUSED", typeof result.message === "string" ? result.message : "Kiro refused the usage request", { session_credits: sessionCredits });
      const data = ((result?.data ?? result ?? {}) as Record<string, unknown>);
      const s = (v: unknown) => (typeof v === "string" ? v : null);
      const n = (v: unknown) => (typeof v === "number" ? v : null);
      const arr = (v: unknown) => (Array.isArray(v) ? v : []);
      return {
        plan: s(data.planName),
        reset_date: s(data.billingCycleReset),
        breakdowns: arr(data.usageBreakdowns).map((b) => {
          const r = (b ?? {}) as Record<string, unknown>;
          return { resource_type: s(r.resourceType), display_name: s(r.displayName), used: n(r.used), limit: n(r.limit), percentage: n(r.percentage) };
        }),
        bonus_credits: arr(data.bonusCredits),
        add_on_credits: arr(data.addOnCredits),
        overages_enabled: typeof data.overagesEnabled === "boolean" ? data.overagesEnabled : null,
        session_credits: sessionCredits,
      };
    },
  );
}

function safeJson(text: string): unknown {
  try {
    return parseJson(text);
  } catch {
    return undefined;
  }
}
