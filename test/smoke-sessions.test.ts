import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { connect, requests, type Connected } from "./smoke-helpers.js";

interface NewResult {
  session_id: string;
  modes: { id: string; custom: boolean }[];
  current_mode: string | null;
  config_options: { id: string; current_value: unknown; values: string[] }[];
  commands: { total: number; by_type: Record<string, number> };
  context_usage: { usage_percentage: number | null } | null;
  warnings: string[];
  title: string | null;
  execution_target: string;
}

describe("kiro_session_new", () => {
  let c: Connected;
  before(async () => {
    c = await connect({ setup: (work) => mkdirSync(join(work, "pkg")) });
  });
  after(() => c.close());

  it("creates a local session with mcpServers [] and the requested mode, model, and effort", async () => {
    const r = await c.ok<NewResult>("kiro_session_new", { cwd: c.work, additional_directories: ["pkg"], mode: "plan", model: "claude-sonnet-5.5", effort: "high", title: "My task" });
    assert.match(r.session_id, /^sess_/);
    assert.equal(r.current_mode, "plan");
    assert.equal(r.title, "My task");
    assert.deepEqual(r.warnings, []);
    assert.ok(r.modes.some((m) => m.id === "reviewer-agent" && m.custom));
    assert.ok(r.modes.some((m) => m.id === "vibe" && !m.custom));
    assert.ok(r.config_options.some((o) => o.id === "model" && o.current_value === "claude-sonnet-5.5"));
    assert.equal(r.commands.total, 3);
    assert.deepEqual(r.commands.by_type, { "custom-agent": 1, skill: 1, prompt: 1 });
    const sent = requests(c, "session/new").at(-1)?.params as Record<string, unknown>;
    assert.deepEqual(sent.mcpServers, []);
    assert.equal(sent.cwd, c.work);
    assert.deepEqual(sent.additionalDirectories, [join(c.work, "pkg")]);
    assert.deepEqual(sent._meta, { kiro: { modeId: "plan", modelId: "claude-sonnet-5.5", effortLevel: "high" } });
    assert.equal(requests(c, "_kiro/session/rename").length, 1);
  });

  it("warns when Kiro did not apply a value", async () => {
    const r = await c.ok<NewResult>("kiro_session_new", { cwd: c.work, model: "not-a-model" });
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0] ?? "", /model/);
  });

  it("refuses a cwd outside the roots before any request", async () => {
    const before = requests(c, "session/new").length;
    const err = await c.fail("kiro_session_new", { cwd: "/" });
    assert.equal(err.code, "PATH_OUTSIDE_ROOTS");
    assert.equal(requests(c, "session/new").length, before);
  });

  it("rejects unknown input properties such as mcpServers", async () => {
    const r = await c.call("kiro_session_new", { cwd: c.work, mcpServers: [{ command: "sh" }] });
    assert.equal(r.isError, true);
  });

  it("creates a cloud session with executionTarget and repos", async () => {
    const r = await c.ok<NewResult>("kiro_session_new", { cwd: c.work, execution_target: "cloud", repos: ["octo/app"] });
    assert.equal(r.execution_target, "cloud-sandbox");
    const sent = requests(c, "session/new").at(-1)?.params as { _meta: { kiro: Record<string, unknown> } };
    assert.deepEqual(sent._meta.kiro, { executionTarget: "cloud-sandbox", repos: ["octo/app"] });
  });
});

describe("kiro_session_new without cloud", () => {
  it("fails with UNSUPPORTED_BY_KIRO when cloud-sandbox is not advertised", async () => {
    const c = await connect({ env: { FAKE_KIRO_NO_CLOUD: "1" } });
    try {
      const err = await c.fail("kiro_session_new", { cwd: c.work, execution_target: "cloud", repos: ["octo/app"] });
      assert.equal(err.code, "UNSUPPORTED_BY_KIRO");
    } finally {
      await c.close();
    }
  });
});
