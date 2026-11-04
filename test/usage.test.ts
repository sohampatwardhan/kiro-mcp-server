import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolError } from "../src/errors.js";
import { normalizeUsage, UsageReader } from "../src/usage.js";

const payload = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    planName: "KIRO FREE",
    billingCycleReset: "2026-12-01",
    overagesEnabled: false,
    usageBreakdowns: [{ resourceType: "CREDIT", displayName: "Credits", used: 10, limit: 50, percentage: 20 }],
    bonusCredits: [{ name: "welcome", used: 140, total: 200, daysUntilExpiry: 30 }],
    addOnCredits: [],
    ...over,
  },
});

describe("normalizeUsage", () => {
  it("adds plan, bonus, and add-on credits into remaining_total and percent_used", () => {
    const u = normalizeUsage(payload({ addOnCredits: [{ name: "pack", used: 0, total: 50 }] }));
    assert.equal(u.plan, "KIRO FREE");
    assert.equal(u.reset_date, "2026-12-01");
    assert.deepEqual(u.breakdowns[0], { resource_type: "CREDIT", display_name: "Credits", used: 10, limit: 50, percentage: 20 });
    // used 150 of 300: 40 + 60 + 50 left.
    assert.equal(u.remaining_total, 150);
    assert.equal(u.percent_used, 50);
  });

  it("ignores breakdowns that are not credits and pools without numbers", () => {
    const u = normalizeUsage(
      payload({
        usageBreakdowns: [
          { resourceType: "CREDIT", used: 25, limit: 50 },
          { resourceType: "AGENTIC_REQUEST", used: 999, limit: 1000 },
        ],
        bonusCredits: [{ name: "odd" }],
      }),
    );
    assert.equal(u.remaining_total, 25);
    assert.equal(u.percent_used, 50);
  });

  it("never reports a negative remainder", () => {
    const u = normalizeUsage(payload({ usageBreakdowns: [{ resourceType: "CREDIT", used: 60, limit: 50 }], bonusCredits: [] }));
    assert.equal(u.remaining_total, 0);
    assert.equal(u.percent_used, 100);
  });

  it("reports null totals when no pool carries numbers", () => {
    const u = normalizeUsage({ data: { planName: "X" } });
    assert.equal(u.remaining_total, null);
    assert.equal(u.percent_used, null);
    assert.deepEqual(u.breakdowns, []);
  });

  it("maps success false to KIRO_REFUSED", () => {
    assert.throws(() => normalizeUsage({ success: false, message: "nope" }), (e: unknown) => e instanceof ToolError && e.code === "KIRO_REFUSED");
  });
});

function reader(stopPercent: number | null, answers: (() => Promise<unknown>)[]) {
  let clock = 1_000_000;
  let calls = 0;
  const r = new UsageReader(
    () => {
      calls += 1;
      const next = answers.shift();
      return next ? next() : Promise.resolve(payload());
    },
    { stopPercent, now: () => clock },
  );
  return { r, calls: () => calls, advance: (ms: number) => (clock += ms) };
}

describe("UsageReader", () => {
  it("reuses a reading for 60 s and takes a new one on refresh or expiry", async () => {
    const { r, calls, advance } = reader(null, []);
    const a = await r.read();
    assert.equal(a.cached, false);
    assert.equal(a.checked_at, new Date(1_000_000).toISOString());
    const b = await r.read();
    assert.equal(b.cached, true);
    assert.equal(b.checked_at, a.checked_at);
    assert.equal(calls(), 1);
    assert.equal((await r.read({ refresh: true })).cached, false);
    assert.equal(calls(), 2);
    advance(60_001);
    assert.equal((await r.read()).cached, false);
    assert.equal(calls(), 3);
  });

  it("shares one host request between concurrent reads", async () => {
    let release: (v: unknown) => void = () => undefined;
    const { r, calls } = reader(null, [() => new Promise((res) => (release = res))]);
    const both = Promise.all([r.read(), r.read()]);
    release(payload());
    const [a, b] = await both;
    assert.equal(calls(), 1);
    assert.equal(a.checked_at, b.checked_at);
  });

  it("does not cache a failed reading", async () => {
    const { r, calls } = reader(null, [() => Promise.reject(new Error("down"))]);
    await assert.rejects(r.read(), /down/);
    assert.equal((await r.read()).cached, false);
    assert.equal(calls(), 2);
  });

  it("reports stop_percent and blocked_by", async () => {
    const open = await reader(90, []).r.read();
    assert.equal(open.stop_percent, 90);
    assert.equal(open.blocked_by, null);
    const near = await reader(50, []).r.read();
    assert.match(near.blocked_by ?? "", /60% of credits used/);
    assert.equal((await reader(null, []).r.read()).blocked_by, null);
  });

  it("guard refuses at or above the threshold with USAGE_LIMIT_NEAR", async () => {
    const { r } = reader(60, []);
    await assert.rejects(r.guard(), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.code, "USAGE_LIMIT_NEAR");
      assert.match(e.message, /60% of credits used/);
      assert.match(e.message, /100 credits left/);
      assert.match(e.message, /2026-12-01/);
      assert.equal(e.details.percent_used, 60);
      return true;
    });
  });

  it("guard lets work go ahead below the threshold, when unset, and when usage cannot be read", async () => {
    await reader(61, []).r.guard();
    const unset = reader(null, []);
    await unset.r.guard();
    assert.equal(unset.calls(), 0, "no reading without a threshold");
    await reader(10, [() => Promise.reject(new ToolError("UNSUPPORTED_BY_KIRO", "no"))]).r.guard();
    await reader(10, [() => Promise.resolve({ success: false })]).r.guard();
  });
});
