import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { waitFor } from "./helpers.js";
import { connect, requests, type Connected } from "./smoke-helpers.js";

describe("Kiro extensions", () => {
  let c: Connected;
  let id: string;
  before(async () => {
    c = await connect({ setup: (work) => mkdirSync(join(work, "docs")) });
    id = (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;
  });
  after(() => c.close());

  it("compacts an idle session and reports the new context usage, but not during a turn", async () => {
    const r = await c.ok<{ context_usage: { usage_percentage: number } }>("kiro_session_compact", { session_id: id });
    assert.equal(r.context_usage.usage_percentage, 0.5);
    await c.ok("kiro_prompt", { session_id: id, text: "[long:800] busy", wait_s: 0 });
    assert.equal((await c.fail("kiro_session_compact", { session_id: id })).code, "TURN_ACTIVE");
    await c.ok("kiro_cancel", { session_id: id });
  });

  it("manages memories, needs confirm to delete, and maps refusals", async () => {
    const created = await c.ok<{ result: { memory: { id: string } } }>("kiro_memory", { action: "create", session_id: id, content: "prefers pnpm" });
    const memId = created.result.memory.id;
    const list = await c.ok<{ result: { memories: unknown[] } }>("kiro_memory", { action: "list", session_id: id });
    assert.equal(list.result.memories.length, 1);
    await c.ok("kiro_memory", { action: "update", session_id: id, memory_id: memId, content: "prefers npm" });
    const got = await c.ok<{ result: { memory: { content: string } } }>("kiro_memory", { action: "get", session_id: id, memory_id: memId });
    assert.equal(got.result.memory.content, "prefers npm");
    assert.equal((await c.fail("kiro_memory", { action: "delete", session_id: id, memory_id: memId })).code, "CONFIRMATION_REQUIRED");
    await c.ok("kiro_memory", { action: "delete", session_id: id, memory_id: memId, confirm: true });
    const refused = await c.fail("kiro_memory", { action: "create", session_id: id, content: "[refuse] x" });
    assert.equal(refused.code, "KIRO_REFUSED");
    assert.match(refused.message, /untrusted workspace/);
    const sync = await c.ok<{ result: { state: string } }>("kiro_memory", { action: "sync_status", session_id: id });
    assert.equal(sync.result.state, "off");
  });

  it("runs knowledge subcommands with add paths inside the roots", async () => {
    const r = await c.ok<{ success: boolean; message: string }>("kiro_knowledge", { session_id: id, subcommand: "add", path: "docs", name: "docs" });
    assert.equal(r.success, true);
    assert.deepEqual(requests(c, "_kiro/knowledge").at(-1)?.params, { sessionId: id, subcommand: "add", path: join(c.work, "docs"), name: "docs" });
    assert.equal((await c.fail("kiro_knowledge", { session_id: id, subcommand: "add", path: "/etc" })).code, "PATH_OUTSIDE_ROOTS");
    const s = await c.ok<{ message: string }>("kiro_knowledge", { session_id: id, subcommand: "search", query: "auth" });
    assert.equal(s.message, "knowledge search ok");
  });

  it("maps code intelligence refusals to KIRO_REFUSED", async () => {
    const refused = await c.fail("kiro_code_intelligence", { session_id: id, subcommand: "status" });
    assert.equal(refused.code, "KIRO_REFUSED");
    assert.match(refused.message, /not enabled/);
    const init = await c.ok<{ success: boolean }>("kiro_code_intelligence", { session_id: id, subcommand: "init" });
    assert.equal(init.success, true);
  });

  it("lists recipes, checks inputs, invokes, controls runs, and records workflow events", async () => {
    const recipes = await c.ok<{ result: { recipes: { name: string }[] } }>("kiro_workflow", { action: "list_recipes", session_id: id });
    assert.ok(recipes.result.recipes.some((r) => r.name === "goal"));
    assert.equal((await c.fail("kiro_workflow", { action: "invoke", session_id: id, recipe: "goal", inputs: { bogus: "x" } })).code, "VALUE_NOT_ADVERTISED");
    assert.equal((await c.fail("kiro_workflow", { action: "invoke", session_id: id, recipe: "missing" })).code, "VALUE_NOT_ADVERTISED");
    const run = await c.ok<{ workflow_id: string }>("kiro_workflow", { action: "invoke", session_id: id, recipe: "goal", inputs: { goal: "green tests" } });
    assert.match(run.workflow_id, /^wf_/);
    await waitFor(async () => {
      const ev = await c.ok<{ events: { type: string; status?: string; workflowId?: string }[] }>("kiro_events", { session_id: id, cursor: 0, limit: 1000 });
      return ev.events.some((e) => e.type === "workflow" && e.workflowId === run.workflow_id && e.status === "completed");
    }, 3_000, "workflow events");
    for (const action of ["inspect", "pause", "resume", "cancel", "delete"]) {
      const r = await c.ok<{ result: { action: string } }>("kiro_workflow", { action, session_id: id, workflow_id: run.workflow_id });
      assert.equal(r.result.action, action);
    }
    await c.ok("kiro_workflow", { action: "retry", session_id: id, workflow_id: run.workflow_id, node_id: "n1" });
    assert.deepEqual(requests(c, "_kiro/workflow/retry").at(-1)?.params, { sessionId: id, workflowId: run.workflow_id, nodeId: "n1" });
  });

  it("lists source providers and their repositories", async () => {
    const p = await c.ok<{ providers: { providerType: string }[] }>("kiro_cloud_sources", { session_id: id });
    assert.deepEqual(p.providers.map((x) => x.providerType), ["GITHUB", "GITLAB"]);
    const r = await c.ok<{ resources: { name: string }[] }>("kiro_cloud_sources", { session_id: id, provider: "GITHUB" });
    assert.equal(r.resources[0]?.name, "octo/app");
  });
});

describe("workflows disabled", () => {
  it("fails with KIRO_REFUSED and Kiro's message", async () => {
    const c = await connect({ env: { FAKE_KIRO_WORKFLOWS_OFF: "1" } });
    try {
      const id = (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;
      const err = await c.fail("kiro_workflow", { action: "list", session_id: id });
      assert.equal(err.code, "KIRO_REFUSED");
      assert.match(err.message, /disabled/);
    } finally {
      await c.close();
    }
  });
});
