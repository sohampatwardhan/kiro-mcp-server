import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertHeadless, headlessArgv } from "../src/argv.js";
import { JOB_ID_PATTERN, JobStore, exitMeaning } from "../src/jobs.js";

describe("headlessArgv", () => {
  it("builds the fixed order with values attached", () => {
    assert.deepEqual(
      headlessArgv({ agent: "reviewer", model: "auto", effort: "high", mode: "spec", resumeId: "sess_1", cloud: true, repos: ["a/b", "c/d"], requireMcpStartup: true, requireSandbox: true, trustTools: ["read_file", "grep_search"], trustWorkspace: true }),
      [
        "chat", "--v3", "--no-interactive", "--output-format=stream-json", "--wrap=never",
        "--agent=reviewer", "--model=auto", "--effort=high", "--mode=spec", "--resume-id=sess_1", "--cloud", "--repo=a/b,c/d",
        "--require-mcp-startup", "--sandbox", "--trust-tools=read_file,grep_search", "--trust-workspace",
      ],
    );
    assert.deepEqual(headlessArgv({ trustAllTools: true, trustTools: ["x"] }).slice(5), ["--trust-all-tools"]);
  });

  it("refuses positional prompts, unknown flags, and bad values", () => {
    assert.throws(() => assertHeadless(["chat", "--v3", "do something"]));
    assert.throws(() => assertHeadless(["chat", "--v3", "--legacy-ui"]));
    assert.throws(() => headlessArgv({ agent: "-x" }));
    assert.throws(() => headlessArgv({ trustTools: ["a,b"] }));
  });
});

describe("JobStore", () => {
  it("creates job ids, settles, and prunes by TTL and cap with an injected clock", async () => {
    let now = 0;
    const store = new JobStore(() => now, { ttlMs: 1_000, maxFinished: 2 });
    const jobs = [store.create("/w"), store.create("/w"), store.create("/w")];
    for (const j of jobs) assert.match(j.id, JOB_ID_PATTERN);
    assert.equal(store.get(jobs[0]!.id), jobs[0]);
    for (const j of jobs) {
      now += 10;
      store.finish(j, "done");
    }
    assert.equal(store.get(jobs[0]!.id), null, "oldest finished dropped past the cap");
    assert.ok(store.get(jobs[2]!.id));
    now += 2_000;
    assert.equal(store.get(jobs[2]!.id), null, "expired");
    const running = store.create("/w");
    now += 10_000;
    assert.equal(store.get(running.id), running, "running jobs are kept");
  });

  it("settleWithin resolves on settle or after the wait", async () => {
    const store = new JobStore();
    const job = store.create("/w");
    assert.equal(await store.settleWithin(job, 20), false);
    setTimeout(() => store.finish(job, "done"), 10);
    assert.equal(await store.settleWithin(job, 2_000), true);
    assert.equal(store.finish(job, "cancelled"), false, "a finished job stays finished");
  });

  it("explains exit codes", () => {
    assert.equal(exitMeaning(0), "success");
    assert.equal(exitMeaning(3), "mcp_startup_failed");
    assert.equal(exitMeaning(4), "agent_not_found");
    assert.equal(exitMeaning(1), "failure");
    assert.equal(exitMeaning(null), "killed");
  });
});
