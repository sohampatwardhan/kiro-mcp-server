import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { waitFor } from "./helpers.js";
import { connect, requests, type Connected } from "./smoke-helpers.js";

interface TurnView {
  turn_id: string;
  status: string;
  stop_reason: string | null;
  final_text: string | null;
  tool_calls: unknown[];
  credits: { unit?: string; usage?: number }[];
  elapsed_ms: number | null;
  error: { code: string; message: string } | null;
}
interface PromptResult {
  turn_id: string;
  status: string;
  queued: boolean;
  cursor: number;
  turn: TurnView;
}
interface EventsResult {
  events: { seq: number; type: string; text?: string; phase?: string; turnId?: string }[];
  next_cursor: number;
  status: string;
  turn: TurnView | null;
  omitted_thoughts: number;
}

async function newSession(c: Connected): Promise<string> {
  return (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;
}

/** Poll kiro_events until the turn status is final. */
async function pollUntilDone(c: Connected, sessionId: string, cursor: number): Promise<{ events: EventsResult["events"]; last: EventsResult }> {
  const events: EventsResult["events"] = [];
  for (let i = 0; i < 100; i++) {
    const r = await c.ok<EventsResult>("kiro_events", { session_id: sessionId, cursor, wait_s: 2 });
    events.push(...r.events);
    cursor = r.next_cursor;
    if (["completed", "cancelled", "failed"].includes(r.status)) return { events, last: r };
  }
  throw new Error("turn never finished");
}

describe("kiro_prompt and kiro_events", () => {
  let c: Connected;
  before(async () => {
    c = await connect();
  });
  after(() => c.close());

  it("returns the finished turn with final text and credits when it settles within wait_s", async () => {
    const id = await newSession(c);
    const r = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "hello kiro" });
    assert.equal(r.status, "completed");
    assert.equal(r.turn.stop_reason, "end_turn");
    assert.equal(r.turn.final_text, "Echo: hello kiro");
    assert.deepEqual(r.turn.credits, [{ unit: "credit", usage: 0.25, usedTools: [] }]);
    assert.equal(r.turn.elapsed_ms, 42);
    const sent = requests(c, "session/prompt").at(-1)?.params as { prompt: unknown[] };
    assert.deepEqual(sent.prompt, [{ type: "text", text: "hello kiro" }]);
  });

  it("settles only from the prompt response, not from turn_end", async () => {
    const id = await newSession(c);
    // The fake sends turn_end, then answers the prompt 400 ms later.
    const r = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[slow-response] hi", wait_s: 0.2 });
    assert.equal(r.status, "running");
    const events = await c.ok<EventsResult>("kiro_events", { session_id: id, cursor: 0 });
    if (events.events.some((e) => e.type === "turn" && e.phase === "end")) assert.notEqual(events.status, "completed");
    const done = await pollUntilDone(c, id, events.next_cursor);
    assert.equal(done.last.status, "completed");
  });

  it("supports prompt-then-poll on a long turn", async () => {
    const id = await newSession(c);
    const r = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[long:800] work", wait_s: 0 });
    assert.equal(r.status, "running");
    assert.match(r.turn_id, /^turn_[0-9a-f]{16}$/);
    const { events, last } = await pollUntilDone(c, id, r.cursor);
    assert.equal(last.turn?.turn_id, r.turn_id);
    assert.match(last.turn?.final_text ?? "", /tick0/);
    assert.ok(events.some((e) => e.type === "message" && e.turnId === r.turn_id));
    assert.ok(events.some((e) => e.type === "turn" && e.phase === "settled"));
  });

  it("rejects a second prompt with TURN_ACTIVE, or queues it", async () => {
    const id = await newSession(c);
    await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[long:600] first", wait_s: 0 });
    assert.equal((await c.fail("kiro_prompt", { session_id: id, text: "second" })).code, "TURN_ACTIVE");
    const queued = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "second", when_busy: "queue", wait_s: 0 });
    assert.equal(queued.queued, true);
    assert.equal(queued.status, "queued");
    await waitFor(async () => (await c.ok<EventsResult>("kiro_events", { session_id: id, cursor: 0 })).turn?.turn_id === queued.turn_id, 10_000, "queued turn to start");
    const { last } = await pollUntilDone(c, id, 0);
    assert.equal(last.turn?.final_text, "Echo: second");
    assert.equal(requests(c, "session/prompt").filter((m) => (m.params as { sessionId: string }).sessionId === id).length, 2);
  });

  it("caps the queue", async () => {
    const id = await newSession(c);
    await c.ok("kiro_prompt", { session_id: id, text: "[long:1500] busy", wait_s: 0 });
    for (let i = 0; i < 5; i++) await c.ok("kiro_prompt", { session_id: id, text: `q${i}`, when_busy: "queue", wait_s: 0 });
    assert.equal((await c.fail("kiro_prompt", { session_id: id, text: "q5", when_busy: "queue" })).code, "QUEUE_FULL");
  });

  it("sends MCP progress notifications while waiting", async () => {
    const id = await newSession(c);
    const progress: unknown[] = [];
    const r = await c.call<PromptResult>("kiro_prompt", { session_id: id, text: "[long:700] p", wait_s: 5 }, { onprogress: (p) => progress.push(p) });
    assert.equal(r.body.status, "completed");
    assert.ok(progress.length >= 2, `got ${progress.length} progress notifications`);
  });

  it("stops waiting when the client cancels, without cancelling the Kiro turn", async () => {
    const id = await newSession(c);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(c.call("kiro_prompt", { session_id: id, text: "[long:600] keep going", wait_s: 10 }, { signal: controller.signal }));
    assert.equal(c.meta().filter((m) => m.method === "session/cancel").length, 0);
    const { last } = await pollUntilDone(c, id, 0);
    assert.equal(last.status, "completed");
  });

  it("omits thoughts unless asked and reports how many", async () => {
    const id = await newSession(c);
    const r = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[thought] think" });
    const hidden = await c.ok<EventsResult>("kiro_events", { session_id: id, cursor: 0 });
    assert.ok(!hidden.events.some((e) => e.type === "thought"));
    assert.equal(hidden.omitted_thoughts, 1);
    const shown = await c.ok<EventsResult>("kiro_events", { session_id: id, cursor: 0, include_thoughts: true });
    assert.equal(shown.events.find((e) => e.type === "thought")?.text, "Thinking hard");
    void r;
  });

  it("keeps rate-limit, plan, and unknown updates as typed events", async () => {
    const id = await newSession(c);
    await c.ok("kiro_prompt", { session_id: id, text: "[ratelimit] [plan] [unknown] [fallback] go" });
    const r = await c.ok<EventsResult>("kiro_events", { session_id: id, cursor: 0, limit: 500 });
    const types = r.events.map((e) => e.type);
    for (const t of ["notice", "plan", "unknown"]) assert.ok(types.includes(t), t);
  });

  it("counts invalid host lines and keeps the connection open", async () => {
    const id = await newSession(c);
    const r = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[garbage] still fine" });
    assert.equal(r.status, "completed");
  });

  it("answers unsupported agent-to-client requests with an error so Kiro never waits", async () => {
    const id = await newSession(c);
    const r = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[client-requests] x" });
    assert.match(r.turn.final_text ?? "", /client errors: -32601,-32601,-32601/);
  });

  it("rejects input without text or command, and unknown properties", async () => {
    const id = await newSession(c);
    assert.equal((await c.call("kiro_prompt", { session_id: id })).isError, true);
    assert.equal((await c.call("kiro_prompt", { session_id: id, text: "x", flags: "--trust-all-tools" })).isError, true);
  });
});

describe("host crash mid-turn", () => {
  it("fails the running turn with HOST_EXITED, never resends it, and re-attaches on the next call", async () => {
    const c = await connect();
    try {
      const id = await newSession(c);
      const r = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[crash] boom", wait_s: 10 });
      assert.equal(r.status, "failed");
      assert.equal(r.turn.error?.code, "HOST_EXITED");
      const next = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "after crash" });
      assert.equal(next.status, "completed");
      assert.equal(requests(c, "session/load").length, 1);
      const prompts = requests(c, "session/prompt").map((m) => ((m.params as { prompt: { text: string }[] }).prompt[0]?.text));
      assert.deepEqual(prompts, ["[crash] boom", "after crash"]);
      assert.equal(c.meta().filter((m) => m.kind === "start" && m.argv?.[0] === "acp").length, 2);
    } finally {
      await c.close();
    }
  });
});
