import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EventFeed } from "../src/events.js";
import { TranscriptNotifier, readStream, transcriptUri } from "../src/transcript.js";

function feed(): EventFeed {
  const f = new EventFeed();
  f.append({ type: "message", text: "a".repeat(100), segment: 1 }, "message:1");
  f.append({ type: "thought", text: "hmm", segment: 2 }, "thought:2");
  f.append({ type: "tool_call", toolCallId: "t", title: "x", status: "pending" }, "tool:t");
  f.append({ type: "permission_requested", permissionId: "perm_1", toolCallId: "t" });
  f.append({ type: "message", text: "b".repeat(100), segment: 3 }, "message:3");
  return f;
}
const opts = { maxChars: 100_000, limit: 100, includeThoughts: false };

describe("readStream", () => {
  it("filters by type and still advances the cursor past skipped events", () => {
    const page = readStream(feed(), 0, { ...opts, types: ["tool_call", "permission"] });
    assert.deepEqual(page.events.map((e) => e.type), ["tool_call", "permission_requested"]);
    assert.equal(page.nextCursor, 5);
  });

  it("omits thoughts unless asked, or when types names them", () => {
    assert.equal(readStream(feed(), 0, opts).omittedThoughts, 1);
    assert.ok(readStream(feed(), 0, { ...opts, includeThoughts: true }).events.some((e) => e.type === "thought"));
    assert.ok(readStream(feed(), 0, { ...opts, types: ["thought"] }).events.some((e) => e.type === "thought"));
  });

  it("stops at max_chars and resumes at the first event left out", () => {
    const f = feed();
    const seen: number[] = [];
    let cursor = 0;
    let truncatedPages = 0;
    for (let i = 0; i < 10; i++) {
      const page = readStream(f, cursor, { ...opts, maxChars: 260 });
      for (const e of page.events) assert.ok(JSON.stringify(e).length <= 260);
      seen.push(...page.events.map((e) => e.seq));
      if (page.truncated) truncatedPages++;
      cursor = page.nextCursor;
      if (!page.truncated) break;
    }
    assert.ok(truncatedPages >= 1);
    assert.deepEqual(seen, [1, 3, 4, 5], "every non-thought event exactly once, in order");
  });

  it("clips a single event larger than max_chars so the stream makes progress", () => {
    const f = new EventFeed();
    f.append({ type: "message", text: "x".repeat(5_000), segment: 1 });
    const page = readStream(f, 0, { ...opts, maxChars: 1_000 });
    assert.equal(page.events.length, 1);
    assert.equal(page.truncated, true);
    assert.ok(JSON.stringify(page.events[0]).length <= 1_100);
    assert.equal(page.nextCursor, 1);
  });

  it("is idempotent for the same cursor and reports a gap below the lowest cursor", () => {
    const f = new EventFeed({ maxEvents: 2, maxBytes: 1_000_000 });
    for (let i = 0; i < 4; i++) f.append({ type: "notice", kind: "rate_limit", message: String(i) });
    assert.deepEqual(readStream(f, 2, opts), readStream(f, 2, opts));
    assert.equal(readStream(f, 0, opts).gap, true);
    assert.equal(readStream(f, 2, opts).gap, false);
  });
});

describe("TranscriptNotifier", () => {
  it("coalesces bursts per subscribed URI and ignores others", async () => {
    const sent: string[] = [];
    const timers: (() => void)[] = [];
    const n = new TranscriptNotifier(async (uri) => void sent.push(uri), 250, (fn) => timers.push(fn));
    const id = "sess_00000000-0000-4000-8000-000000000001";
    n.touched(id);
    assert.equal(timers.length, 0, "not subscribed");
    n.subscribe(transcriptUri(id));
    n.touched(id);
    n.touched(id);
    n.touched(id);
    assert.equal(timers.length, 1);
    timers.shift()?.();
    assert.deepEqual(sent, [transcriptUri(id)]);
    n.unsubscribe(transcriptUri(id));
    n.touched(id);
    assert.equal(timers.length, 0);
  });
});
