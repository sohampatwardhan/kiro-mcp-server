import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { waitFor } from "./helpers.js";
import { connect, type Connected } from "./smoke-helpers.js";

interface Pending {
  permission_id: string;
  tool_call_id: string;
  options: { option_id: string; kind: string }[];
  consent: { capability: string } | null;
  mcp_tool: { untrusted: boolean } | null;
}
interface PromptResult {
  turn_id: string;
  status: string;
  cursor: number;
  turn: { final_text: string | null; tool_calls: { status: string; failure_reason: string | null }[] };
  pending_permissions: Pending[];
}
interface EventsResult {
  status: string;
  next_cursor: number;
  events: { type: string; policy?: string }[];
  turn: PromptResult["turn"] | null;
}

async function finish(c: Connected, id: string): Promise<EventsResult> {
  let cursor = 0;
  for (let i = 0; i < 60; i++) {
    const r = await c.ok<EventsResult>("kiro_events", { session_id: id, cursor, wait_s: 1 });
    cursor = r.next_cursor;
    if (r.status === "completed" || r.status === "failed" || r.status === "cancelled") return r;
  }
  throw new Error("turn did not finish");
}
const allEvents = async (c: Connected, id: string) => (await c.ok<EventsResult>("kiro_events", { session_id: id, cursor: 0, limit: 1000 })).events;

async function session(c: Connected): Promise<string> {
  return (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;
}

describe("permissions under the default ask policy", () => {
  it("waits for the calling agent, then returns its exact option", async () => {
    const c = await connect();
    try {
      const id = await session(c);
      const p = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[permission:write] edit", wait_s: 0.5 });
      assert.equal(p.status, "waiting_permission");
      const [pending] = p.pending_permissions;
      assert.ok(pending);
      assert.equal(pending.consent?.capability, "fs_write");
      assert.equal(pending.mcp_tool?.untrusted, true);
      assert.deepEqual(pending.options.map((o) => o.option_id), ["accept", "always-accept", "reject", "always-reject"]);
      const listed = await c.ok<{ pending: Pending[] }>("kiro_permissions", { session_id: id });
      assert.equal(listed.pending[0]?.permission_id, pending.permission_id);
      assert.equal((await c.fail("kiro_permission_respond", { permission_id: pending.permission_id, option_id: "yes-please" })).code, "OPTION_NOT_OFFERED");
      assert.equal((await c.fail("kiro_permission_respond", { permission_id: pending.permission_id, option_id: "always-accept" })).code, "PERSISTENT_CONSENT_DISABLED");
      const r = await c.ok<{ option_kind: string }>("kiro_permission_respond", { permission_id: pending.permission_id, option_id: "accept" });
      assert.equal(r.option_kind, "allow_once");
      const done = await finish(c, id);
      assert.match(done.turn?.final_text ?? "", /permission: selected:accept\]/);
      assert.equal(done.turn?.tool_calls[0]?.status, "completed");
      assert.equal((await c.fail("kiro_permission_respond", { permission_id: pending.permission_id, option_id: "accept" })).code, "PERMISSION_NOT_FOUND");
      const events = await allEvents(c, id);
      assert.ok(events.some((e) => e.type === "permission_requested"));
      assert.ok(events.some((e) => e.type === "permission_resolved" && e.policy === "caller"));
    } finally {
      await c.close();
    }
  });

  it("keeps a denial distinct from a cancellation and lets the turn continue", async () => {
    const c = await connect();
    try {
      const id = await session(c);
      const p = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[permission:write] edit", wait_s: 0.5 });
      await c.ok("kiro_permission_respond", { permission_id: p.pending_permissions[0]?.permission_id, option_id: "reject" });
      const done = await finish(c, id);
      assert.equal(done.status, "completed");
      assert.equal(done.turn?.tool_calls[0]?.failure_reason, "denied");
    } finally {
      await c.close();
    }
  });

  it("auto-rejects shell commands and refuses to approve them", async () => {
    const c = await connect();
    try {
      const id = await session(c);
      const p = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[permission:shell] run" });
      assert.equal(p.status, "completed");
      assert.match(p.turn.final_text ?? "", /permission: selected:reject\]/);
      const events = await allEvents(c, id);
      assert.ok(events.some((e) => e.type === "permission_resolved" && e.policy === "shell_disabled"));
      const permissionId = (events.find((e) => e.type === "permission_requested") as unknown as { permissionId: string }).permissionId;
      assert.equal((await c.fail("kiro_permission_respond", { permission_id: permissionId, option_id: "accept" })).code, "SHELL_APPROVAL_DISABLED");
    } finally {
      await c.close();
    }
  });

  it("sends always options with consent scope once the operator opts in", async () => {
    const c = await connect({ env: { KIRO_MCP_ALLOW_PERSISTENT_CONSENT: "1", KIRO_MCP_ALLOW_SHELL: "1" } });
    try {
      const id = await session(c);
      const p = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[permission:shell] run", wait_s: 0.5 });
      assert.equal(p.status, "waiting_permission");
      await c.ok("kiro_permission_respond", { permission_id: p.pending_permissions[0]?.permission_id, option_id: "always-accept", scope: "workspace", resource: "touch *" });
      const done = await finish(c, id);
      assert.match(done.turn?.final_text ?? "", /selected:always-accept consent=\{"scope":"workspace","resource":"touch \*"\}/);
    } finally {
      await c.close();
    }
  });

  it("rejects after the timeout", async () => {
    const c = await connect({ env: { KIRO_MCP_PERMISSION_TIMEOUT_MS: "300" } });
    try {
      const id = await session(c);
      const p = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[permission:write] edit", wait_s: 5 });
      assert.equal(p.status, "completed");
      assert.match(p.turn.final_text ?? "", /selected:reject\]/);
      assert.ok((await allEvents(c, id)).some((e) => e.type === "permission_resolved" && e.policy === "timeout"));
    } finally {
      await c.close();
    }
  });

  it("cancel answers a pending permission with reject_once and settles the turn", async () => {
    const c = await connect();
    try {
      const id = await session(c);
      await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[permission:write] [long:3000] edit", wait_s: 0.5 });
      const r = await c.ok<{ status: string }>("kiro_cancel", { session_id: id });
      assert.equal(r.status, "cancelled");
      assert.ok((await allEvents(c, id)).some((e) => e.type === "permission_resolved" && e.policy === "cancel"));
      assert.equal((await c.ok<{ pending: unknown[] }>("kiro_permissions", {})).pending.length, 0);
    } finally {
      await c.close();
    }
  });
});

describe("operator policies", () => {
  it("deny rejects every request", async () => {
    const c = await connect({ env: { KIRO_MCP_PERMISSIONS: "deny" } });
    try {
      const p = await c.ok<PromptResult>("kiro_prompt", { session_id: await session(c), text: "[permission:write] edit" });
      assert.match(p.turn.final_text ?? "", /selected:reject\]/);
    } finally {
      await c.close();
    }
  });

  it("allow approves non-shell requests once and still rejects shell", async () => {
    const c = await connect({ env: { KIRO_MCP_PERMISSIONS: "allow" } });
    try {
      const id = await session(c);
      const p = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[permission:write] edit" });
      assert.match(p.turn.final_text ?? "", /selected:accept\]/);
      const s = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[permission:shell] run" });
      assert.match(s.turn.final_text ?? "", /selected:reject\]/);
    } finally {
      await c.close();
    }
  });
});

describe("elicitation", () => {
  async function withElicit(answer: { action: string; content?: Record<string, unknown> }, env: Record<string, string> = {}) {
    const c = await connect({ capabilities: { elicitation: { form: {} } }, env });
    const asked: unknown[] = [];
    c.client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params);
      return answer as never;
    });
    return { c, asked };
  }

  it("accept answers with the chosen option", async () => {
    const { c, asked } = await withElicit({ action: "accept", content: { option: "accept" } });
    try {
      const p = await c.ok<PromptResult>("kiro_prompt", { session_id: await session(c), text: "[permission:write] edit" });
      assert.match(p.turn.final_text ?? "", /selected:accept\]/);
      assert.equal(asked.length, 1);
    } finally {
      await c.close();
    }
  });

  it("decline rejects", async () => {
    const { c } = await withElicit({ action: "decline" });
    try {
      const p = await c.ok<PromptResult>("kiro_prompt", { session_id: await session(c), text: "[permission:write] edit" });
      assert.match(p.turn.final_text ?? "", /selected:reject\]/);
    } finally {
      await c.close();
    }
  });

  it("KIRO_MCP_ELICITATION=off sends no form to a client that declines every form", async () => {
    const { c, asked } = await withElicit({ action: "decline" }, { KIRO_MCP_ELICITATION: "off", KIRO_MCP_ALLOW_SHELL: "1" });
    try {
      const status = await c.ok<{ policy: { elicitation: string; client_form_elicitation: boolean } }>("kiro_status", {});
      assert.equal(status.policy.elicitation, "off");
      assert.equal(status.policy.client_form_elicitation, true);
      const id = await session(c);
      const p = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[permission:shell] run", wait_s: 0.5 });
      assert.equal(p.status, "waiting_permission");
      const [pending] = p.pending_permissions;
      assert.ok(pending);
      await c.ok("kiro_permission_respond", { permission_id: pending.permission_id, option_id: "accept" });
      const done = await finish(c, id);
      assert.equal(done.status, "completed");
      assert.match(done.turn?.final_text ?? "", /selected:accept\]/);
      assert.equal(asked.length, 0);
    } finally {
      await c.close();
    }
  });

  it("cancel leaves it pending for kiro_permission_respond", async () => {
    const { c } = await withElicit({ action: "cancel" });
    try {
      const id = await session(c);
      const p = await c.ok<PromptResult>("kiro_prompt", { session_id: id, text: "[permission:write] edit", wait_s: 0.5 });
      const pending = await waitFor(async () => (await c.ok<{ pending: Pending[] }>("kiro_permissions", {})).pending[0], 3_000, "pending");
      assert.equal(p.status, "waiting_permission");
      await c.ok("kiro_permission_respond", { permission_id: pending.permission_id, option_id: "accept" });
      assert.equal((await finish(c, id)).status, "completed");
    } finally {
      await c.close();
    }
  });
});

describe("approvals waiting on a loaded cloud session", () => {
  it("are returned by kiro_session_load and kiro_permissions", async () => {
    const id = "sess_00000000-0000-4000-8000-000000000201";
    const c = await connect({
      env: { FAKE_KIRO_PENDING_ON_LOAD: "1", KIRO_MCP_ALLOW_SHELL: "1" },
      setup: (_work, dir) =>
        writeFileSync(
          join(dir, "store.json"),
          JSON.stringify({ sessions: { [id]: { id, cwd: "/cloud/ws", title: "cloud", mode: "vibe", model: "auto", effort: "medium", autopilot: "off", context: 1, updatedAt: "2026-11-01T00:00:00Z", source: "remote", executionTarget: "cloud-sandbox", repos: [], updates: [] } } }),
        ),
    });
    try {
      await c.ok("kiro_session_load", { session_id: id });
      const pending = await waitFor(async () => (await c.ok<{ pending: Pending[] }>("kiro_permissions", { session_id: id })).pending[0], 3_000, "pending on load");
      assert.equal(pending.consent?.capability, "shell");
      const again = await c.ok<{ pending_permissions: Pending[] }>("kiro_session_load", { session_id: id });
      assert.equal(again.pending_permissions.length, 1);
    } finally {
      await c.close();
    }
  });
});
