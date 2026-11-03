import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EventFeed, SessionNormalizer, type KiroEvent, type StateChange } from "../src/events.js";

const chunk = (text: string, kind = "agent_message_chunk") => ({ sessionUpdate: kind, content: { type: "text", text } });
const info = (kiro: Record<string, unknown>) => ({ sessionUpdate: "session_info_update", _meta: { kiro } });

function feedWith(updates: unknown[], replay = false): { feed: EventFeed; norm: SessionNormalizer; states: StateChange[] } {
  const feed = new EventFeed();
  const norm = new SessionNormalizer();
  const states: StateChange[] = [];
  for (const u of updates) {
    const out = norm.apply(u, { replay, turnId: "turn_1" });
    for (const { event, key } of out.events) feed.append(event, key);
    states.push(out.state);
  }
  return { feed, norm, states };
}

const all = (feed: EventFeed): KiroEvent[] => feed.read(0, 10_000).events;

describe("SessionNormalizer", () => {
  it("coalesces consecutive chunks into one message per segment", () => {
    const { feed } = feedWith([chunk("Hel"), chunk("lo"), { sessionUpdate: "tool_call", toolCallId: "t1", title: "x", status: "pending" }, chunk("Bye")]);
    const events = all(feed);
    assert.deepEqual(
      events.map((e) => e.type),
      ["message", "tool_call", "message"],
    );
    assert.equal((events[0] as { text: string }).text, "Hello");
    assert.equal((events[2] as { text: string }).text, "Bye");
  });

  it("re-sequences a growing message so a reader past it sees the new text", () => {
    const feed = new EventFeed();
    const norm = new SessionNormalizer();
    const push = (u: unknown) => {
      for (const { event, key } of norm.apply(u, { replay: false }).events) feed.append(event, key);
    };
    push(chunk("Hel"));
    const first = feed.read(0, 10);
    push(chunk("lo"));
    const second = feed.read(first.nextCursor, 10);
    assert.equal(second.events.length, 1);
    assert.equal((second.events[0] as { text: string }).text, "Hello");
    assert.equal(all(feed).length, 1);
  });

  it("keeps thoughts separate from messages", () => {
    const { feed } = feedWith([chunk("think ", "agent_thought_chunk"), chunk("more", "agent_thought_chunk"), chunk("answer")]);
    assert.deepEqual(
      all(feed).map((e) => [e.type, (e as { text?: string }).text]),
      [
        ["thought", "think more"],
        ["message", "answer"],
      ],
    );
  });

  it("merges tool calls by toolCallId and never by title", () => {
    const { feed, norm } = feedWith([
      { sessionUpdate: "tool_call", toolCallId: "a", title: "Run tests", kind: "execute", status: "pending", rawInput: { command: "npm test" } },
      { sessionUpdate: "tool_call", toolCallId: "b", title: "Run tests", kind: "execute", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed", rawOutput: { message: "ok" } },
    ]);
    const calls = all(feed).filter((e) => e.type === "tool_call") as Extract<KiroEvent, { type: "tool_call" }>[];
    assert.equal(calls.length, 2);
    const a = calls.find((c) => c.toolCallId === "a");
    assert.equal(a?.status, "completed");
    assert.equal(a?.kind, "execute");
    assert.deepEqual(a?.rawInput, { command: "npm test" });
    assert.match(a?.rawOutputTail ?? "", /ok/);
    assert.equal(norm.toolCall("b")?.status, "pending");
  });

  it("records failure reasons: denied, cancelled, or error", () => {
    const { feed, norm } = feedWith([
      { sessionUpdate: "tool_call", toolCallId: "d", title: "x", status: "pending" },
      { sessionUpdate: "tool_call", toolCallId: "e", title: "y", status: "pending" },
    ]);
    norm.noteDecision("d", "denied");
    for (const u of [
      { sessionUpdate: "tool_call_update", toolCallId: "d", status: "failed" },
      { sessionUpdate: "tool_call_update", toolCallId: "e", status: "failed" },
    ]) {
      for (const { event, key } of norm.apply(u, { replay: false }).events) feed.append(event, key);
    }
    const calls = all(feed) as Extract<KiroEvent, { type: "tool_call" }>[];
    assert.equal(calls.find((c) => c.toolCallId === "d")?.failureReason, "denied");
    assert.equal(calls.find((c) => c.toolCallId === "e")?.failureReason, "error");
  });

  it("types plan, mode, config, commands, context usage, steering, and turn events and reports state", () => {
    const { feed, states } = feedWith([
      { sessionUpdate: "plan", entries: [{ content: "a", status: "pending", priority: "high" }] },
      { sessionUpdate: "current_mode_update", currentModeId: "plan" },
      { sessionUpdate: "config_option_update", configOptions: [{ id: "model", currentValue: "auto" }] },
      { sessionUpdate: "available_commands_update", availableCommands: [{ name: "fetch" }] },
      info({ kind: "context_usage", usagePercentage: 12.5, summarizationThreshold: 80, breakdown: { tools: { tokens: 1 } } }),
      info({ kind: "user_message_id_assigned", userMessageId: "m1" }),
      info({ kind: "steering_queued", message: "go left" }),
      info({ kind: "turn_completion", promptTurnSummaries: [{ unit: "credit", usage: 0.5, usedTools: ["x"] }], elapsedTime: 10 }),
      info({ kind: "turn_end", stopReason: "end_turn" }),
      info({ kind: "model_fallback", message: "fell back" }),
    ]);
    const types = all(feed).map((e) => (e.type === "state" || e.type === "steering" || e.type === "notice" ? `${e.type}:${e.kind}` : e.type === "turn" ? `turn:${e.phase}` : e.type));
    assert.deepEqual(types, [
      "plan",
      "state:mode",
      "state:config",
      "state:commands",
      "state:context_usage",
      "state:user_message_id",
      "steering:queued",
      "turn:completion",
      "turn:end",
      "notice:model_fallback",
    ]);
    assert.equal(states[1]?.modeId, "plan");
    assert.deepEqual(states[3]?.commands, [{ name: "fetch" }]);
    assert.equal((states[4]?.contextUsage as { usagePercentage: number }).usagePercentage, 12.5);
    assert.equal(states[5]?.userMessageId, "m1");
    assert.deepEqual(states[7]?.credits, [{ unit: "credit", usage: 0.5, usedTools: ["x"] }]);
    assert.equal(states[7]?.elapsedMs, 10);
  });

  it("marks replayed events and keeps unknown updates", () => {
    const { feed } = feedWith([chunk("old"), { sessionUpdate: "mystery" }, { notAnUpdate: true }], true);
    const events = all(feed);
    assert.equal((events[0] as { replay?: boolean }).replay, true);
    assert.deepEqual(events.slice(1).map((e) => e.type), ["unknown", "unknown"]);
    assert.equal((events[1] as { sessionUpdate?: string }).sessionUpdate, "mystery");
  });

  it("reads replay from _meta.kiro.replay too", () => {
    const { feed } = feedWith([{ ...chunk("x"), _meta: { kiro: { replay: true } } }]);
    assert.equal((all(feed)[0] as { replay?: boolean }).replay, true);
  });
});

describe("SessionNormalizer.notification", () => {
  it("types rate limits, workflow lifecycle, and agent config errors", () => {
    const norm = new SessionNormalizer();
    const ctx = { replay: false, turnId: "turn_9" };
    const rate = norm.notification("_kiro/error/rate_limit", { sessionId: "s", message: "slow down" }, ctx);
    assert.deepEqual(rate[0]?.event, { type: "notice", kind: "rate_limit", message: "slow down", turnId: "turn_9" });
    const wf = norm.notification("_kiro/workflow/updated", { sessionId: "s", workflowId: "wf_1", status: "completed" }, ctx);
    assert.equal(wf[0]?.event.type, "workflow");
    assert.equal((wf[0]?.event as { workflowId?: string }).workflowId, "wf_1");
    assert.equal((wf[0]?.event as { status?: string }).status, "completed");
    const cfg = norm.notification("_kiro/customAgent/config_error", { sessionId: "s", path: "/a.json", error: "bad" }, ctx);
    assert.equal((cfg[0]?.event as { kind?: string }).kind, "config_error");
    assert.deepEqual(norm.notification("_kiro/mcp/status", {}, ctx), []);
  });
});

describe("EventFeed", () => {
  it("assigns increasing seq and reads after a cursor with a limit", () => {
    const feed = new EventFeed();
    for (let i = 0; i < 5; i++) feed.append({ type: "notice", kind: "rate_limit", message: String(i) });
    const page = feed.read(1, 2);
    assert.deepEqual(page.events.map((e) => e.seq), [2, 3]);
    assert.equal(page.nextCursor, 3);
    assert.equal(feed.read(5, 10).events.length, 0);
    assert.equal(feed.read(5, 10).nextCursor, 5);
  });

  it("filters while advancing the cursor past skipped events", () => {
    const feed = new EventFeed();
    feed.append({ type: "notice", kind: "rate_limit", message: "a" });
    feed.append({ type: "plan", entries: [] });
    feed.append({ type: "notice", kind: "rate_limit", message: "b" });
    const page = feed.read(0, 10, (e) => e.type === "plan");
    assert.deepEqual(page.events.map((e) => e.seq), [2]);
    assert.equal(page.nextCursor, 3);
  });

  it("drops the oldest events past the event cap and reports a gap", () => {
    const feed = new EventFeed({ maxEvents: 3, maxBytes: 1_000_000 });
    for (let i = 0; i < 5; i++) feed.append({ type: "notice", kind: "rate_limit", message: String(i) });
    assert.equal(feed.lowestCursor, 2);
    const page = feed.read(0, 10);
    assert.equal(page.gap, true);
    assert.deepEqual(page.events.map((e) => e.seq), [3, 4, 5]);
    assert.equal(feed.read(2, 10).gap, false);
  });

  it("drops the oldest events past the byte cap", () => {
    const feed = new EventFeed({ maxEvents: 100, maxBytes: 300 });
    for (let i = 0; i < 10; i++) feed.append({ type: "notice", kind: "rate_limit", message: "x".repeat(50) });
    assert.ok(feed.bytes <= 300);
    assert.ok(feed.lowestCursor > 0);
  });

  it("waitFor resolves on a new event, on timeout, and on abort", async () => {
    const feed = new EventFeed();
    setTimeout(() => feed.append({ type: "plan", entries: [] }), 20);
    assert.equal(await feed.waitFor(0, 2_000), true);
    assert.equal(await feed.waitFor(1, 30), false);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    assert.equal(await feed.waitFor(1, 2_000, controller.signal), false);
    assert.equal(await feed.waitFor(0, 10), true, "already newer");
  });
});
