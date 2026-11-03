import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { connect, type Connected } from "./smoke-helpers.js";

const cliCalls = (c: Connected, first: string) => c.meta().filter((m) => m.kind === "start" && m.argv?.[0] === first);

function seed(work: string): void {
  mkdirSync(join(work, "agents"));
  writeFileSync(join(work, "agents", "good.json"), '{"name":"good"}');
  writeFileSync(join(work, "agents", "bad.json"), '{"name":"invalid"}');
  mkdirSync(join(work, "my-power"));
}

describe("config tools, read actions", () => {
  it("lists agents, validates configs, lists MCP config and settings, and reads powers", async () => {
    const c = await connect({ setup: seed });
    try {
      const id = (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;
      const agents = await c.ok<{ agents: { id: string; source: string }[]; errors: { path: string }[] }>("kiro_agents", { action: "list", session_id: id });
      assert.deepEqual(agents.agents.map((a) => [a.id, a.source]), [["reviewer-agent", "workspace"]]);
      assert.equal(agents.errors[0]?.path, "/home/dev/.kiro/agents/broken.json");
      const good = await c.ok<{ valid: boolean }>("kiro_agents", { action: "validate", path: "agents/good.json" });
      assert.equal(good.valid, true);
      const bad = await c.ok<{ valid: boolean; output: string }>("kiro_agents", { action: "validate", path: "agents/bad.json" });
      assert.equal(bad.valid, false);
      assert.ok(!bad.output.includes("\u001b"));
      assert.equal((await c.fail("kiro_agents", { action: "validate", path: "/etc/passwd" })).code, "PATH_OUTSIDE_ROOTS");

      const mcp = await c.ok<{ servers: { name: string; scope: string }[]; raw: string }>("kiro_mcp_config", { action: "list" });
      assert.deepEqual(mcp.servers.map((s) => s.name), ["docs", "fetch", "local-tools"]);
      assert.ok(!mcp.raw.includes("\u001b"));
      const status = await c.ok<{ status: Record<string, string> }>("kiro_mcp_config", { action: "status", name: "docs" });
      assert.equal(status.status.scope, "global");

      const settings = await c.ok<{ settings: Record<string, unknown> }>("kiro_settings", { action: "list" });
      assert.equal(settings.settings["chat.defaultModel"], "auto");
      const all = await c.ok<{ settings: Record<string, unknown> }>("kiro_settings", { action: "get", keys: ["chat.autoCompactionThreshold", "missing.key"] });
      assert.deepEqual(all.settings, { "chat.autoCompactionThreshold": 80, "missing.key": null });

      const powers = await c.ok<{ powers: { received: boolean; powers: { name: string }[] } }>("kiro_powers", { action: "list", session_id: id });
      assert.equal(powers.powers.powers[0]?.name, "context7");
    } finally {
      await c.close();
    }
  });
});

describe("config tools, write gates", () => {
  const writes: [string, Record<string, unknown>][] = [
    ["kiro_agents", { action: "create", name: "helper" }],
    ["kiro_agents", { action: "set_default", name: "helper" }],
    ["kiro_agents", { action: "upgrade", directory: "agents" }],
    ["kiro_mcp_config", { action: "add", name: "docs2", url: "https://docs.example.dev/mcp" }],
    ["kiro_mcp_config", { action: "remove", name: "docs" }],
    ["kiro_settings", { action: "set", key: "chat.defaultModel", value: "auto" }],
    ["kiro_settings", { action: "delete", key: "chat.defaultModel" }],
    ["kiro_powers", { action: "install", name_or_path: "context7" }],
    ["kiro_powers", { action: "uninstall", name_or_path: "context7" }],
  ];

  it("refuses every write without the opt-in and runs nothing", async () => {
    const c = await connect({ setup: seed });
    try {
      for (const [tool, args] of writes) assert.equal((await c.fail(tool, args)).code, "CONFIG_WRITES_DISABLED", `${tool} ${String(args.action)}`);
      for (const first of ["agent", "mcp", "settings", "powers"]) assert.equal(cliCalls(c, first).length, 0, first);
    } finally {
      await c.close();
    }
  });

  it("runs every write with the opt-in and notes when it applies", async () => {
    const c = await connect({ setup: seed, env: { KIRO_MCP_ALLOW_CONFIG_WRITES: "1" } });
    try {
      for (const [tool, args] of writes) {
        const r = await c.ok<{ note: string }>(tool, args);
        assert.match(r.note, /hot reload/);
      }
      assert.deepEqual(cliCalls(c, "settings").at(-1)?.argv, ["settings", "--delete", "--", "chat.defaultModel"]);
      assert.deepEqual(cliCalls(c, "agent").at(-1)?.argv, ["agent", "upgrade", "--", join(c.work, "agents")]);
      await c.ok("kiro_powers", { action: "install", name_or_path: "./my-power" });
      assert.deepEqual(cliCalls(c, "powers").at(-1)?.argv, ["powers", "install", "--", join(c.work, "my-power")]);
    } finally {
      await c.close();
    }
  });

  it("withholds stdio MCP servers, non-HTTPS URLs, and sensitive settings even with the opt-in", async () => {
    const c = await connect({ setup: seed, env: { KIRO_MCP_ALLOW_CONFIG_WRITES: "1" } });
    try {
      assert.equal((await c.fail("kiro_mcp_config", { action: "add", name: "sh", command: "sh" })).code, "STDIO_SERVER_WITHHELD");
      assert.equal((await c.fail("kiro_mcp_config", { action: "add", name: "x", url: "http://evil.example.com/mcp" })).code, "VALUE_NOT_ADVERTISED");
      assert.equal((await c.call("kiro_mcp_config", { action: "add", name: "x", url: "http://localhost:7000/mcp" })).isError, false);
      for (const key of ["chat.agentEngine", "acp.agentEngine", "auth.accessToken", "github.apiKey", "db.password", "client.secret"]) {
        assert.equal((await c.fail("kiro_settings", { action: "set", key, value: "x" })).code, "SETTING_WITHHELD", key);
      }
      assert.equal((await c.fail("kiro_powers", { action: "install", name_or_path: "/etc" })).code, "PATH_OUTSIDE_ROOTS");
    } finally {
      await c.close();
    }
  });
});
