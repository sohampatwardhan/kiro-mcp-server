import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { connect, requests, type Connected } from "./smoke-helpers.js";

const ID = "sess_00000000-0000-4000-8000-000000000101";
const msg = (text: string, kind = "agent_message_chunk") => ({ sessionUpdate: kind, content: { type: "text", text } });
const idAssigned = (userMessageId: string) => ({ sessionUpdate: "session_info_update", _meta: { kiro: { kind: "user_message_id_assigned", userMessageId } } });

function seed(dir: string, work: string): void {
  const updates = [
    msg("first question", "user_message_chunk"),
    idAssigned("m1"),
    msg("first answer"),
    { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read", status: "completed" },
    msg("second question", "user_message_chunk"),
    idAssigned("m2"),
    msg("second answer"),
  ];
  const session = { id: ID, cwd: work, title: "Two turns", mode: "vibe", model: "auto", effort: "medium", autopilot: "off", context: 2, updatedAt: "2026-11-01T00:00:00.000Z", source: "local", executionTarget: "local", repos: [], updates };
  writeFileSync(join(dir, "store.json"), JSON.stringify({ sessions: { [ID]: session } }));
}

interface History {
  source: string;
  entries: { role: string; text?: string; title?: string }[];
  rewind_points: { message_id: string; turn_index: number; preview: string }[];
  has_more: boolean;
  next_cursor: number | null;
}

describe("kiro_session_history and kiro_session_fork", () => {
  let c: Connected;
  before(async () => {
    c = await connect({ setup: (work, dir) => seed(dir, work) });
  });
  after(() => c.close());

  it("pages _kiro/session/history and lists rewind points", async () => {
    const all = await c.ok<History>("kiro_session_history", { session_id: ID });
    assert.equal(all.source, "kiro");
    assert.deepEqual(all.entries.map((e) => [e.role, e.text ?? e.title]), [
      ["user", "first question"],
      ["agent", "first answer"],
      ["tool", "Read file"],
      ["user", "second question"],
      ["agent", "second answer"],
    ]);
    assert.deepEqual(all.rewind_points, [
      { message_id: "m1", turn_index: 1, preview: "first question" },
      { message_id: "m2", turn_index: 2, preview: "second question" },
    ]);
    const page = await c.ok<History>("kiro_session_history", { session_id: ID, limit: 3 });
    assert.equal(page.has_more, true);
    assert.equal(page.next_cursor, 3);
    const rest = await c.ok<History>("kiro_session_history", { session_id: ID, cursor: 3, limit: 10 });
    assert.equal(rest.has_more, false);
    assert.equal(rest.entries.at(-1)?.text, "second answer");
  });

  it("forks at a message id and leaves the original unchanged", async () => {
    const fork = await c.ok<{ session_id: string; parent_session_id: string; message_id: string }>("kiro_session_fork", { session_id: ID, message_id: "m2" });
    assert.notEqual(fork.session_id, ID);
    assert.equal(fork.parent_session_id, ID);
    assert.deepEqual(requests(c, "session/fork").at(-1)?.params, { sessionId: ID, _meta: { kiro: { messageId: "m2" } } });
    const forked = await c.ok<History>("kiro_session_history", { session_id: fork.session_id });
    assert.ok(forked.entries.some((e) => e.text === "first answer"));
    assert.ok(!forked.entries.some((e) => e.text === "second answer"));
    const original = await c.ok<History>("kiro_session_history", { session_id: ID });
    assert.ok(original.entries.some((e) => e.text === "second answer"));
  });

  it("forks without a message id", async () => {
    const fork = await c.ok<{ session_id: string; message_id: null }>("kiro_session_fork", { session_id: ID });
    assert.equal(fork.message_id, null);
    assert.deepEqual(requests(c, "session/fork").at(-1)?.params, { sessionId: ID });
  });
});

describe("history fallback", () => {
  it("uses the event feed when Kiro returns no history", async () => {
    const c = await connect({ env: { FAKE_KIRO_EMPTY_HISTORY: "1" }, setup: (work, dir) => seed(dir, work) });
    try {
      const r = await c.ok<History>("kiro_session_history", { session_id: ID });
      assert.equal(r.source, "feed");
      assert.ok(r.entries.some((e) => e.text === "second answer"));
    } finally {
      await c.close();
    }
  });
});
