import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { alive, waitFor } from "./helpers.js";
import { connect, type Connected } from "./smoke-helpers.js";

interface Job {
  job_id: string;
  status: string;
  session_id: string | null;
  run_status: string | null;
  final_text: string | null;
  exit_code: number | null;
  exit_meaning: string | null;
  stderr_tail: string;
  error: { code: string } | null;
  interruption: unknown;
}

async function untilDone(c: Connected, jobId: string): Promise<{ job: Job; events: { type: string; text?: string }[] }> {
  const events: { type: string; text?: string }[] = [];
  let cursor = 0;
  for (let i = 0; i < 60; i++) {
    const r = await c.ok<{ job: Job; events: { type: string; text?: string }[]; next_cursor: number; status: string }>("kiro_events", { job_id: jobId, cursor, wait_s: 1 });
    events.push(...r.events);
    cursor = r.next_cursor;
    if (r.status === "done" || r.status === "cancelled") return { job: r.job, events };
  }
  throw new Error("job never finished");
}

const headlessStarts = (c: Connected) => c.meta().filter((m) => m.kind === "start" && m.argv?.[0] === "chat" && m.argv.includes("--no-interactive"));

describe("kiro_run_headless", () => {
  it("runs with the prompt on stdin and reports the result, events, and exit meaning", async () => {
    const c = await connect({ env: { KIRO_API_KEY: "ksk_secret_value" } });
    try {
      const job = await c.ok<Job>("kiro_run_headless", { cwd: c.work, prompt: "summarize the repo", model: "auto", workflow_timeout_s: 600 });
      const { job: done, events } = await untilDone(c, job.job_id);
      assert.equal(done.status, "done");
      assert.equal(done.exit_code, 0);
      assert.equal(done.exit_meaning, "success");
      assert.equal(done.run_status, "success");
      assert.equal(done.final_text, "Headless: summarize the repo");
      assert.match(done.session_id ?? "", /^sess_/);
      assert.ok(events.some((e) => e.type === "message" && e.text === "Headless: summarize the repo"));
      assert.ok(events.some((e) => e.type === "notice"));
      const start = headlessStarts(c).at(-1);
      assert.deepEqual(start?.argv, ["chat", "--v3", "--no-interactive", "--output-format=stream-json", "--wrap=never", "--model=auto"]);
      assert.equal(start?.hasApiKey, true);
      assert.equal(start?.workflowTimeout, "600");
      assert.ok(!c.stderr().includes("ksk_secret_value"));
      const all = JSON.stringify(await c.ok("kiro_events", { job_id: job.job_id, cursor: 0, limit: 1000 }));
      assert.ok(!all.includes("ksk_secret_value"));
    } finally {
      await c.close();
    }
  });

  for (const [exit, meaning] of [["3", "mcp_startup_failed"], ["4", "agent_not_found"]] as const) {
    it(`reports exit ${exit} as a finished job with meaning ${meaning}`, async () => {
      const c = await connect({ env: { FAKE_KIRO_HEADLESS_EXIT: exit } });
      try {
        const job = await c.ok<Job>("kiro_run_headless", { cwd: c.work, prompt: "x", require_mcp_startup: true, agent: "ghost" });
        const { job: done } = await untilDone(c, job.job_id);
        assert.equal(done.status, "done");
        assert.equal(done.exit_code, Number(exit));
        assert.equal(done.exit_meaning, meaning);
        assert.equal(done.error, null);
        assert.ok(done.stderr_tail.length > 0);
      } finally {
        await c.close();
      }
    });
  }

  it("records the interruption record", async () => {
    const c = await connect({ env: { FAKE_KIRO_HEADLESS_EXIT: "interrupt" } });
    try {
      const { job } = await untilDone(c, (await c.ok<Job>("kiro_run_headless", { cwd: c.work, prompt: "x" })).job_id);
      assert.equal(job.run_status, "interrupted");
      assert.deepEqual(job.interruption, { reason: "signal" });
    } finally {
      await c.close();
    }
  });

  it("gates trust flags on the operator settings before spawning", async () => {
    const c = await connect();
    try {
      for (const args of [{ trust_all_tools: true }, { trust_tools: ["read_file"] }, { trust_workspace: true }]) {
        assert.equal((await c.fail("kiro_run_headless", { cwd: c.work, prompt: "x", ...args })).code, "HEADLESS_TRUST_DISABLED");
      }
      assert.equal(headlessStarts(c).length, 0);
      assert.equal((await c.fail("kiro_run_headless", { cwd: "/", prompt: "x" })).code, "PATH_OUTSIDE_ROOTS");
    } finally {
      await c.close();
    }
    const tools = await connect({ env: { KIRO_MCP_HEADLESS_TRUST: "tools", KIRO_MCP_ALLOW_TRUST_WORKSPACE: "1" } });
    try {
      assert.equal((await tools.fail("kiro_run_headless", { cwd: tools.work, prompt: "x", trust_all_tools: true })).code, "HEADLESS_TRUST_DISABLED");
      const job = await tools.ok<Job>("kiro_run_headless", { cwd: tools.work, prompt: "x", trust_tools: ["read_file", "grep_search"], trust_workspace: true });
      await untilDone(tools, job.job_id);
      assert.ok(headlessStarts(tools).at(-1)?.argv?.includes("--trust-tools=read_file,grep_search"));
      assert.ok(headlessStarts(tools).at(-1)?.argv?.includes("--trust-workspace"));
    } finally {
      await tools.close();
    }
  });

  it("passes cloud flags", async () => {
    const c = await connect();
    try {
      const job = await c.ok<Job>("kiro_run_headless", { cwd: c.work, prompt: "x", cloud: true, repos: ["octo/app", "octo/lib"], mode: "spec", require_sandbox: true });
      await untilDone(c, job.job_id);
      const argv = headlessStarts(c).at(-1)?.argv ?? [];
      for (const flag of ["--cloud", "--repo=octo/app,octo/lib", "--mode=spec", "--sandbox"]) assert.ok(argv.includes(flag), flag);
    } finally {
      await c.close();
    }
  });

  it("cancels a running job by stopping its process group", async () => {
    const c = await connect({ env: { FAKE_KIRO_HEADLESS_EXIT: "hang" } });
    try {
      const job = await c.ok<Job>("kiro_run_headless", { cwd: c.work, prompt: "x", wait_s: 0.3 });
      assert.equal(job.status, "running");
      const pid = headlessStarts(c).at(-1)?.pid ?? 0;
      const r = await c.ok<{ status: string; job: Job }>("kiro_cancel", { job_id: job.job_id });
      assert.equal(r.status, "cancelled");
      await waitFor(() => !alive(pid), 5_000, "headless child stopped");
    } finally {
      await c.close();
    }
  });

  it("stops a job that passes its timeout", async () => {
    const c = await connect({ env: { FAKE_KIRO_HEADLESS_EXIT: "hang" } });
    try {
      const job = await c.ok<Job>("kiro_run_headless", { cwd: c.work, prompt: "x", timeout_s: 1, wait_s: 0 });
      const { job: done } = await untilDone(c, job.job_id);
      assert.equal(done.error?.code, "TIMEOUT");
      assert.equal(done.status, "done");
    } finally {
      await c.close();
    }
  });

  it("reports an unknown job id", async () => {
    const c = await connect();
    try {
      assert.equal((await c.fail("kiro_events", { job_id: "job_000000000000000000000000" })).code, "JOB_NOT_FOUND");
      assert.equal((await c.fail("kiro_cancel", { job_id: "job_000000000000000000000000" })).code, "JOB_NOT_FOUND");
    } finally {
      await c.close();
    }
  });
});
