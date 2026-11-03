import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { AcpHost } from "../src/acp/host.js";
import { ToolError } from "../src/errors.js";
import { Roots } from "../src/paths.js";
import { SessionRegistry } from "../src/sessions.js";
import { alive, fakeKiro, readMeta, tempDir, waitFor } from "./helpers.js";

const tmp = tempDir("kiro-mcp-sessions-");
after(() => rmSync(tmp, { recursive: true, force: true }));
mkdirSync(join(tmp, "extra"));

function setup() {
  const metaPath = join(tmp, `meta-${Math.random()}.jsonl`);
  const host = new AcpHost({
    bin: fakeKiro,
    cwd: tmp,
    requestTimeoutMs: 5_000,
    restartBackoffMs: 10,
    env: { ...process.env, FAKE_KIRO_META: metaPath, FAKE_KIRO_STORE: join(tmp, `store-${Math.random()}.json`) },
  });
  const registry = new SessionRegistry(host, new Roots([tmp]));
  return { host, registry, meta: () => readMeta(metaPath) };
}

describe("SessionRegistry", () => {
  it("routes updates by sessionId, including ones that arrive before attach, and caches snapshots", async () => {
    const { host, registry } = setup();
    const result = (await host.call("session/new", { cwd: tmp, mcpServers: [] })) as { sessionId: string };
    // Snapshots are sent right after the response; attach after a delay so they arrive early.
    await new Promise((r) => setTimeout(r, 50));
    const session = registry.attach(result.sessionId, result as Record<string, unknown>, { cwd: tmp, additionalDirectories: [], source: "local", executionTarget: "local" });
    assert.equal(session.commands.length, 3);
    for (const kind of ["mcp", "tools", "steering", "skills", "powers", "governance", "agent_errors"] as const) {
      assert.ok(session.snapshots.has(kind), kind);
    }
    assert.ok(session.contextUsage !== null);
    await host.stop();
  });

  it("detaches on host exit and re-attaches with session/load, resending cwd and additionalDirectories", async () => {
    const { host, registry, meta } = setup();
    const extra = join(tmp, "extra");
    const result = (await host.call("session/new", { cwd: tmp, additionalDirectories: [extra], mcpServers: [] })) as { sessionId: string };
    const session = registry.attach(result.sessionId, result as Record<string, unknown>, { cwd: tmp, additionalDirectories: [extra], source: "local", executionTarget: "local" });
    const pid = meta().find((m) => m.kind === "start")?.pid ?? 0;
    process.kill(pid, "SIGKILL");
    await waitFor(() => session.detached, 5_000, "detach");
    await waitFor(() => !alive(pid), 5_000, "reaped");
    const again = await registry.ensureAttached(result.sessionId);
    assert.equal(again, session);
    assert.equal(session.detached, false);
    assert.equal(session.hostGeneration, 2);
    const load = meta().find((m) => m.kind === "request" && m.method === "session/load");
    assert.deepEqual(load?.params, { sessionId: result.sessionId, cwd: tmp, additionalDirectories: [extra], mcpServers: [] });
    assert.equal(meta().filter((m) => m.method === "session/prompt").length, 0);
    assert.ok(session.feed.read(0, 100).events.some((e) => e.type === "notice" && e.kind === "host_exited"));
    await host.stop();
  });

  it("maps an unknown session to SESSION_NOT_FOUND on load and require", async () => {
    const { host, registry } = setup();
    const id = "sess_00000000-0000-4000-8000-000000000000";
    await assert.rejects(registry.load(id, { cwd: tmp, additionalDirectories: [], source: "local", executionTarget: "local" }), (err: unknown) => err instanceof ToolError && err.code === "SESSION_NOT_FOUND");
    assert.throws(() => registry.require(id), (err: unknown) => err instanceof ToolError && err.code === "SESSION_NOT_FOUND");
    await host.stop();
  });
});
