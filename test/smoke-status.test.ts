import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";

import { workspaceRootsFile } from "../src/trust.js";
import { connect } from "./smoke-helpers.js";

interface Status {
  cli: { found: boolean; version: string | null };
  engine_v3: { ready: boolean; error: { code: string; message: string } | null };
  capabilities: { execution_targets: string[]; extension_methods: string[]; session: string[] } | null;
  signed_in: boolean | null;
  account: Record<string, unknown> | null;
  sign_in_instruction: string | null;
  roots: { path: string; trusted: boolean | null }[];
  log_paths: string[];
  warnings: string[];
  diagnostics: { diagnostic: unknown; doctor: { output: string } } | null;
}

describe("kiro_status", () => {
  it("reports the CLI, engine, capabilities, account fields only, trust, and log paths", async () => {
    const c = await connect({
      setup: (work, dir) => {
        const file = workspaceRootsFile(work, dir);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "rules: []\nworkspaceTrusted: true\n");
      },
    });
    try {
      const s = await c.ok<Status>("kiro_status");
      assert.deepEqual(s.cli.found, true);
      assert.equal(s.cli.version, "2.37.1");
      assert.equal(s.engine_v3.ready, true);
      assert.deepEqual(s.capabilities?.execution_targets, ["local", "cloud-sandbox"]);
      assert.ok(s.capabilities?.session.includes("fork"));
      assert.equal(s.signed_in, true);
      assert.deepEqual(s.account, { account_type: "BuilderId", email: "dev@example.com", profile: null });
      assert.ok(!JSON.stringify(s).includes("SECRET-TOKEN-123"));
      assert.deepEqual(s.roots, [{ path: c.work, trusted: true }]);
      assert.ok(s.log_paths.includes("/home/dev/.kiro/logs/fake/kiro.log"));
      assert.ok(!s.warnings.some((w) => w.includes("workspace trust")));
      assert.equal(s.diagnostics, null);
      assert.ok(!c.meta().some((m) => m.argv?.[0] === "doctor"));
    } finally {
      await c.close();
    }
  });

  it("warns about untrusted roots and shell approvals", async () => {
    const c = await connect();
    try {
      const s = await c.ok<Status>("kiro_status");
      assert.deepEqual(s.roots, [{ path: c.work, trusted: false }]);
      assert.ok(s.warnings.some((w) => w.includes("kiro-cli --v3") && w.includes(c.work)));
      assert.ok(s.warnings.some((w) => w.includes("KIRO_MCP_ALLOW_SHELL")));
    } finally {
      await c.close();
    }
  });

  it("reports a signed-out CLI with the login instruction and maps auth errors in other tools", async () => {
    const c = await connect({ env: { FAKE_KIRO_SIGNED_OUT: "1" } });
    try {
      const s = await c.ok<Status>("kiro_status");
      assert.equal(s.signed_in, false);
      assert.match(s.sign_in_instruction ?? "", /kiro-cli login/);
      assert.ok(!c.meta().some((m) => m.argv?.includes("login")));
      const err = await c.fail("kiro_session_new", { cwd: c.work });
      assert.equal(err.code, "CLI_NOT_SIGNED_IN");
      assert.match(err.message, /kiro-cli login/);
    } finally {
      await c.close();
    }
  });

  it("adds diagnostic and doctor --all output on request", async () => {
    const c = await connect();
    try {
      const s = await c.ok<Status>("kiro_status", { include_diagnostics: true });
      assert.deepEqual(s.diagnostics?.diagnostic, { "kiro-cli": { version: "2.37.1" }, os: { name: "fake" } });
      assert.match(s.diagnostics?.doctor.output ?? "", /Everything looks good/);
      assert.ok(!(s.diagnostics?.doctor.output ?? "").includes("\u001b"));
      assert.ok(c.meta().some((m) => m.argv?.[0] === "doctor" && m.argv.includes("--all")));
    } finally {
      await c.close();
    }
  });

  it("reports a missing CLI and an engine that will not start", async () => {
    const missing = await connect({ env: { KIRO_BIN: "/nonexistent/kiro-cli" } });
    try {
      const s = await missing.ok<Status>("kiro_status");
      assert.equal(s.cli.found, false);
      assert.equal(s.engine_v3.error?.code, "CLI_NOT_FOUND");
      assert.equal((await missing.fail("kiro_session_new", { cwd: missing.work })).code, "CLI_NOT_FOUND");
      assert.match(missing.stderr(), /cli\.kiro\.dev\/install/);
    } finally {
      await missing.close();
    }
    const broken = await connect({ env: { FAKE_KIRO_ACP_INIT_FAIL: "1" } });
    try {
      const s = await broken.ok<Status>("kiro_status");
      assert.equal(s.engine_v3.error?.code, "ENGINE_V3_UNAVAILABLE");
      assert.match(s.engine_v3.error?.message ?? "", /2\.37\.1/);
      assert.equal((await broken.fail("kiro_session_new", { cwd: broken.work })).code, "ENGINE_V3_UNAVAILABLE");
    } finally {
      await broken.close();
    }
  });
});

describe("kiro_usage", () => {
  it("returns plan usage and the session's observed credits", async () => {
    const c = await connect();
    try {
      const id = (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;
      await c.ok("kiro_prompt", { session_id: id, text: "one" });
      await c.ok("kiro_prompt", { session_id: id, text: "two" });
      const u = await c.ok<{ plan: string; reset_date: string; breakdowns: { resource_type: string; used: number }[]; bonus_credits: unknown[]; overages_enabled: boolean; session_credits: Record<string, number> }>("kiro_usage", { session_id: id });
      assert.equal(u.plan, "KIRO FREE");
      assert.equal(u.reset_date, "2026-12-01");
      assert.deepEqual(u.breakdowns[0], { resource_type: "CREDIT", display_name: "Credits", used: 3, limit: 50, percentage: 6 });
      assert.equal(u.bonus_credits.length, 1);
      assert.equal(u.overages_enabled, false);
      assert.deepEqual(u.session_credits, { credit: 0.5 });
    } finally {
      await c.close();
    }
  });

  it("fails with UNSUPPORTED_BY_KIRO but still returns session credits", async () => {
    const c = await connect({ env: { FAKE_KIRO_NO_USAGE: "1" } });
    try {
      const id = (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;
      await c.ok("kiro_prompt", { session_id: id, text: "one" });
      const err = await c.fail("kiro_usage", { session_id: id });
      assert.equal(err.code, "UNSUPPORTED_BY_KIRO");
      assert.deepEqual(err.details.session_credits, { credit: 0.25 });
    } finally {
      await c.close();
    }
  });
});
