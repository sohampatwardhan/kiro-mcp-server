import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ArgvError, subcommandArgv } from "../src/argv.js";
import { runChecked, runCli } from "../src/cli.js";
import { ToolError } from "../src/errors.js";
import { cleanTerminalText } from "../src/parse.js";
import { cliNotFoundMessage, findCli, isSignInError, parseVersion } from "../src/prereq.js";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "kiro-mcp-cli-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

function script(name: string, body: string): string {
  const path = join(tmp, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("subcommandArgv", () => {
  it("builds fixed argv with values attached", () => {
    assert.deepEqual(subcommandArgv({ cmd: "whoami" }), ["whoami", "--format=json"]);
    assert.deepEqual(subcommandArgv({ cmd: "doctor_all" }), ["doctor", "--all"]);
    assert.deepEqual(subcommandArgv({ cmd: "list_models" }), ["chat", "--list-models", "--format=json"]);
    assert.deepEqual(subcommandArgv({ cmd: "settings_list", all: true }), ["settings", "list", "--format=json", "--all"]);
    assert.deepEqual(subcommandArgv({ cmd: "agent_validate", path: "/w/a.json" }), ["agent", "validate", "--path=/w/a.json"]);
    assert.deepEqual(subcommandArgv({ cmd: "mcp_status", name: "docs" }), ["mcp", "status", "--name=docs"]);
    assert.deepEqual(
      subcommandArgv({ cmd: "mcp_add", name: "docs", url: "https://x.dev/mcp", scope: "workspace", force: true }),
      ["mcp", "add", "--name=docs", "--url=https://x.dev/mcp", "--scope=workspace", "--force"],
    );
  });

  it("puts positional values after --, so a leading dash is never a flag", () => {
    assert.deepEqual(subcommandArgv({ cmd: "settings_set", key: "chat.defaultModel", value: "--trust-all-tools" }), [
      "settings",
      "--",
      "chat.defaultModel",
      "--trust-all-tools",
    ]);
    assert.deepEqual(subcommandArgv({ cmd: "powers_install", nameOrPath: "-x" }), ["powers", "install", "--", "-x"]);
    assert.deepEqual(subcommandArgv({ cmd: "agent_upgrade", directory: "/w/agents" }), ["agent", "upgrade", "--", "/w/agents"]);
  });

  it("refuses names and keys that do not match their patterns", () => {
    assert.throws(() => subcommandArgv({ cmd: "agent_set_default", name: "-rf" }), ArgvError);
    assert.throws(() => subcommandArgv({ cmd: "settings_delete", key: "a b" }), ArgvError);
    assert.throws(() => subcommandArgv({ cmd: "mcp_status", name: "--all" }), ArgvError);
  });
});

describe("runCli", () => {
  it("captures output and passes stdin", async () => {
    const bin = script("echo.mjs", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write('got:'+d);process.stderr.write('\\u001b[31mred\\u001b[0m');});");
    const result = await runCli(bin, [], { timeoutMs: 5_000, cwd: tmp, stdin: "hello" });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "got:hello");
    assert.equal(cleanTerminalText(result.stderr), "red");
  });

  it("kills the process group on timeout and reports TIMEOUT", async () => {
    const bin = script("hang.mjs", "setInterval(() => {}, 1000);");
    await assert.rejects(runChecked(bin, ["x"], { timeoutMs: 200, cwd: tmp }), (err: unknown) => err instanceof ToolError && err.code === "TIMEOUT");
  });

  it("maps a missing binary to CLI_NOT_FOUND with the install command", async () => {
    await assert.rejects(runCli(join(tmp, "missing-kiro"), [], { timeoutMs: 1_000, cwd: tmp }), (err: unknown) => {
      return err instanceof ToolError && err.code === "CLI_NOT_FOUND" && err.message.includes("cli.kiro.dev/install");
    });
  });

  it("maps sign-in failures and other exits", async () => {
    const signedOut = script("signed-out.mjs", "process.stderr.write('error: You are not logged in, please run kiro-cli login'); process.exit(1);");
    await assert.rejects(runChecked(signedOut, [], { timeoutMs: 5_000, cwd: tmp }), (err: unknown) => err instanceof ToolError && err.code === "CLI_NOT_SIGNED_IN");
    const failing = script("fail.mjs", "process.stderr.write('bad flag'); process.exit(2);");
    await assert.rejects(runChecked(failing, ["x"], { timeoutMs: 5_000, cwd: tmp }), (err: unknown) => {
      return err instanceof ToolError && err.code === "CLI_EXIT" && (err.details.cli as { stderrTail: string }).stderrTail === "bad flag";
    });
  });
});

describe("prereq", () => {
  it("finds binaries by path or on PATH", () => {
    const bin = script("kiro-cli", "");
    assert.equal(findCli(bin), bin);
    assert.equal(findCli("kiro-cli", { PATH: tmp }), bin);
    assert.equal(findCli("kiro-cli", { PATH: join(tmp, "nope") }), null);
  });

  it("parses versions and sign-in text", () => {
    assert.equal(parseVersion("kiro-cli 2.37.1\n"), "2.37.1");
    assert.equal(parseVersion("nothing"), null);
    assert.ok(isSignInError("Not signed in. Run kiro-cli login"));
    assert.ok(!isSignInError("all good"));
    assert.match(cliNotFoundMessage("kiro-cli"), /brew install kiro-cli/);
  });
});
