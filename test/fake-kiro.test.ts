// Checks the fake kiro-cli itself, so other suites can rely on its contract.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, describe, it } from "node:test";

import { fakeKiro, readMeta, tempDir } from "./helpers.js";

const tmp = tempDir("kiro-mcp-fake-");
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("fake kiro-cli", () => {
  it("refuses v2-only flags on acp, as the real CLI does", () => {
    for (const flag of ["--agent=x", "--model=y", "--effort=high", "--trust-all-tools", "--trust-tools=a"]) {
      const run = spawnSync(fakeKiro, ["acp", "--agent-engine=v3", flag], { encoding: "utf8" });
      assert.equal(run.status, 2, flag);
    }
  });

  it("speaks NDJSON JSON-RPC and creates a session", async () => {
    const metaPath = join(tmp, "meta.jsonl");
    const child = spawn(fakeKiro, ["acp", "--agent-engine=v3", "--auth-method=cli"], {
      env: { ...process.env, FAKE_KIRO_META: metaPath, FAKE_KIRO_STORE: join(tmp, "store.json") },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const lines = createInterface({ input: child.stdout });
    const messages: Record<string, unknown>[] = [];
    lines.on("line", (l) => messages.push(JSON.parse(l) as Record<string, unknown>));
    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");
    const reply = async (id: number) => {
      for (let i = 0; i < 200; i++) {
        const hit = messages.find((m) => m.id === id);
        if (hit) return hit as { result?: Record<string, unknown>; error?: unknown };
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no reply ${id}`);
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    const init = await reply(1);
    assert.equal((init.result?.agentCapabilities as { loadSession: boolean }).loadSession, true);
    send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: tmp, mcpServers: [] } });
    const created = await reply(2);
    assert.match(String(created.result?.sessionId), /^sess_/);
    send({ jsonrpc: "2.0", id: 3, method: "_kiro/nope", params: {} });
    assert.equal(((await reply(3)).error as { code: number }).code, -32601);
    child.stdin.end();
    await new Promise((r) => child.once("exit", r));
    assert.ok(readMeta(metaPath).some((m) => m.method === "session/new"));
  });

  it("runs headless with the prompt on stdin and refuses a positional prompt", () => {
    const base = ["chat", "--v3", "--no-interactive", "--output-format=stream-json"];
    const run = spawnSync(fakeKiro, base, { input: "hi there", encoding: "utf8" });
    assert.equal(run.status, 0);
    const lines = run.stdout.trim().split("\n").map((l) => JSON.parse(l) as { type: string; data: { finalText?: string } });
    assert.equal(lines[0]?.type, "runStarted");
    assert.equal(lines.at(-1)?.type, "runFinished");
    assert.equal(lines.at(-1)?.data.finalText, "Headless: hi there");
    assert.equal(spawnSync(fakeKiro, [...base, "do it"], { input: "", encoding: "utf8" }).status, 2);
  });
});
