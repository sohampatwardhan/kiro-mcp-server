import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { connect, requests, type Connected } from "./smoke-helpers.js";

interface Configured {
  current_mode: string | null;
  config_options: { id: string; current_value: unknown; values: string[] }[];
  changed: string[];
}
type State = Record<string, { received: boolean; data: unknown }>;

describe("kiro_session_configure", () => {
  let c: Connected;
  let id: string;
  before(async () => {
    c = await connect();
    id = (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;
  });
  after(() => c.close());

  for (const mode of ["spec", "plan", "autonomous", "reviewer-agent"]) {
    it(`switches to ${mode} with session/set_mode`, async () => {
      const r = await c.ok<Configured>("kiro_session_configure", { session_id: id, mode });
      assert.equal(r.current_mode, mode);
      assert.deepEqual(requests(c, "session/set_mode").at(-1)?.params, { sessionId: id, modeId: mode });
    });
  }

  it("sets model, effort, and other options with session/set_config_option and returns Kiro's values", async () => {
    const r = await c.ok<Configured>("kiro_session_configure", { session_id: id, model: "claude-sonnet-5.5", effort: "high", options: { autopilot: "on" } });
    const value = (k: string) => r.config_options.find((o) => o.id === k)?.current_value;
    assert.equal(value("model"), "claude-sonnet-5.5");
    assert.equal(value("effortLevel"), "high");
    assert.equal(value("autopilot"), "on");
    assert.deepEqual(r.changed, ["model", "effortLevel", "autopilot"]);
    const sent = requests(c, "session/set_config_option").map((m) => (m.params as { configId: string }).configId);
    assert.deepEqual(sent.slice(-3), ["model", "effortLevel", "autopilot"]);
  });

  it("refuses values Kiro did not advertise, lists the allowed ones, and changes nothing", async () => {
    const before = requests(c, "session/set_mode").length + requests(c, "session/set_config_option").length;
    const bad = await c.fail("kiro_session_configure", { session_id: id, mode: "nonexistent" });
    assert.equal(bad.code, "VALUE_NOT_ADVERTISED");
    assert.ok((bad.details.allowed as string[]).includes("plan"));
    assert.equal((await c.fail("kiro_session_configure", { session_id: id, mode: "plan", model: "gpt-9" })).code, "VALUE_NOT_ADVERTISED");
    assert.equal((await c.fail("kiro_session_configure", { session_id: id, options: { noSuchOption: "x" } })).code, "VALUE_NOT_ADVERTISED");
    assert.equal(requests(c, "session/set_mode").length + requests(c, "session/set_config_option").length, before);
  });
});

describe("kiro_session_state", () => {
  let c: Connected;
  let id: string;
  before(async () => {
    c = await connect({ env: { FAKE_KIRO_NO_GOVERNANCE: "1" } });
    id = (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;
  });
  after(() => c.close());

  it("returns every cached snapshot kind", async () => {
    const r = await c.ok<{ state: State }>("kiro_session_state", {
      session_id: id,
      include: ["mcp", "tools", "steering", "skills", "powers", "agent_errors", "commands", "modes", "config", "context"],
    });
    for (const [kind, value] of Object.entries(r.state)) assert.equal(value.received, true, kind);
    const mcp = r.state.mcp?.data as { servers: { name: string; status: string; tool_names: string[] }[] };
    assert.deepEqual(mcp.servers.map((s) => [s.name, s.status, s.tool_names]), [["docs", "connected", ["search_docs"]], ["broken", "failed", []]]);
    const steering = r.state.steering?.data as { documents: Record<string, unknown>[] };
    assert.equal(steering.documents[0]?.content, undefined, "content omitted unless verbose");
    assert.equal(steering.documents[0]?.inclusion, "always");
    assert.equal((r.state.agent_errors?.data as unknown[]).length, 1);
  });

  it("returns large fields truncated when verbose", async () => {
    const r = await c.ok<{ state: State }>("kiro_session_state", { session_id: id, include: ["steering", "mcp"], verbose: true });
    const doc = (r.state.steering?.data as { documents: { content: { truncated: boolean; preview: string } }[] }).documents[0];
    assert.equal(doc?.content.truncated, true);
    assert.equal(doc?.content.preview.length, 4_000);
  });

  it("reports a snapshot that has not arrived as received: false", async () => {
    const r = await c.ok<{ state: State }>("kiro_session_state", { session_id: id, include: ["governance"] });
    assert.deepEqual(r.state.governance, { received: false, received_at: null, data: null });
  });

  it("calls getState with observer session for the configuration panel", async () => {
    const r = await c.ok<{ state: State }>("kiro_session_state", { session_id: id, include: ["configuration"] });
    assert.ok(JSON.stringify(r.state.configuration?.data).includes("lint-on-save"));
    assert.deepEqual(requests(c, "_kiro/configuration/getState").at(-1)?.params, { observer: "session", sessionId: id });
  });

  it("lists models without a session through the CLI", async () => {
    const r = await c.ok<{ session_id: null; state: State }>("kiro_session_state", { include: ["models"] });
    assert.equal(r.session_id, null);
    assert.ok(JSON.stringify(r.state.models?.data).includes("claude-sonnet-5.5"));
    assert.ok(c.meta().some((m) => m.kind === "start" && m.argv?.includes("--list-models")));
  });
});
