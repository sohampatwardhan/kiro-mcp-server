// Suite-wide checks over stdio: the tool list, schemas, error shapes, secrets, and shutdown.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ERROR_CODES } from "../src/errors.js";
import { alive, waitFor } from "./helpers.js";
import { connect } from "./smoke-helpers.js";

/** The design's tool table: 32 tools. */
const EXPECTED_TOOLS = [
  "kiro_status",
  "kiro_usage",
  "kiro_session_new",
  "kiro_session_list",
  "kiro_session_load",
  "kiro_session_configure",
  "kiro_session_state",
  "kiro_session_history",
  "kiro_session_fork",
  "kiro_session_export",
  "kiro_session_compact",
  "kiro_session_close",
  "kiro_session_delete",
  "kiro_prompt",
  "kiro_events",
  "kiro_steer",
  "kiro_cancel",
  "kiro_permissions",
  "kiro_permission_respond",
  "kiro_tangent",
  "kiro_specs",
  "kiro_memory",
  "kiro_knowledge",
  "kiro_code_intelligence",
  "kiro_workflow",
  "kiro_cloud_sources",
  "kiro_run_headless",
  "kiro_agents",
  "kiro_mcp_config",
  "kiro_settings",
  "kiro_powers",
  "kiro_stream_session",
];

/** Input property names that would forward raw flags, argv, or ACP methods. */
const ESCAPE_HATCH = /^(?:args|argv|flags|extra_args|extra_flags|cli_args|method|acp_method|raw|params|shell|exec|env)$/;

describe("server surface", () => {
  it("exposes exactly the 32 tools from the design, each with an outputSchema and strict input", async () => {
    const c = await connect();
    try {
      assert.equal(c.client.getServerVersion()?.name, "kiro-mcp-server");
      const { tools } = await c.client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
      assert.equal(tools.length, 32);
      for (const tool of tools) {
        assert.ok(tool.outputSchema !== undefined, `${tool.name} has an outputSchema`);
        assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} rejects unknown properties`);
        for (const prop of Object.keys(tool.inputSchema.properties ?? {})) assert.ok(!ESCAPE_HATCH.test(prop), `${tool.name}.${prop}`);
        assert.ok(tool.annotations !== undefined, `${tool.name} has annotations`);
      }
      assert.ok(!tools.some((t) => /shell|exec|raw|passthrough|acp_call/.test(t.name)));
    } finally {
      await c.close();
    }
  });

  it("rejects unknown properties on every tool before anything runs", async () => {
    const c = await connect();
    try {
      for (const name of EXPECTED_TOOLS) {
        const r = await c.call(name, { definitely_not_a_field: "--trust-all-tools" });
        assert.equal(r.isError, true, name);
      }
      assert.equal(c.meta().filter((m) => m.kind === "start").length, 0, "no kiro-cli process started");
    } finally {
      await c.close();
    }
  });

  it("publishes server instructions covering polling, permissions, composition, and impossible features", async () => {
    const c = await connect();
    try {
      const text = c.client.getInstructions() ?? "";
      for (const needle of ["kiro_status first", "kiro_events", "kiro_permission_respond", "never on a turn_end", "/spec run", "/goal", "/clear", "/spawn", "archive", "checkpoints", "OAuth", "kiro_stream_session", "KIRO_MCP_ALLOW_SHELL"]) {
        assert.ok(text.includes(needle), needle);
      }
    } finally {
      await c.close();
    }
  });
});

describe("errors and secrets", () => {
  it("returns documented error bodies with known codes and no prompt text in Kiro details", async () => {
    const c = await connect();
    try {
      const id = (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;
      const failures = [
        await c.fail("kiro_session_load", { session_id: "sess_00000000-0000-4000-8000-0000000000ff" }),
        await c.fail("kiro_steer", { session_id: id, text: "private steering text" }),
        await c.fail("kiro_session_export", { session_id: id, path: "/etc/x.json" }),
        await c.fail("kiro_permission_respond", { permission_id: "perm_0000000000000000", option_id: "accept" }),
      ];
      for (const f of failures) {
        assert.ok(ERROR_CODES.includes(f.code as never), f.code);
        assert.equal(typeof f.message, "string");
        assert.equal(typeof f.details, "object");
        assert.ok(!JSON.stringify(f).includes("private steering text"));
      }
      const crashed = await c.ok<{ turn: { error: { code: string; message: string } } }>("kiro_prompt", { session_id: id, text: "[crash] very-secret-prompt-text", wait_s: 10 });
      assert.equal(crashed.turn.error.code, "HOST_EXITED");
      assert.ok(!JSON.stringify(crashed.turn.error).includes("very-secret-prompt-text"));
    } finally {
      await c.close();
    }
  });

  it("never writes KIRO_API_KEY or tokens to output or logs", async () => {
    const secret = "ksk_live_DO_NOT_LEAK_1234";
    const c = await connect({ env: { KIRO_API_KEY: secret } });
    try {
      const id = (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;
      const outputs = [
        await c.call("kiro_status", { include_diagnostics: true }),
        await c.call("kiro_prompt", { session_id: id, text: "[secret] tell me" }),
        await c.call("kiro_events", { session_id: id, cursor: 0, limit: 1000 }),
        await c.call("kiro_settings", { action: "list" }),
      ];
      const job = await c.ok<{ job_id: string }>("kiro_run_headless", { cwd: c.work, prompt: "hello" });
      outputs.push(await c.call("kiro_events", { job_id: job.job_id, cursor: 0, wait_s: 2 }));
      for (const o of outputs) {
        const text = JSON.stringify(o.raw);
        assert.ok(!text.includes(secret), "API key leaked");
        assert.ok(!text.includes("SECRET-TOKEN-123"), "whoami token leaked");
      }
      assert.ok(!c.stderr().includes(secret));
    } finally {
      await c.close();
    }
  });
});

describe("shutdown", () => {
  it("stops the ACP host and running headless children when the client disconnects", async () => {
    const c = await connect({ env: { FAKE_KIRO_HEADLESS_EXIT: "hang" } });
    const id = (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;
    await c.ok("kiro_prompt", { session_id: id, text: "[long:20000] keep busy", wait_s: 0 });
    await c.ok("kiro_run_headless", { cwd: c.work, prompt: "hang", wait_s: 0.3 });
    const pids = c.meta().filter((m) => m.kind === "start").map((m) => m.pid);
    assert.ok(pids.length >= 2);
    const serverPid = c.serverPid;
    await c.close();
    await waitFor(() => pids.every((pid) => !alive(pid)), 15_000, "children stopped");
    if (serverPid !== null) await waitFor(() => !alive(serverPid), 15_000, "server exited");
    assert.ok(c.meta().some((m) => m.kind === "notification" && m.method === "session/cancel"), "running turn cancelled");
  });
});
