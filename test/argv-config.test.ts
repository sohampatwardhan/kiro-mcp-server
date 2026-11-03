import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ConfigError, LIMITS, loadConfig } from "../src/config.js";
import { ToolError, toolErrorResult } from "../src/errors.js";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "kiro-mcp-config-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

const base = { KIRO_MCP_CWD: tmp };

describe("loadConfig", () => {
  it("uses safe defaults", () => {
    const c = loadConfig(base);
    assert.equal(c.kiroBin, "kiro-cli");
    assert.equal(c.cwd, tmp);
    assert.equal(c.permissions, "ask");
    assert.equal(c.permissionTimeoutMs, 600_000);
    assert.equal(c.allowShell, false);
    assert.equal(c.allowPersistentConsent, false);
    assert.equal(c.headlessTrust, "none");
    assert.equal(c.allowTrustWorkspace, false);
    assert.equal(c.allowConfigWrites, false);
    assert.equal(c.cliTimeoutMs, 120_000);
    assert.equal(c.requestTimeoutMs, 120_000);
    assert.equal(c.headlessTimeoutMs, 3_600_000);
    assert.deepEqual(c.roots, [tmp]);
  });

  it("reads every variable", () => {
    const c = loadConfig({
      ...base,
      KIRO_BIN: "/opt/kiro-cli",
      KIRO_MCP_PERMISSIONS: "deny",
      KIRO_MCP_PERMISSION_TIMEOUT_MS: "1000",
      KIRO_MCP_ALLOW_SHELL: "yes",
      KIRO_MCP_ALLOW_PERSISTENT_CONSENT: "TRUE",
      KIRO_MCP_HEADLESS_TRUST: "tools",
      KIRO_MCP_ALLOW_TRUST_WORKSPACE: "1",
      KIRO_MCP_ALLOW_CONFIG_WRITES: "true",
      KIRO_MCP_CLI_TIMEOUT_MS: "5000",
      KIRO_MCP_REQUEST_TIMEOUT_MS: "6000",
      KIRO_MCP_HEADLESS_TIMEOUT_MS: "7000",
    });
    assert.equal(c.kiroBin, "/opt/kiro-cli");
    assert.equal(c.permissions, "deny");
    assert.equal(c.permissionTimeoutMs, 1000);
    assert.equal(c.allowShell, true);
    assert.equal(c.allowPersistentConsent, true);
    assert.equal(c.headlessTrust, "tools");
    assert.equal(c.allowTrustWorkspace, true);
    assert.equal(c.allowConfigWrites, true);
    assert.equal(c.cliTimeoutMs, 5000);
    assert.equal(c.requestTimeoutMs, 6000);
    assert.equal(c.headlessTimeoutMs, 7000);
  });

  it("treats 0, false, and no as off", () => {
    for (const v of ["0", "false", "no", "NO", ""]) {
      assert.equal(loadConfig({ ...base, KIRO_MCP_ALLOW_SHELL: v }).allowShell, false);
    }
  });

  const invalid: [string, string][] = [
    ["KIRO_MCP_PERMISSIONS", "maybe"],
    ["KIRO_MCP_PERMISSION_TIMEOUT_MS", "-1"],
    ["KIRO_MCP_PERMISSION_TIMEOUT_MS", "1.5"],
    ["KIRO_MCP_ALLOW_SHELL", "on"],
    ["KIRO_MCP_HEADLESS_TRUST", "everything"],
    ["KIRO_MCP_CLI_TIMEOUT_MS", "abc"],
    ["KIRO_MCP_REQUEST_TIMEOUT_MS", "0"],
    ["KIRO_MCP_HEADLESS_TIMEOUT_MS", "99999999999999999999"],
    ["KIRO_MCP_CWD", join(tmp, "missing")],
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}=${value} with the variable name`, () => {
      assert.throws(
        () => loadConfig({ ...base, [name]: value }),
        (err: unknown) => err instanceof ConfigError && err.message.includes(name),
      );
    });
  }

  it("fixes the documented limits", () => {
    assert.equal(LIMITS.defaultWaitS, 20);
    assert.equal(LIMITS.maxWaitS, 55);
    assert.equal(LIMITS.maxLineBytes, 16 * 1024 * 1024);
    assert.equal(LIMITS.feedEvents, 2_000);
    assert.equal(LIMITS.feedBytes, 4 * 1024 * 1024);
    assert.equal(LIMITS.promptQueue, 5);
    assert.equal(LIMITS.streamDefaultWaitS, 1);
    assert.equal(LIMITS.streamDefaultMaxChars, 20_000);
  });
});

describe("tool errors", () => {
  it("renders the documented body", () => {
    const result = toolErrorResult(new ToolError("PATH_OUTSIDE_ROOTS", "nope", { path: "/x" }));
    assert.equal(result.isError, true);
    const first = result.content[0];
    assert.ok(first !== undefined && first.type === "text");
    assert.deepEqual(JSON.parse(first.text), {
      error: { code: "PATH_OUTSIDE_ROOTS", message: "nope", details: { path: "/x" } },
    });
  });

  it("wraps unexpected errors as KIRO_ERROR without a stack", () => {
    const result = toolErrorResult(new Error("boom"));
    const first = result.content[0];
    assert.ok(first !== undefined && first.type === "text");
    const body = JSON.parse(first.text) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "KIRO_ERROR");
    assert.equal(body.error.message, "boom");
  });
});

describe("startup", () => {
  it("exits 2 and names the variable when the environment is invalid", async () => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const entry = fileURLToPath(new URL("../src/index.js", import.meta.url));
    const run = spawnSync(process.execPath, [entry], {
      env: { ...process.env, KIRO_MCP_CWD: tmp, KIRO_MCP_PERMISSIONS: "sometimes" },
      input: "",
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /KIRO_MCP_PERMISSIONS/);
    assert.equal(run.stdout, "");
  });
});
