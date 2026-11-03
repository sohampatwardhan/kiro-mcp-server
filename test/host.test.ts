import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { AcpHost, KNOWN_UNADVERTISED } from "../src/acp/host.js";
import { acpArgv, assertAcp } from "../src/argv.js";
import { ToolError } from "../src/errors.js";
import { alive, fakeKiro, readMeta, tempDir, waitFor } from "./helpers.js";

const tmp = tempDir("kiro-mcp-host-");
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

function makeHost(extraEnv: Record<string, string> = {}, bin = fakeKiro) {
  const metaPath = join(tmp, `meta-${n}.jsonl`);
  const storePath = join(tmp, `store-${n++}.json`);
  const host = new AcpHost({
    bin,
    cwd: tmp,
    requestTimeoutMs: 5_000,
    env: { ...process.env, FAKE_KIRO_META: metaPath, FAKE_KIRO_STORE: storePath, ...extraEnv },
    restartBackoffMs: 10,
  });
  return { host, meta: () => readMeta(metaPath) };
}

const codeOf = (err: unknown) => (err instanceof ToolError ? err.code : String(err));

describe("acpArgv", () => {
  it("never carries v2-only flags", () => {
    assert.deepEqual(acpArgv(), ["acp", "--agent-engine=v3", "--auth-method=cli"]);
    for (const bad of ["--agent=x", "--model=m", "--effort=high", "--trust-all-tools", "--trust-tools=a", "-a"]) {
      assert.throws(() => assertAcp([...acpArgv(), bad]));
    }
  });
});

describe("AcpHost", () => {
  it("spawns the v3 host lazily, registers handlers, then initializes", async () => {
    const { host, meta } = makeHost();
    assert.equal(host.state, "stopped");
    await host.ensureStarted();
    assert.equal(host.state, "ready");
    assert.equal(host.generation, 1);
    const start = meta().find((m) => m.kind === "start");
    assert.deepEqual(start?.argv, ["acp", "--agent-engine=v3", "--auth-method=cli"]);
    assert.equal(meta().find((m) => m.kind === "request")?.method, "initialize");
    assert.equal(host.capabilities?.loadSession, true);
    assert.deepEqual(host.kiro.executionTargets, ["local", "cloud-sandbox"]);
    await host.stop();
  });

  it("gates optional methods on the advertised list plus KNOWN_UNADVERTISED", async () => {
    const { host } = makeHost();
    await host.ensureStarted();
    assert.ok(host.supports("_kiro/memory/list"));
    for (const method of KNOWN_UNADVERTISED) assert.ok(host.supports(method), method);
    assert.ok(!host.supports("_kiro/hooks/list"));
    assert.ok(host.supports("session/new"));
    await assert.rejects(host.call("_kiro/hooks/list", {}), (err: unknown) => codeOf(err) === "UNSUPPORTED_BY_KIRO");
    await host.stop();
  });

  it("maps method-not-found, auth, and other Kiro errors", async () => {
    const { host } = makeHost({ FAKE_KIRO_NO_USAGE: "1" });
    await host.ensureStarted();
    await assert.rejects(host.call("_kiro/account/getUsage", {}), (err: unknown) => codeOf(err) === "UNSUPPORTED_BY_KIRO");
    await assert.rejects(host.call("session/set_mode", { sessionId: "sess_x", modeId: "plan", promptText: "secret prompt" }), (err: unknown) => {
      if (!(err instanceof ToolError) || err.code !== "KIRO_ERROR") return false;
      const kiro = err.details.kiro as { code: number; errorType?: string };
      return kiro.code === -32602 && kiro.errorType === "SessionNotFoundError" && !JSON.stringify(err.details).includes("secret prompt");
    });
    await host.stop();
    const signedOut = makeHost({ FAKE_KIRO_SIGNED_OUT: "1" }).host;
    await signedOut.ensureStarted();
    await assert.rejects(signedOut.call("session/new", { cwd: tmp, mcpServers: [] }), (err: unknown) => codeOf(err) === "CLI_NOT_SIGNED_IN");
    await signedOut.stop();
  });

  it("emits exited when the host crashes, fails in-flight calls, and restarts on the next call", async () => {
    const { host, meta } = makeHost();
    await host.ensureStarted();
    const exits: number[] = [];
    host.on("exited", (generation: number) => exits.push(generation));
    const created = (await host.call("session/new", { cwd: tmp, mcpServers: [] })) as { sessionId: string };
    const firstPid = meta().find((m) => m.kind === "start")?.pid ?? 0;
    await assert.rejects(
      host.call("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "[crash]" }] }, { timeoutMs: null }),
      (err: unknown) => codeOf(err) === "HOST_EXITED",
    );
    await waitFor(() => exits.length === 1, 5_000, "exit event");
    assert.equal(host.state, "exited");
    await waitFor(() => !alive(firstPid), 5_000, "crashed host reaped");
    await host.ensureStarted();
    assert.equal(host.generation, 2);
    assert.equal(meta().filter((m) => m.kind === "start").length, 2);
    // The crashed prompt is never resent.
    assert.equal(meta().filter((m) => m.method === "session/prompt").length, 1);
    await host.stop();
  });

  it("reports ENGINE_V3_UNAVAILABLE with the CLI version and the stderr reason", async () => {
    const { host } = makeHost({ FAKE_KIRO_ACP_INIT_FAIL: "1" });
    await assert.rejects(host.ensureStarted(), (err: unknown) => {
      return err instanceof ToolError && err.code === "ENGINE_V3_UNAVAILABLE" && err.message.includes("2.37.1") && err.message.includes("not available");
    });
    assert.equal(host.state, "failed");
  });

  it("reports CLI_NOT_FOUND for a missing binary", async () => {
    const { host } = makeHost({}, join(tmp, "no-such-kiro"));
    await assert.rejects(host.ensureStarted(), (err: unknown) => codeOf(err) === "CLI_NOT_FOUND");
  });

  it("stop closes stdin and the host exits", async () => {
    const { host, meta } = makeHost();
    await host.ensureStarted();
    const pid = meta().find((m) => m.kind === "start")?.pid ?? 0;
    await host.stop();
    assert.equal(host.state, "stopped");
    await waitFor(() => !alive(pid), 5_000, "host exit");
  });
});
