import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { waitFor } from "./helpers.js";
import { connect, requests, type Connected } from "./smoke-helpers.js";

const STORED = "sess_00000000-0000-4000-8000-000000000301";
const msg = (text: string, kind = "agent_message_chunk") => ({ sessionUpdate: kind, content: { type: "text", text } });

function seed(dir: string, work: string): void {
  const s = { id: STORED, cwd: work, title: "Earlier run", mode: "vibe", model: "auto", effort: "medium", autopilot: "off", context: 1, updatedAt: "2026-11-01T00:00:00Z", source: "local", executionTarget: "local", repos: [], updates: [msg("old question", "user_message_chunk"), msg("old answer")] };
  writeFileSync(join(dir, "store.json"), JSON.stringify({ sessions: { [STORED]: s } }));
}

interface Stream {
  events: { seq: number; type: string; text?: string; replay?: boolean; phase?: string; status?: string }[];
  next_cursor: number;
  gap: boolean;
  truncated: boolean;
  turn_status: string;
  session_state: string;
  uri: string;
}

async function streamUntil(c: Connected, id: string, cursor: number, done: (s: Stream) => boolean): Promise<{ events: Stream["events"]; last: Stream }> {
  const events: Stream["events"] = [];
  for (let i = 0; i < 50; i++) {
    const s = await c.ok<Stream>("kiro_stream_session", { session_id: id, cursor, wait_s: 1 });
    events.push(...s.events);
    cursor = s.next_cursor;
    if (done(s)) return { events, last: s };
  }
  throw new Error("stream condition not met");
}

describe("kiro_stream_session", () => {
  it("loads a session it did not start, replays history first, then streams live events", async () => {
    const c = await connect({ setup: (work, dir) => seed(dir, work) });
    try {
      const first = await c.ok<Stream>("kiro_stream_session", { session_id: STORED });
      assert.equal(requests(c, "session/load").length, 1);
      assert.equal(first.session_state, "attached");
      assert.deepEqual(first.events.filter((e) => e.type === "message" || e.type === "user_message").map((e) => [e.type, e.text, e.replay]), [
        ["user_message", "old question", true],
        ["message", "old answer", true],
      ]);
      assert.equal(first.uri, `kiro-session://${STORED}/transcript`);
      const again = await c.ok<Stream>("kiro_stream_session", { session_id: STORED, wait_s: 0 });
      assert.deepEqual(again.events, first.events, "same cursor, same events");

      const started = Date.now();
      await c.ok("kiro_prompt", { session_id: STORED, text: "[long:600] live", wait_s: 0 });
      const live = await c.ok<Stream>("kiro_stream_session", { session_id: STORED, cursor: first.next_cursor, wait_s: 5 });
      assert.ok(live.events.length > 0);
      assert.ok(Date.now() - started < 1_500, "new events within about a second");
      assert.ok(live.events.every((e) => e.replay !== true));
      const { last, events } = await streamUntil(c, STORED, live.next_cursor, (s) => s.turn_status === "completed");
      assert.ok(events.some((e) => e.type === "turn" && e.phase === "settled"));
      assert.equal(last.turn_status, "completed");
    } finally {
      await c.close();
    }
  });

  it("filters types and caps the page size", async () => {
    const c = await connect();
    try {
      const id = (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;
      await c.ok("kiro_prompt", { session_id: id, text: "[plan] " + "x".repeat(3_000) });
      const plans = await c.ok<Stream>("kiro_stream_session", { session_id: id, types: ["plan"], wait_s: 0 });
      assert.deepEqual(plans.events.map((e) => e.type), ["plan"]);
      const capped = await c.ok<Stream>("kiro_stream_session", { session_id: id, max_chars: 1_000, wait_s: 0 });
      assert.equal(capped.truncated, true);
      assert.ok(JSON.stringify(capped.events).length < 2_000);
    } finally {
      await c.close();
    }
  });

  it("reports a cancelled turn and then a closed session with its remaining events", async () => {
    const c = await connect();
    try {
      const id = (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;
      await c.ok("kiro_prompt", { session_id: id, text: "[long:5000] cancel me", wait_s: 0.2 });
      await c.ok("kiro_cancel", { session_id: id });
      const s = await c.ok<Stream>("kiro_stream_session", { session_id: id, wait_s: 0 });
      assert.equal(s.turn_status, "cancelled");
      assert.ok(s.events.some((e) => e.type === "turn" && e.phase === "settled" && e.status === "cancelled"));
      await c.ok("kiro_session_close", { session_id: id });
      const closed = await c.ok<Stream>("kiro_stream_session", { session_id: id, wait_s: 2 });
      assert.equal(closed.session_state, "closed");
      assert.ok(closed.events.length > 0);
      assert.equal(requests(c, "session/load").length, 0, "a closed session is not reloaded");
    } finally {
      await c.close();
    }
  });
});

describe("transcript resource", () => {
  it("lists, reads, and notifies subscribers within a second", async () => {
    const c = await connect({ setup: (work, dir) => seed(dir, work) });
    try {
      const uri = `kiro-session://${STORED}/transcript`;
      const read = await c.client.readResource({ uri });
      const body = JSON.parse(String((read.contents[0] as { text: string }).text)) as { session_id: string; events: { type: string }[] };
      assert.equal(body.session_id, STORED);
      assert.ok(body.events.some((e) => e.type === "message"));
      const list = await c.client.listResources();
      assert.ok(list.resources.some((r) => r.uri === uri));

      const updates: number[] = [];
      c.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        if (n.params.uri === uri) updates.push(Date.now());
      });
      await c.client.subscribeResource({ uri });
      const started = Date.now();
      await c.ok("kiro_prompt", { session_id: STORED, text: "notify me", wait_s: 0 });
      await waitFor(() => updates.length > 0, 3_000, "resources/updated");
      assert.ok((updates[0] ?? 0) - started < 1_000);
      await c.client.unsubscribeResource({ uri });
      const count = updates.length;
      await c.ok("kiro_prompt", { session_id: STORED, text: "quiet now" });
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(updates.length, count);
    } finally {
      await c.close();
    }
  });
});
