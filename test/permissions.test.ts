import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RequestPermissionParams } from "../src/acp/types.js";
import { ToolError } from "../src/errors.js";
import { PermissionBroker, decideByPolicy, type BrokerConfig, type PendingPermission } from "../src/permissions.js";

const ALL_OPTIONS = [
  { optionId: "accept", name: "Allow", kind: "allow_once" as const },
  { optionId: "always-accept", name: "Always allow", kind: "allow_always" as const },
  { optionId: "reject", name: "Deny", kind: "reject_once" as const },
  { optionId: "always-reject", name: "Always deny", kind: "reject_always" as const },
];

function request(capability: string | undefined, opts: { options?: typeof ALL_OPTIONS; kind?: string } = {}): RequestPermissionParams {
  return {
    sessionId: "sess_1",
    toolCall: { toolCallId: `tc_${Math.random()}`, title: "run it", ...(opts.kind ? { kind: opts.kind } : {}) },
    options: opts.options ?? ALL_OPTIONS,
    _meta: { kiro: { ...(capability ? { consent: { capability, resource: "touch x", workspaceRoot: "/w" } } : {}), mcpTool: { serverName: "evil", annotations: { readOnlyHint: true } } } },
  };
}

const cfg = (over: Partial<BrokerConfig> = {}): BrokerConfig => ({
  permissions: "ask",
  allowShell: false,
  allowPersistentConsent: false,
  permissionTimeoutMs: 60_000,
  ...over,
});

function pendingFrom(params: RequestPermissionParams): PendingPermission {
  return new PermissionBroker(cfg()).record(params);
}

describe("decideByPolicy", () => {
  const cases: [string, Partial<BrokerConfig>, string | undefined, string | undefined, string][] = [
    ["ask leaves non-shell pending", {}, "fs_write", undefined, "pending"],
    ["ask auto-rejects shell when shell is disabled", {}, "shell", undefined, "answer:reject:shell_disabled"],
    ["ask auto-rejects execute kind without consent", {}, undefined, "execute", "answer:reject:shell_disabled"],
    ["ask leaves shell pending when allowed", { allowShell: true }, "shell", undefined, "pending"],
    ["deny rejects everything", { permissions: "deny" }, "fs_write", undefined, "answer:reject:deny"],
    ["allow approves non-shell once", { permissions: "allow" }, "fs_write", undefined, "answer:accept:allow"],
    ["allow still rejects shell without the opt-in", { permissions: "allow" }, "shell", undefined, "answer:reject:shell_disabled"],
    ["allow approves shell with the opt-in", { permissions: "allow", allowShell: true }, "shell", undefined, "answer:accept:allow"],
  ];
  for (const [label, over, capability, kind, expected] of cases) {
    it(label, () => {
      const d = decideByPolicy(pendingFrom(request(capability, kind ? { kind } : {})), cfg(over));
      const got = d.kind === "answer" ? `answer:${d.optionId}:${d.policy}` : d.kind;
      assert.equal(got, expected);
    });
  }

  it("cancels instead of synthesizing a reject option that was not offered", () => {
    const d = decideByPolicy(pendingFrom(request("shell", { options: [ALL_OPTIONS[0]!] })), cfg());
    assert.equal(d.kind, "cancelled");
  });

  it("stays pending under allow when no allow_once is offered", () => {
    const d = decideByPolicy(pendingFrom(request("fs_write", { options: [ALL_OPTIONS[2]!] })), cfg({ permissions: "allow" }));
    assert.equal(d.kind, "pending");
  });
});

describe("PermissionBroker", () => {
  it("records options exactly, consent fields, and untrusted MCP identity", async () => {
    const broker = new PermissionBroker(cfg());
    const params = request("fs_write");
    void broker.handle(params);
    const [p] = broker.list();
    assert.ok(p);
    assert.match(p.permissionId, /^perm_[0-9a-f]{16}$/);
    assert.deepEqual(p.options, ALL_OPTIONS);
    assert.equal(p.consent?.capability, "fs_write");
    assert.equal(p.mcpTool?.serverName, "evil");
  });

  it("returns exactly the chosen option", async () => {
    const broker = new PermissionBroker(cfg());
    const outcome = broker.handle(request("fs_write"));
    const [p] = broker.list();
    broker.respond(p!.permissionId, "accept", {});
    assert.deepEqual(await outcome, { outcome: { outcome: "selected", optionId: "accept" } });
    assert.equal(broker.list().length, 0);
  });

  it("refuses options that were not offered and unknown permissions", () => {
    const broker = new PermissionBroker(cfg());
    void broker.handle(request("fs_write", { options: [ALL_OPTIONS[0]!, ALL_OPTIONS[2]!] }));
    const [p] = broker.list();
    assert.throws(() => broker.respond(p!.permissionId, "always-accept", {}), (e: unknown) => e instanceof ToolError && e.code === "OPTION_NOT_OFFERED");
    assert.throws(() => broker.respond("perm_0000000000000000", "accept", {}), (e: unknown) => e instanceof ToolError && e.code === "PERMISSION_NOT_FOUND");
  });

  it("gates allow_always on the persistent consent opt-in and accepts reject_always without it", async () => {
    const off = new PermissionBroker(cfg());
    void off.handle(request("fs_write"));
    const [p] = off.list();
    assert.throws(() => off.respond(p!.permissionId, "always-accept", {}), (e: unknown) => e instanceof ToolError && e.code === "PERSISTENT_CONSENT_DISABLED");
    const outcome = off.handle(request("fs_write"));
    const second = off.list().at(-1)!;
    off.respond(second.permissionId, "always-reject", { scope: "workspace" });
    assert.deepEqual(await outcome, { outcome: { outcome: "selected", optionId: "always-reject" }, _meta: { kiro: { consent: { scope: "workspace", resource: "touch x" } } } });

    const on = new PermissionBroker(cfg({ allowPersistentConsent: true }));
    const o2 = on.handle(request("fs_write"));
    on.respond(on.list()[0]!.permissionId, "always-accept", { scope: "user", resource: "touch *" });
    assert.deepEqual(await o2, { outcome: { outcome: "selected", optionId: "always-accept" }, _meta: { kiro: { consent: { scope: "user", resource: "touch *" } } } });
  });

  it("auto-rejects shell and refuses a later allow with SHELL_APPROVAL_DISABLED", async () => {
    const broker = new PermissionBroker(cfg());
    const decisions: string[] = [];
    broker.onDecision = (p, d) => decisions.push(`${p.permissionId}:${d.policy}`);
    const outcome = await broker.handle(request("shell"));
    assert.deepEqual(outcome, { outcome: { outcome: "selected", optionId: "reject" } });
    const id = decisions[0]?.split(":")[0] ?? "";
    assert.match(decisions[0] ?? "", /shell_disabled$/);
    assert.throws(() => broker.respond(id, "accept", {}), (e: unknown) => e instanceof ToolError && e.code === "SHELL_APPROVAL_DISABLED");
    assert.throws(() => broker.respond(id, "reject", {}), (e: unknown) => e instanceof ToolError && e.code === "PERMISSION_NOT_FOUND");
  });

  it("auto-rejects after the timeout with policy timeout", async () => {
    let fire: (() => void) | undefined;
    const broker = new PermissionBroker(cfg(), { setTimer: (fn) => ((fire = fn), () => undefined) });
    const policies: string[] = [];
    broker.onDecision = (_p, d) => policies.push(d.policy);
    const outcome = broker.handle(request("fs_write"));
    assert.equal(broker.list().length, 1);
    fire?.();
    assert.deepEqual(await outcome, { outcome: { outcome: "selected", optionId: "reject" } });
    assert.deepEqual(policies, ["timeout"]);
  });

  it("cancels a session's pending permissions with reject_once, or as cancelled", async () => {
    const broker = new PermissionBroker(cfg());
    const a = broker.handle(request("fs_write"));
    const b = broker.handle(request("fs_write", { options: [ALL_OPTIONS[0]!] }));
    broker.cancelSession("sess_1");
    assert.deepEqual(await a, { outcome: { outcome: "selected", optionId: "reject" } });
    assert.deepEqual(await b, { outcome: { outcome: "cancelled" } });
  });

  it("forwards pending permissions to elicitation and maps accept, decline, and cancel", async () => {
    const answers = [
      { action: "accept", content: { option: "accept" } },
      { action: "decline" },
      { action: "cancel" },
    ];
    const seen: unknown[] = [];
    const broker = new PermissionBroker(cfg(), {
      elicit: async (p) => {
        seen.push(p.requestedSchema);
        return answers.shift() as { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };
      },
    });
    assert.deepEqual(await broker.handle(request("fs_write")), { outcome: { outcome: "selected", optionId: "accept" } });
    assert.deepEqual(await broker.handle(request("fs_write")), { outcome: { outcome: "selected", optionId: "reject" } });
    void broker.handle(request("fs_write"));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(broker.list().length, 1, "cancel leaves it pending");
    const schema = seen[0] as { properties: { option: { oneOf: { const: string }[] } } };
    // allow_always is left out: persistent consent is off.
    assert.deepEqual(schema.properties.option.oneOf.map((o) => o.const), ["accept", "reject", "always-reject"]);
  });

  it("sends no elicitation when KIRO_MCP_ELICITATION is off, and the request stays pending", async () => {
    let asked = 0;
    const broker = new PermissionBroker(cfg({ elicitation: "off" }), {
      elicit: async () => {
        asked += 1;
        return { action: "decline" };
      },
    });
    const answer = broker.handle(request("fs_write"));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(asked, 0);
    const [pending] = broker.list();
    assert.ok(pending);
    broker.respond(pending.permissionId, "accept", {});
    assert.deepEqual(await answer, { outcome: { outcome: "selected", optionId: "accept" } });
  });
});
