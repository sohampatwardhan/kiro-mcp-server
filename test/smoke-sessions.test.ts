import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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

const ID = (n: number) => `sess_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function seedStore(dir: string, work: string): void {
  const base = { mode: "vibe", model: "auto", effort: "medium", autopilot: "off", context: 2, repos: [] };
  const msg = (text: string, kind = "agent_message_chunk") => ({ sessionUpdate: kind, content: { type: "text", text } });
  const sessions = {
    [ID(1)]: { ...base, id: ID(1), cwd: work, title: "Fix login bug", updatedAt: "2026-11-01T10:00:00.000Z", source: "local", executionTarget: "local", updates: [msg("fix it", "user_message_chunk"), msg("Fixed the login bug.")] },
    [ID(2)]: { ...base, id: ID(2), cwd: work, title: "Add docs", updatedAt: "2026-11-02T10:00:00.000Z", source: "local", executionTarget: "local", updates: [msg("docs please", "user_message_chunk"), msg("Added docs.")] },
    [ID(3)]: { ...base, id: ID(3), cwd: "/elsewhere/secret-project", title: "Outside", updatedAt: "2026-11-02T11:00:00.000Z", source: "local", executionTarget: "local", updates: [] },
    [ID(4)]: { ...base, id: ID(4), cwd: "/cloud/workspace", title: "Cloud refactor", updatedAt: "2026-10-30T10:00:00.000Z", source: "remote", executionTarget: "cloud-sandbox", updates: [msg("Cloud work done.")] },
  };
  writeFileSync(join(dir, "store.json"), JSON.stringify({ sessions }));
}

interface ListResult {
  sessions: { session_id: string; source: string; title: string | null; execution_target: string | null }[];
  omitted_count: number;
  omitted_outside_roots: number;
}

describe("kiro_session_list and kiro_session_load", () => {
  let c: Connected;
  before(async () => {
    c = await connect({ setup: (work, dir) => seedStore(dir, work) });
  });
  after(() => c.close());

  it("lists workspace sessions newest first", async () => {
    const r = await c.ok<ListResult>("kiro_session_list", {});
    assert.deepEqual(r.sessions.map((s) => s.session_id), [ID(2), ID(1)]);
    assert.equal(r.omitted_count, 0);
  });

  it("hides local sessions outside the roots in user scope and counts them", async () => {
    const r = await c.ok<ListResult>("kiro_session_list", { scope: "user" });
    assert.deepEqual(r.sessions.map((s) => s.session_id).sort(), [ID(1), ID(2), ID(4)]);
    assert.equal(r.omitted_outside_roots, 1);
    assert.ok(!JSON.stringify(r).includes("secret-project"));
    const remote = r.sessions.find((s) => s.session_id === ID(4));
    assert.equal(remote?.source, "remote");
    assert.equal(remote?.execution_target, "cloud-sandbox");
  });

  it("filters by source, title, and limit and says how many it left out", async () => {
    const r = await c.ok<ListResult>("kiro_session_list", { scope: "user", source: "local", title_contains: "LOGIN", limit: 5 });
    assert.deepEqual(r.sessions.map((s) => s.session_id), [ID(1)]);
    assert.equal(r.omitted_count, 2);
    const limited = await c.ok<ListResult>("kiro_session_list", { limit: 1 });
    assert.equal(limited.sessions.length, 1);
    assert.equal(limited.omitted_count, 1);
  });

  it("loads a session with replay marked and a replay summary", async () => {
    const r = await c.ok<{ session_id: string; replay_summary: { message_count: number; last_agent_message: string | null }; cursor: number; already_attached: boolean }>("kiro_session_load", { session_id: ID(1) });
    assert.equal(r.session_id, ID(1));
    assert.equal(r.already_attached, false);
    assert.deepEqual(r.replay_summary, { message_count: 2, last_agent_message: "Fixed the login bug." });
    assert.ok(r.cursor > 0);
    const load = requests(c, "session/load").at(-1)?.params as Record<string, unknown>;
    assert.equal(load.cwd, c.work);
    assert.deepEqual(load.mcpServers, []);
    const again = await c.ok<{ already_attached: boolean }>("kiro_session_load", { session_id: ID(1) });
    assert.equal(again.already_attached, true);
  });

  it("loads the latest session for a workspace", async () => {
    const r = await c.ok<{ session_id: string }>("kiro_session_load", { latest: true, cwd: c.work });
    assert.equal(r.session_id, ID(2));
  });

  it("loads a remote session without a root check and never sends noReplay", async () => {
    const r = await c.ok<{ session_id: string; source: string }>("kiro_session_load", { session_id: ID(4) });
    assert.equal(r.source, "remote");
    const load = requests(c, "session/load").at(-1)?.params as { cwd: string; _meta?: unknown };
    assert.equal(load.cwd, "/cloud/workspace");
    assert.equal(load._meta, undefined);
  });

  it("refuses a local session outside the roots and an unknown id", async () => {
    assert.equal((await c.fail("kiro_session_load", { session_id: ID(3) })).code, "PATH_OUTSIDE_ROOTS");
    assert.equal((await c.fail("kiro_session_load", { session_id: ID(99) })).code, "SESSION_NOT_FOUND");
  });
});
