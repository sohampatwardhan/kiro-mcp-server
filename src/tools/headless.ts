import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { NAME_PATTERN, TRUST_TOOL_PATTERN } from "../argv.js";
import { LIMITS } from "../config.js";
import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import { runHeadlessJob } from "../headless.js";
import { JOB_ID_PATTERN, JobStore, jobView, type Job } from "../jobs.js";
import { findCli, cliNotFoundMessage } from "../prereq.js";
import { defineTool, type ToolExtra } from "./define.js";
import { json, pathInput, waitS } from "./schemas.js";
import { REPO_PATTERN } from "./sessions.js";
import { pollFeed, progressReporter } from "./turns.js";

const jobShape = z.object({
  job_id: z.string(),
  status: z.string(),
  cwd: z.string(),
  session_id: z.string().nullable(),
  run_status: z.string().nullable(),
  stop_reason: z.string().nullable(),
  final_text: z.string().nullable(),
  final_text_truncated: z.boolean(),
  interruption: json,
  exit_code: z.number().nullable(),
  signal: z.string().nullable(),
  exit_meaning: z.string().nullable(),
  stderr_tail: z.string(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  elapsed_ms: z.number(),
  cursor: z.number(),
});

export function registerHeadlessTools(server: McpServer, core: Core): JobStore {
  const { config, roots } = core;
  const store = new JobStore();

  const find = (id: string): Job => {
    if (!JOB_ID_PATTERN.test(id)) throw new ToolError("JOB_NOT_FOUND", `invalid job id ${id}`);
    const job = store.get(id);
    if (job === null) throw new ToolError("JOB_NOT_FOUND", `no headless job ${id} (jobs are kept in memory for an hour after they finish)`);
    return job;
  };

  core.jobEvents = async (jobId, args, extra) => {
    const job = find(jobId);
    const a = args as { cursor?: number; limit?: number; wait_s?: number; include_thoughts?: boolean };
    const e = extra as ToolExtra;
    const cursor = a.cursor ?? 0;
    const stop = progressReporter(e, job.feed, cursor);
    let page;
    try {
      page = await pollFeed(job.feed, {
        cursor,
        limit: a.limit ?? 200,
        waitMs: job.finishedAt === null ? (a.wait_s ?? 0) * 1_000 : 0,
        includeThoughts: a.include_thoughts === true,
        ...(e.signal ? { signal: e.signal } : {}),
      });
    } finally {
      stop();
    }
    return {
      session_id: job.sessionId,
      job_id: job.id,
      events: page.events,
      next_cursor: page.nextCursor,
      lowest_cursor: page.lowestCursor,
      gap: page.gap,
      omitted_thoughts: page.omittedThoughts,
      status: job.status,
      turn: null,
      job: jobView(job),
      pending_permissions: [],
    };
  };

  core.cancelJob = async (jobId) => {
    const job = find(jobId);
    if (job.finishedAt === null) {
      job.status = "cancelled";
      job.kill?.();
      await store.settleWithin(job, 6_000);
    }
    return { session_id: job.sessionId, job_id: job.id, status: job.status, turn: null, job: jobView(job) };
  };

  defineTool(
    server,
    "kiro_run_headless",
    {
      title: "Run Kiro headless",
      description:
        "Fire-and-forget run of `kiro-cli chat --v3 --no-interactive --output-format stream-json` in a directory inside KIRO_MCP_ROOTS, locally or in the " +
        "cloud (cloud + repos). The prompt goes on stdin. Returns a job_id: poll kiro_events with job_id for streamed events and the final result " +
        "(session id, final text, exit code and meaning: 0 success, 3 MCP startup failed, 4 agent not found), and stop it with kiro_cancel. Headless runs " +
        "cannot ask for permission: anything not pre-approved is denied. trust_all_tools needs KIRO_MCP_HEADLESS_TRUST=all, trust_tools needs tools or all, " +
        "and trust_workspace needs KIRO_MCP_ALLOW_TRUST_WORKSPACE. Uses the operator's CLI login or KIRO_API_KEY.",
      input: z
        .object({
          cwd: pathInput("Working directory inside KIRO_MCP_ROOTS."),
          prompt: z.string().min(1).max(LIMITS.maxTextChars),
          agent: z.string().regex(NAME_PATTERN).optional(),
          model: z.string().regex(NAME_PATTERN).optional(),
          effort: z.string().regex(NAME_PATTERN).optional(),
          mode: z.enum(["default", "spec"]).optional(),
          resume_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
          cloud: z.boolean().optional(),
          repos: z.array(z.string().regex(REPO_PATTERN)).min(1).max(LIMITS.maxRepos).optional(),
          require_mcp_startup: z.boolean().optional(),
          require_sandbox: z.boolean().optional(),
          trust_all_tools: z.boolean().optional(),
          trust_tools: z.array(z.string().regex(TRUST_TOOL_PATTERN)).min(1).max(100).optional(),
          trust_workspace: z.boolean().optional(),
          workflow_timeout_s: z.number().int().min(1).max(21_600).optional(),
          timeout_s: z.number().int().min(1).max(Math.floor(config.headlessTimeoutMs / 1_000)).optional(),
          wait_s: waitS(5, "Seconds to wait for the run to finish before returning the job"),
        })
        .strict(),
      output: jobShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      if (args.trust_all_tools === true && config.headlessTrust !== "all") {
        throw new ToolError("HEADLESS_TRUST_DISABLED", "trust_all_tools needs the operator's KIRO_MCP_HEADLESS_TRUST=all");
      }
      if (args.trust_tools !== undefined && config.headlessTrust === "none") {
        throw new ToolError("HEADLESS_TRUST_DISABLED", "trust_tools needs the operator's KIRO_MCP_HEADLESS_TRUST=tools or all");
      }
      if (args.trust_workspace === true && !config.allowTrustWorkspace) {
        throw new ToolError("HEADLESS_TRUST_DISABLED", "trust_workspace needs the operator's KIRO_MCP_ALLOW_TRUST_WORKSPACE=1");
      }
      if (args.repos !== undefined && args.cloud !== true) throw new ToolError("VALUE_NOT_ADVERTISED", "repos are only valid with cloud: true");
      const cwd = await roots.resolveInside(args.cwd);
      if (findCli(config.kiroBin, process.env, config.cwd) === null) throw new ToolError("CLI_NOT_FOUND", cliNotFoundMessage(config.kiroBin));
      await core.usage.guard();
      const job = store.create(cwd);
      runHeadlessJob(store, job, {
        bin: config.kiroBin,
        cwd,
        prompt: args.prompt,
        timeoutMs: args.timeout_s !== undefined ? args.timeout_s * 1_000 : config.headlessTimeoutMs,
        ...(args.workflow_timeout_s !== undefined ? { workflowTimeoutS: args.workflow_timeout_s } : {}),
        options: {
          ...(args.agent !== undefined ? { agent: args.agent } : {}),
          ...(args.model !== undefined ? { model: args.model } : {}),
          ...(args.effort !== undefined ? { effort: args.effort } : {}),
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          ...(args.resume_id !== undefined ? { resumeId: args.resume_id } : {}),
          ...(args.cloud === true ? { cloud: true } : {}),
          ...(args.repos !== undefined ? { repos: args.repos } : {}),
          ...(args.require_mcp_startup === true ? { requireMcpStartup: true } : {}),
          ...(args.require_sandbox === true ? { requireSandbox: true } : {}),
          ...(args.trust_all_tools === true ? { trustAllTools: true } : {}),
          ...(args.trust_tools !== undefined ? { trustTools: args.trust_tools } : {}),
          ...(args.trust_workspace === true ? { trustWorkspace: true } : {}),
        },
      });
      await store.settleWithin(job, (args.wait_s ?? 5) * 1_000);
      return jobView(job);
    },
  );

  return store;
}
