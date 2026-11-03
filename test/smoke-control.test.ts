import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { connect, requests, type Connected } from "./smoke-helpers.js";

interface PromptResult {
  turn_id: string;
  status: string;
  cursor: number;
}
interface CancelResult {
  status: string;
  turn: { turn_id: string; status: string; stop_reason: string | null } | null;
}

describe("kiro_steer and kiro_cancel", () => {
  let c: Connected;
  before(async () => {
    c = await connect();
  });
  after(() => c.close());

  const newSession = async () => (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;

  it("steers a running turn and records the steering events", async () => {
    const id = await newSession();
    const p = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[long:600] work", wait_s: 0.1 });
    const s = await c.ok<{ accepted: boolean; turn_id: string }>("kiro_steer", { session_id: id, text: "go left" });
    assert.equal(s.accepted, true);
    assert.equal(s.turn_id, p.turn_id);
    assert.deepEqual(requests(c, "_session/steer").at(-1)?.params, { sessionId: id, message: "go left" });
    let final: { status: string; turn: { final_text: string | null } | null; events: { type: string; kind?: string }[] } | undefined;
    const kinds = new Set<string>();
    let cursor = 0;
    for (let i = 0; i < 40; i++) {
      const page: NonNullable<typeof final> & { next_cursor: number } = await c.ok("kiro_events", { session_id: id, cursor, wait_s: 1 });
      final = page;
      for (const e of page.events) if (e.type === "steering") kinds.add(e.kind ?? "");
      cursor = page.next_cursor;
      if (page.status === "completed") break;
    }
    assert.equal(final?.status, "completed");
    assert.match(final?.turn?.final_text ?? "", /steered: go left/);
    assert.deepEqual([...kinds].sort(), ["injected", "queued"]);
  });

  it("refuses to steer an idle session and sends nothing", async () => {
    const id = await newSession();
    const before = requests(c, "_session/steer").length;
    assert.equal((await c.fail("kiro_steer", { session_id: id, text: "hello?" })).code, "NO_ACTIVE_TURN");
    assert.equal(requests(c, "_session/steer").length, before);
  });

  it("cancels a running turn, waits for the prompt response, and returns the settled turn", async () => {
    const id = await newSession();
    const p = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[long:5000] long job", wait_s: 0.1 });
    const r = await c.ok<CancelResult>("kiro_cancel", { session_id: id });
    assert.equal(r.status, "cancelled");
    assert.equal(r.turn?.turn_id, p.turn_id);
    assert.equal(r.turn?.stop_reason, "cancelled");
    assert.ok(c.meta().some((m) => m.kind === "notification" && m.method === "session/cancel"));
    const after = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "still usable" });
    assert.equal(after.status, "completed");
  });

  it("reports idle when there is nothing to cancel", async () => {
    const id = await newSession();
    const r = await c.ok<CancelResult>("kiro_cancel", { session_id: id });
    assert.equal(r.status, "idle");
    assert.equal(r.turn, null);
  });

  it("drops queued prompts on cancel", async () => {
    const id = await newSession();
    await c.ok("kiro_prompt", { session_id: id, text: "[long:5000] one", wait_s: 0 });
    const q = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "two", when_busy: "queue", wait_s: 0 });
    await c.ok("kiro_cancel", { session_id: id });
    await new Promise((r) => setTimeout(r, 200));
    const prompts = requests(c, "session/prompt").filter((m) => (m.params as { sessionId: string }).sessionId === id);
    assert.equal(prompts.length, 1);
    void q;
  });

  it("closing a session cancels its running turn", async () => {
    const id = await newSession();
    await c.ok("kiro_prompt", { session_id: id, text: "[long:5000] busy", wait_s: 0 });
    await c.ok("kiro_session_close", { session_id: id });
    const cancels = c.meta().filter((m) => m.method === "session/cancel" && (m.params as { sessionId: string }).sessionId === id);
    assert.equal(cancels.length, 1);
  });
});
