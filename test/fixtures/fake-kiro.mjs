#!/usr/bin/env node
// Stand-in for `kiro-cli`, selected through KIRO_BIN in tests. It never talks
// to Kiro's service. Payload shapes follow the live probe recorded in the
// design (kiro-cli 2.37.1, KAS 0.66.70).
//
//   acp --agent-engine=v3 --auth-method=cli   NDJSON JSON-RPC 2.0 ACP server
//   chat --v3 --no-interactive --output-format=stream-json   headless JSON Lines
//   --version, whoami, profile, diagnostic, doctor --all, chat --list-models,
//   settings, agent, mcp, powers               subcommands
//
// Environment:
//   FAKE_KIRO_META          JSON Lines log: start records (argv, pid, cwd) and every ACP request
//   FAKE_KIRO_STORE         JSON file holding the session store, shared across host restarts
//   FAKE_KIRO_SIGNED_OUT    whoami and ACP session calls report a missing login
//   FAKE_KIRO_ACP_INIT_FAIL acp exits before answering initialize
//   FAKE_KIRO_NO_CLOUD      initialize does not advertise cloud-sandbox
//   FAKE_KIRO_NO_IMAGES     initialize advertises promptCapabilities.image false
//   FAKE_KIRO_NO_USAGE      _kiro/account/getUsage is method-not-found
//   FAKE_KIRO_USAGE         getUsage payload: "near" (95% of credits used) or "refused" (success false)
//   FAKE_KIRO_EMPTY_HISTORY _kiro/session/history returns no updates
//   FAKE_KIRO_WORKFLOWS_OFF workflow methods answer success false
//   FAKE_KIRO_HEADLESS_EXIT headless exit code (0, 3, 4) or "hang" or "interrupt"
//   FAKE_KIRO_PENDING_ON_LOAD session/load is followed by a waiting permission request
//   FAKE_KIRO_NO_GOVERNANCE  no _kiro/governance/state snapshot is sent
//
// Prompt markers select a scripted turn: [permission:shell], [permission:write],
// [long:<ms>], [ratelimit], [fallback], [crash], [garbage], [unknown], [plan],
// [thought], [workflow], [client-requests], [secret]. Anything else is a plain answer.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const env = process.env;

function meta(record) {
  if (!env.FAKE_KIRO_META) return;
  appendFileSync(env.FAKE_KIRO_META, JSON.stringify({ ...record, pid: process.pid, at: Date.now() }) + "\n");
}
meta({
  kind: "start",
  argv,
  cwd: process.cwd(),
  hasApiKey: env.KIRO_API_KEY !== undefined,
  workflowTimeout: env.KIRO_HEADLESS_WORKFLOW_TIMEOUT_SECS ?? null,
});

const out = (text) => process.stdout.write(text);
const fail = (text, code = 1) => {
  process.stderr.write(text + "\n");
  process.exit(code);
};
const has = (flag) => argv.includes(flag);
const flagValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};
const positional = () => {
  const i = argv.indexOf("--");
  return i === -1 ? [] : argv.slice(i + 1);
};

// ---- subcommands -------------------------------------------------------------

const [cmd, sub] = argv;
if (cmd === "--version") {
  out("kiro-cli 2.37.1\n");
  process.exit(0);
}
if (cmd === "whoami") {
  if (env.FAKE_KIRO_SIGNED_OUT) fail("error: You are not logged in, please log in with kiro-cli login");
  out(JSON.stringify({ accountType: "BuilderId", email: "dev@example.com", region: "us-east-1", accessToken: "SECRET-TOKEN-123" }) + "\n");
  process.exit(0);
}
if (cmd === "profile") {
  out("Profile: dev-profile\n");
  process.exit(0);
}
if (cmd === "diagnostic") {
  out(JSON.stringify({ "kiro-cli": { version: "2.37.1" }, os: { name: "fake" } }) + "\n");
  process.exit(0);
}
if (cmd === "doctor") {
  if (!has("--all")) fail("fake: doctor without --all would apply fixes");
  out("\u001b[32m✔\u001b[0m Everything looks good!\n");
  process.exit(0);
}
if (cmd === "settings") {
  if (sub === "list") {
    const settings = { "chat.defaultModel": "auto", "chat.enableThinking": true };
    if (has("--all")) settings["chat.autoCompactionThreshold"] = 80;
    out(JSON.stringify(settings) + "\n");
    process.exit(0);
  }
  const [key, value] = positional();
  out(has("--delete") ? `Removed ${key}\n` : `Updated ${key} = ${value}\n`);
  process.exit(0);
}
if (cmd === "agent") {
  if (sub === "validate") {
    const path = flagValue("path");
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      fail(`error: could not read ${path}`);
    }
    if (text.includes("invalid")) fail(`\u001b[31m✗\u001b[0m ${path}: invalid agent config`);
    out(`\u001b[32m✓\u001b[0m ${path} is valid\n`);
    process.exit(0);
  }
  if (sub === "create") out(`Created agent ${flagValue("name")}\n`);
  else if (sub === "set-default") out(`Default agent set to ${flagValue("name")}\n`);
  else if (sub === "upgrade") out(`Upgraded agents in ${positional()[0]}\n`);
  else fail(`fake: unknown agent command ${sub}`);
  process.exit(0);
}
if (cmd === "mcp") {
  if (sub === "list") {
    out(
      "\u001b[1m📄 Global:\u001b[0m /home/dev/.kiro/settings/mcp.json\n" +
        "  • docs         https://docs.example.dev/mcp\n" +
        "  • fetch        uvx mcp-server-fetch\n" +
        "\n\u001b[1m📄 Workspace:\u001b[0m /work/.kiro/settings/mcp.json\n" +
        "  • local-tools  http://localhost:7000/mcp (disabled)\n",
    );
    process.exit(0);
  }
  if (sub === "status") {
    const name = flagValue("name");
    if (name === "missing") fail(`error: no MCP server named ${name}`);
    out(`\u001b[1m${name}\u001b[0m\nScope: global\nFile: /home/dev/.kiro/settings/mcp.json\nURL: https://docs.example.dev/mcp\nDisabled: false\n`);
    process.exit(0);
  }
  if (sub === "add") {
    if (argv.some((a) => a.startsWith("--command"))) fail("fake: stdio servers must not reach the CLI");
    out(`Added MCP server ${flagValue("name")}\n`);
    process.exit(0);
  }
  if (sub === "remove") {
    out(`Removed MCP server ${flagValue("name")}\n`);
    process.exit(0);
  }
  fail(`fake: unknown mcp command ${sub}`);
}
if (cmd === "powers") {
  const [target] = positional();
  out(sub === "install" ? `Installed power ${target}\n` : `Uninstalled power ${target}\n`);
  process.exit(0);
}
if (cmd === "chat" && has("--list-models")) {
  out(JSON.stringify({ models: [{ id: "auto", name: "Auto" }, { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" }], defaultModel: "auto" }) + "\n");
  process.exit(0);
}
if (cmd === "chat") {
  await headless();
} else if (cmd === "acp") {
  acp();
} else {
  fail(`fake-kiro: unsupported argv ${JSON.stringify(argv)}`, 2);
}

// ---- headless ------------------------------------------------------------------

async function headless() {
  for (const required of ["--v3", "--no-interactive", "--output-format=stream-json"]) {
    if (!has(required)) fail(`fake: headless run missing ${required}`, 2);
  }
  const known = /^--(v3|no-interactive|output-format=stream-json|wrap=never|agent=.+|model=.+|effort=.+|mode=(default|spec)|resume-id=.+|cloud|repo=.+|require-mcp-startup|sandbox|trust-all-tools|trust-tools=.*|trust-workspace)$/;
  for (const arg of argv.slice(1)) {
    if (!known.test(arg)) fail(`error: unexpected argument '${arg}' (fake refuses positional prompts and unknown flags)`, 2);
  }
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  const sessionId = flagValue("resume-id") ?? `sess_${randomUUID()}`;
  const line = (o) => out(JSON.stringify(o) + "\n");
  const mode = env.FAKE_KIRO_HEADLESS_EXIT ?? "0";
  if (mode === "3") fail("error: MCP server docs failed to start", 3);
  if (mode === "4") fail(`error: agent ${flagValue("agent") ?? "default"} not found`, 4);
  line({ type: "runStarted", data: { payloadSchema: "acp", acpProtocolVersion: 1, engine: "v3" } });
  const update = (u) => line({ type: "sessionUpdate", data: { sessionId, update: u } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Headless: " } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: prompt.trim() } });
  if (mode === "hang") {
    process.stderr.write("fake: hanging\n");
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === "interrupt") {
    line({ type: "runFinished", data: { sessionId, status: "interrupted", stopReason: "cancelled", finalText: "", finalTextTruncated: false, interruption: { reason: "signal" } } });
    process.exit(130);
  }
  update({
    sessionUpdate: "session_info_update",
    _meta: { kiro: { kind: "turn_completion", promptTurnSummaries: [{ unit: "credit", unitPlural: "credits", usage: 0.05, usedTools: [] }], elapsedTime: 120, status: "success" } },
  });
  process.stderr.write("fake headless warning: model fallback\n");
  line({ type: "runFinished", data: { sessionId, status: "success", stopReason: "end_turn", finalText: `Headless: ${prompt.trim()}`, finalTextTruncated: false } });
  process.exit(0);
}

// ---- ACP -----------------------------------------------------------------------

function acp() {
  for (const banned of ["--agent", "--model", "--effort", "--trust-all-tools", "--trust-tools", "-a"]) {
    if (argv.some((a) => a === banned || a.startsWith(`${banned}=`))) fail(`error: unexpected argument '${banned}' found (rejected on acp v3)`, 2);
  }
  if (!has("--agent-engine=v3")) fail("fake: only --agent-engine=v3 is implemented", 2);
  if (env.FAKE_KIRO_ACP_INIT_FAIL) fail("error: the v3 agent engine is not available in this build", 1);

  const store = loadStore();
  const live = new Map(); // sessionId -> { activeTurn, pendingPermission }
  const memories = new Map();
  let nextId = 1;
  const waiting = new Map(); // our request id -> resolve

  const send = (o) => out(JSON.stringify(o) + "\n");
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
  const update = (sessionId, u) => notify("session/update", { sessionId, update: u });
  const info = (sessionId, kiro, extra = {}) => update(sessionId, { sessionUpdate: "session_info_update", ...extra, _meta: { kiro } });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = `agent-${nextId++}`;
      waiting.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === undefined && msg.id !== undefined && waiting.has(msg.id)) {
      meta({ kind: "client_response", id: msg.id, result: msg.result, error: msg.error });
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
      return;
    }
    meta({ kind: msg.id === undefined ? "notification" : "request", method: msg.method, params: msg.params });
    if (msg.id === undefined) {
      handleNotification(msg.method, msg.params ?? {});
      return;
    }
    Promise.resolve()
      .then(() => handle(msg.method, msg.params ?? {}))
      .then(
        (result) => send({ jsonrpc: "2.0", id: msg.id, result: result ?? null }),
        (err) => send({ jsonrpc: "2.0", id: msg.id, error: err && err.code !== undefined ? err : { code: -32603, message: String(err) } }),
      );
  });
  rl.on("close", () => process.exit(0));

  const rpcError = (code, message, data) => ({ code, message, ...(data ? { data } : {}) });
  const notFound = (method) => rpcError(-32601, `Method not found: ${method}`);
  const session = (sessionId) => {
    const s = store.sessions[sessionId];
    if (!s) throw rpcError(-32602, `Invalid params: session not found: ${sessionId}`, { errorType: "SessionNotFoundError" });
    return s;
  };
  const authCheck = () => {
    if (env.FAKE_KIRO_SIGNED_OUT) throw rpcError(-32000, "Authentication required: not logged in", { errorType: "AuthRequiredError" });
  };
  const liveOf = (sessionId) => {
    if (!live.has(sessionId)) live.set(sessionId, { activeTurn: null });
    return live.get(sessionId);
  };

  const MODES = ["vibe", "spec", "quick-spec", "bug-fix", "plan", "autonomous", "reviewer-agent"];
  const MODELS = ["auto", "claude-sonnet-5.5", "claude-haiku-5.5"];
  const modes = (s) => ({
    currentModeId: s.mode,
    availableModes: MODES.map((id) => ({
      id,
      name: id === "vibe" ? "Default" : id,
      description: `${id} mode`,
      _meta: { kiro: { source: id === "reviewer-agent" ? "workspace" : "bundled" } },
    })),
  });
  const configOptions = (s) => {
    const opts = [
      { type: "select", id: "mode", name: "Mode", category: "mode", currentValue: s.mode, options: MODES.map((v) => ({ value: v, name: v })) },
      { type: "select", id: "model", name: "Model", category: "model", currentValue: s.model, options: MODELS.map((v) => ({ value: v, name: v })) },
    ];
    if (s.model !== "auto") {
      opts.push({ type: "select", id: "effortLevel", name: "Effort", category: "thought_level", currentValue: s.effort, options: ["low", "medium", "high"].map((v) => ({ value: v, name: v })) });
    }
    opts.push({ type: "select", id: "autopilot", name: "Autopilot", currentValue: s.autopilot, options: [{ value: "on", name: "on" }, { value: "off", name: "off" }] });
    opts.push({ type: "select", id: "memoryReflection", name: "Memory reflection", currentValue: "off", options: [{ value: "on", name: "on" }, { value: "off", name: "off" }] });
    return opts;
  };
  const COMMANDS = [
    { name: "context-gatherer", description: "Investigates the codebase", input: { hint: "task to delegate" }, _meta: { kiro: { type: "custom-agent" } } },
    { name: "code-review", description: "Review a diff", input: { hint: "<diff>" }, _meta: { kiro: { type: "skill" } } },
    { name: "fetch", description: "Fetch a URL", input: { hint: "<url>" }, _meta: { kiro: { type: "prompt" } } },
  ];

  function snapshots(sessionId) {
    update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS });
    notify("_kiro/mcp/status", {
      sessionId,
      servers: [
        { name: "docs", status: "connected", tools: [{ name: "search_docs", description: "Search", disabled: false, inputSchema: { type: "object", properties: { q: { type: "string" } } } }] },
        { name: "broken", status: "failed", error: "spawn ENOENT", _meta: { kiro: { authorizationFailed: false } } },
      ],
    });
    notify("_kiro/tools/didChange", { sessionId, tags: [{ source: "builtin", tag: "read", description: "read tools" }, { source: "builtin", tag: "shell", description: "shell tools" }] });
    notify("_kiro/steering/documents_changed", {
      sessionId,
      status: "success",
      documents: [{ name: "product", type: "steering", scope: "workspace", uri: "file:///work/.kiro/steering/product.md", inclusion: "always", content: "# Product\n" + "x".repeat(5000) }],
    });
    notify("_kiro/progressive_context/items_changed", { sessionId, status: "success", items: [{ name: "code-review", type: "skill", description: "Review a diff", scope: "global", uri: "file:///home/dev/.kiro/skills/code-review/SKILL.md" }] });
    notify("_kiro/powers/items_changed", { sessionId, status: "success", powers: [{ name: "context7", displayName: "Context7", description: "Docs", mcpServerNames: ["context7"] }] });
    if (!env.FAKE_KIRO_NO_GOVERNANCE) notify("_kiro/governance/state", { sessionId, isEnterprise: false, features: { mcpEnabled: true, webToolsEnabled: true, autonomousAgents: true } });
    notify("_kiro/customAgent/config_error", { sessionId, path: "/home/dev/.kiro/agents/broken.json", reasonCode: "invalid_config", error: "PromptFileError: bad prompt" });
    info(sessionId, { kind: "context_usage", usagePercentage: s(sessionId).context, summarizationThreshold: 80, contextUsage: { usagePercentage: s(sessionId).context, summarizationThreshold: 80 }, breakdown: { contextFiles: { tokens: 10, percent: 0.1 }, tools: { tokens: 2000, percent: 1 }, memory: { tokens: 0, percent: 0 }, kiroResponses: { tokens: 0, percent: 0 }, yourPrompts: { tokens: 0, percent: 0 }, sessionFiles: { tokens: 0, percent: 0 } } });
  }
  const s = (sessionId) => store.sessions[sessionId];

  function newSession(cwd, kiro = {}, extra = {}) {
    const id = `sess_${randomUUID()}`;
    const model = MODELS.includes(kiro.modelId) ? kiro.modelId : "auto";
    store.sessions[id] = {
      id,
      cwd,
      title: "New Session",
      mode: MODES.includes(kiro.modeId) ? kiro.modeId : "vibe",
      model,
      effort: kiro.effortLevel && model !== "auto" ? kiro.effortLevel : "medium",
      autopilot: "off",
      context: 1.5,
      updatedAt: new Date().toISOString(),
      source: kiro.executionTarget === "cloud-sandbox" ? "remote" : "local",
      executionTarget: kiro.executionTarget ?? "local",
      repos: kiro.repos ?? [],
      updates: [],
      ...extra,
    };
    saveStore(store);
    return store.sessions[id];
  }

  function record(sessionId, u) {
    const sess = s(sessionId);
    sess.updates.push(u);
    sess.updatedAt = new Date().toISOString();
    saveStore(store);
    update(sessionId, u);
  }

  async function handle(method, p) {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: !env.FAKE_KIRO_NO_IMAGES, embeddedContext: true },
            mcpCapabilities: { http: true, sse: true },
            sessionCapabilities: { list: {}, close: {}, delete: {}, fork: { _meta: { kiro: { messageId: true } } } },
            _meta: {
              kiro: {
                sessionList: true,
                extensionMethods: [
                  "_kiro/knowledge", "_kiro/memory/list", "_kiro/memory/get", "_kiro/memory/create", "_kiro/memory/update",
                  "_kiro/memory/delete", "_kiro/memory/getSyncStatus", "_kiro/codeIntelligence", "_kiro/session/context",
                  "_kiro/session/compact", "_kiro/session/export", "_kiro/session/history", "_kiro/configuration/getState",
                  "_kiro/workflow/invoke", "_kiro/workflow/inspect", "_kiro/workflow/list", "_kiro/workflow/pause",
                  "_kiro/workflow/cancel", "_kiro/workflow/delete", "_kiro/workflow/listRecipes", "_kiro/workflow/retry",
                  "_kiro/workflow/resume", "_kiro/sourceProviders/list", "_kiro/sourceProviders/listResources",
                ],
                sessionSources: ["local", "remote"],
                sessionListScopes: ["workspace", "user"],
                executionTargets: env.FAKE_KIRO_NO_CLOUD ? ["local"] : ["local", "cloud-sandbox"],
                replayMarking: true,
                autoCompactionThreshold: { min: 0, max: 80, default: 80 },
                logging: { logDir: "/home/dev/.kiro/logs/fake", channels: [{ name: "kiro", filePath: "/home/dev/.kiro/logs/fake/kiro.log" }] },
              },
            },
          },
          authMethods: [{ id: "aws-builder-id", name: "AWS Builder ID" }],
        };
      case "session/new": {
        authCheck();
        if (!Array.isArray(p.mcpServers) || p.mcpServers.length !== 0) throw rpcError(-32602, "fake: mcpServers must be []");
        const sess = newSession(p.cwd, p._meta?.kiro ?? {}, { additionalDirectories: p.additionalDirectories ?? [] });
        setImmediate(() => snapshots(sess.id));
        return { sessionId: sess.id, modes: modes(sess), configOptions: configOptions(sess), _meta: { id: sess.id, title: sess.title, agentMode: sess.mode, source: sess.source } };
      }
      case "session/list": {
        const scope = p._meta?.kiro?.scope ?? "workspace";
        const sessions = Object.values(store.sessions)
          .filter((x) => scope === "user" || x.cwd === p.cwd)
          .map((x) => ({
            sessionId: x.id,
            cwd: x.cwd,
            title: x.title,
            updatedAt: x.updatedAt,
            _meta: { kiro: { source: x.source, executionTarget: x.executionTarget, status: "idle", agentMode: x.mode } },
          }));
        return { sessions };
      }
      case "session/load": {
        authCheck();
        const sess = session(p.sessionId);
        if (p._meta?.kiro?.noReplay === true && sess.source === "remote") throw rpcError(-32602, "fake: noReplay sent for a remote session");
        meta({ kind: "load", sessionId: sess.id, cwd: p.cwd, additionalDirectories: p.additionalDirectories ?? [] });
        for (const u of sess.updates) update(sess.id, { ...u, _meta: { ...(u._meta ?? {}), kiro: { ...(u._meta?.kiro ?? {}), replay: true } } });
        setImmediate(() => {
          snapshots(sess.id);
          if (env.FAKE_KIRO_PENDING_ON_LOAD) void askPermission(sess.id, "shell", "execute", "cloud_command");
        });
        return { modes: modes(sess), configOptions: configOptions(sess) };
      }
      case "session/prompt":
        authCheck();
        return prompt(p);
      case "session/set_mode": {
        const sess = session(p.sessionId);
        if (!MODES.includes(p.modeId)) throw rpcError(-32602, `Invalid params: unknown mode ${p.modeId}`);
        sess.mode = p.modeId;
        saveStore(store);
        update(sess.id, { sessionUpdate: "current_mode_update", currentModeId: sess.mode });
        update(sess.id, { sessionUpdate: "config_option_update", configOptions: configOptions(sess) });
        return {};
      }
      case "session/set_config_option": {
        const sess = session(p.sessionId);
        const opt = configOptions(sess).find((o) => o.id === p.configId);
        if (!opt || !opt.options.some((o) => o.value === p.value)) throw rpcError(-32602, `Invalid params: ${p.configId}=${p.value}`);
        if (p.configId === "mode") sess.mode = p.value;
        if (p.configId === "model") sess.model = p.value;
        if (p.configId === "effortLevel") sess.effort = p.value;
        if (p.configId === "autopilot") sess.autopilot = p.value;
        saveStore(store);
        update(sess.id, { sessionUpdate: "config_option_update", configOptions: configOptions(sess) });
        return { configOptions: configOptions(sess) };
      }
      case "session/fork": {
        const src = session(p.sessionId);
        const messageId = p._meta?.kiro?.messageId;
        let updates = src.updates;
        if (messageId !== undefined) {
          const cut = updates.findIndex((u) => u._meta?.kiro?.userMessageId === messageId);
          if (cut === -1) throw rpcError(-32602, `Invalid params: unknown messageId ${messageId}`);
          updates = updates.slice(0, cut);
        }
        const fork = newSession(src.cwd, { modeId: src.mode, modelId: src.model }, { updates: [...updates], title: `${src.title} (fork)` });
        setImmediate(() => snapshots(fork.id));
        return { sessionId: fork.id, modes: modes(fork), configOptions: configOptions(fork) };
      }
      case "session/close":
        session(p.sessionId);
        live.delete(p.sessionId);
        return {};
      case "session/delete":
        session(p.sessionId);
        delete store.sessions[p.sessionId];
        saveStore(store);
        return {};
      case "_kiro/session/rename":
        session(p.sessionId).title = p.title;
        saveStore(store);
        return { success: true };
      case "_kiro/session/export": {
        const sess = session(p.sessionId);
        writeFileSync(p.path, JSON.stringify({ sessionId: sess.id, title: sess.title, updates: sess.updates }, null, 2));
        return { success: true, path: p.path };
      }
      case "_kiro/session/history": {
        const sess = session(p.sessionId);
        if (env.FAKE_KIRO_EMPTY_HISTORY) return { updates: [], hasMore: false };
        const start = typeof p.cursor === "number" ? p.cursor : 0;
        const limit = typeof p.limit === "number" ? p.limit : 100;
        const page = sess.updates.slice(start, start + limit);
        return { updates: page, hasMore: start + limit < sess.updates.length, nextCursor: start + page.length };
      }
      case "_kiro/session/compact": {
        const sess = session(p.sessionId);
        sess.context = 0.5;
        saveStore(store);
        info(sess.id, { kind: "context_usage", usagePercentage: 0.5, summarizationThreshold: 80 });
        return { success: true };
      }
      case "_kiro/session/context":
        return { usagePercentage: session(p.sessionId).context, breakdown: { tools: { tokens: 2000 } } };
      case "_kiro/account/getUsage":
        if (env.FAKE_KIRO_NO_USAGE) throw notFound(method);
        if (env.FAKE_KIRO_USAGE === "refused") return { success: false, message: "usage is unavailable" };
        if (env.FAKE_KIRO_USAGE === "near") {
          return {
            success: true,
            data: {
              planName: "KIRO FREE",
              billingCycleReset: "2026-12-01",
              overagesEnabled: false,
              usageBreakdowns: [{ resourceType: "CREDIT", displayName: "Credits", used: 50, limit: 50, percentage: 100 }],
              bonusCredits: [{ name: "welcome", used: 470, total: 500, daysUntilExpiry: 30 }],
              addOnCredits: [],
            },
          };
        }
        return {
          success: true,
          message: "Plan: KIRO FREE | 1 usage breakdowns",
          data: {
            planName: "KIRO FREE",
            billingCycleReset: "2026-12-01",
            overagesEnabled: false,
            usageBreakdowns: [{ resourceType: "CREDIT", displayName: "Credits", used: 3, limit: 50, percentage: 6 }],
            bonusCredits: [{ name: "welcome", used: 10, total: 500, daysUntilExpiry: 30 }],
            addOnCredits: [],
          },
        };
      case "_session/steer": {
        const l = liveOf(p.sessionId);
        if (typeof p.message !== "string" || p.message === "") throw rpcError(-32603, "Internal error", { details: "_session/steer: missing or empty message" });
        if (!l.activeTurn) throw rpcError(-32603, "Internal error", { details: "_session/steer: no active turn" });
        info(p.sessionId, { kind: "steering_queued", message: p.message });
        l.activeTurn.steer = p.message;
        return {};
      }
      case "_kiro/configuration/getState":
        if (p.observer !== "session" || !p.sessionId) throw rpcError(-32602, 'Invalid params: observer must be "connection", "session" with a sessionId, or "workspace" with roots');
        return { layers: [{ name: "user", uri: "file:///home/dev/.kiro" }], resources: [{ resourceType: "hook", name: "lint-on-save" }] };
      case "_kiro/memory/list":
        return { memories: [...memories.values()] };
      case "_kiro/memory/get": {
        const m = memories.get(p.memoryId);
        if (!m) throw rpcError(-32602, `Invalid params: memory not found: ${p.memoryId}`);
        return { memory: m };
      }
      case "_kiro/memory/create": {
        if (String(p.content).includes("[refuse]")) throw rpcError(-32603, "Memory writes are disabled in an untrusted workspace", { errorType: "MemoryAccessDeniedError" });
        const m = { id: `mem_${memories.size + 1}`, content: p.content };
        memories.set(m.id, m);
        return { memory: m };
      }
      case "_kiro/memory/update": {
        const m = memories.get(p.memoryId);
        if (!m) throw rpcError(-32602, `Invalid params: memory not found: ${p.memoryId}`);
        m.content = p.content;
        return { memory: m };
      }
      case "_kiro/memory/delete":
        memories.delete(p.memoryId);
        return { success: true };
      case "_kiro/memory/getSyncStatus":
        return { state: "off" };
      case "_kiro/knowledge":
        if (!p.subcommand) return { success: false, message: "Unknown subcommand: undefined" };
        if (p.subcommand === "add" && !p.path) return { success: false, message: "add needs a path" };
        return { success: true, message: `knowledge ${p.subcommand} ok`, data: { subcommand: p.subcommand, args: p } };
      case "_kiro/codeIntelligence":
        if (p.subcommand === "init") return { success: true, message: "Code intelligence initialized", data: { languages: ["typescript"] } };
        return { success: false, message: "Code intelligence is not enabled for this session" };
      case "_kiro/workflow/listRecipes":
        if (env.FAKE_KIRO_WORKFLOWS_OFF) return { success: false, message: "Workflows are disabled for this session" };
        return { recipes: [{ name: "feature-pipeline", description: "Full feature pipeline", source: "bundled://feature-pipeline", inputs: { workdir: "string", goal: "string" } }, { name: "goal", description: "Iterate to a goal", source: "bundled://goal", inputs: { goal: "string" } }] };
      case "_kiro/workflow/list":
        if (env.FAKE_KIRO_WORKFLOWS_OFF) return { success: false, message: "Workflows are disabled for this session" };
        return { runs: store.workflows ?? [] };
      case "_kiro/workflow/invoke": {
        if (env.FAKE_KIRO_WORKFLOWS_OFF) return { success: false, message: "Workflows are disabled for this session" };
        const workflowId = `wf_${randomUUID().slice(0, 8)}`;
        store.workflows = [...(store.workflows ?? []), { workflowId, recipe: p.recipeName, status: "running" }];
        saveStore(store);
        setTimeout(() => notify("_kiro/workflow/updated", { sessionId: p.sessionId, workflowId, status: "running" }), 20);
        setTimeout(() => notify("_kiro/workflow/updated", { sessionId: p.sessionId, workflowId, status: "completed" }), 60);
        return { workflowId };
      }
      case "_kiro/workflow/inspect":
      case "_kiro/workflow/pause":
      case "_kiro/workflow/resume":
      case "_kiro/workflow/cancel":
      case "_kiro/workflow/retry":
      case "_kiro/workflow/delete":
        if (env.FAKE_KIRO_WORKFLOWS_OFF) return { success: false, message: "Workflows are disabled for this session" };
        return { success: true, workflowId: p.workflowId, action: method.split("/").pop(), nodeId: p.nodeId ?? null };
      case "_kiro/sourceProviders/list":
        return { providers: [{ providerType: "GITHUB", displayName: "GitHub", connectionStatus: "connected" }, { providerType: "GITLAB", displayName: "GitLab", connectionStatus: "not_connected" }] };
      case "_kiro/sourceProviders/listResources":
        return { resources: [{ name: "octo/app", url: "https://github.com/octo/app" }] };
      default:
        throw notFound(method);
    }
  }

  function handleNotification(method, p) {
    if (method === "session/cancel") {
      const l = live.get(p.sessionId);
      if (l?.activeTurn) l.activeTurn.cancelled = true;
    }
  }

  async function askPermission(sessionId, capability, kind, toolId) {
    const toolCallId = `${toolId}_${randomUUID().slice(0, 8)}`;
    record(sessionId, { sessionUpdate: "tool_call", toolCallId, title: `run ${capability} tool`, kind, status: "pending", rawInput: { command: "touch probe.txt" } });
    const response = await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId, status: "pending", title: "touch probe.txt" },
      options: [
        { optionId: "accept", name: "Allow", kind: "allow_once" },
        { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
        { optionId: "reject", name: "Deny", kind: "reject_once" },
        { optionId: "always-reject", name: "Always deny", kind: "reject_always" },
      ],
      _meta: {
        kiro: {
          toolId,
          command: "touch probe.txt",
          consent: { capability, resource: "touch probe.txt", askType: "implicit", triggeringResource: "touch probe.txt", workspaceRoot: s(sessionId).cwd, persistableConsent: true },
          consentRound: 1,
          mcpTool: { serverName: "docs", toolName: "search_docs", annotations: { readOnlyHint: true } },
        },
      },
    });
    const outcome = response.result?.outcome ?? {};
    const selected = outcome.outcome === "selected" ? outcome.optionId : null;
    const allowed = selected === "accept" || selected === "always-accept";
    record(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: allowed ? "completed" : "failed",
      rawOutput: { message: allowed ? "ok" : outcome.outcome === "cancelled" ? "cancelled" : "The user rejected this tool call." },
    });
    return { selected, outcome: outcome.outcome ?? "error", consent: response.result?._meta?.kiro?.consent ?? null };
  }

  async function prompt(p) {
    const sess = session(p.sessionId);
    const l = liveOf(sess.id);
    if (l.activeTurn) throw rpcError(-32603, "Internal error", { details: "turn already active" });
    const turn = { cancelled: false, steer: null };
    l.activeTurn = turn;
    try {
      const blocks = Array.isArray(p.prompt) ? p.prompt : [];
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const others = blocks.filter((b) => b.type !== "text").map((b) => b.type + (b.resource?.uri ? `:${b.resource.uri}` : b.uri ? `:${b.uri}` : ""));
      const turnId = randomUUID();
      const userMessageId = randomUUID();
      record(sess.id, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
      record(sess.id, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "user_message_id_assigned", userMessageId } } });
      info(sess.id, { kind: "turn_start", turnStart: true, turnId });
      if (sess.title === "New Session") {
        sess.title = text.slice(0, 40) || "Untitled";
        saveStore(store);
        info(sess.id, { kind: "focus_update", focus: { title: sess.title }, title: sess.title }, { title: sess.title });
      }
      let reply = `Echo: ${text}`;
      if (others.length > 0) reply += ` [blocks: ${others.join(", ")}]`;
      if (text.includes("[crash]")) {
        record(sess.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "about to crash" } });
        setTimeout(() => process.exit(9), 30);
        return await new Promise(() => undefined);
      }
      if (text.includes("[garbage]")) out("this is not json\n");
      if (text.includes("[unknown]")) update(sess.id, { sessionUpdate: "mystery_update", payload: 1 });
      if (text.includes("[ratelimit]")) notify("_kiro/error/rate_limit", { sessionId: sess.id, message: "Rate limited, retrying in 2s", retryAfterMs: 2000 });
      if (text.includes("[fallback]")) info(sess.id, { kind: "model_fallback", fromModel: "claude-sonnet-5.5", toModel: "auto", message: "Fell back to auto" });
      if (text.includes("[plan]")) update(sess.id, { sessionUpdate: "plan", entries: [{ content: "Read code", status: "completed", priority: "high" }, { content: "Write tests", status: "pending", priority: "medium" }] });
      if (text.includes("[thought]")) {
        update(sess.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking " } });
        update(sess.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hard" } });
      }
      if (text.includes("[secret]")) reply += " KIRO_API_KEY is " + (env.KIRO_API_KEY ? "set" : "unset");
      if (text.includes("[workflow]")) notify("_kiro/workflow/updated", { sessionId: sess.id, workflowId: "wf_turn", status: "running" });
      if (text.includes("[client-requests]")) {
        const a = await request("fs/read_text_file", { sessionId: sess.id, path: "/etc/hosts" });
        const b = await request("terminal/create", { sessionId: sess.id, command: "ls" });
        const c = await request("_kiro/auth/getAccessToken", {});
        reply += ` [client errors: ${[a, b, c].map((r) => r.error?.code ?? "none").join(",")}]`;
      }
      const perm = /\[permission:(shell|write)\]/.exec(text);
      if (perm) {
        const capability = perm[1] === "shell" ? "shell" : "fs_write";
        const r = await askPermission(sess.id, capability, perm[1] === "shell" ? "execute" : "edit", perm[1] === "shell" ? "run_command" : "fs_write");
        reply += ` [permission: ${r.outcome}${r.selected ? `:${r.selected}` : ""}${r.consent ? ` consent=${JSON.stringify(r.consent)}` : ""}]`;
      }
      const long = /\[long:(\d+)\]/.exec(text);
      if (long) {
        const until = Date.now() + Number(long[1]);
        let i = 0;
        while (Date.now() < until && !turn.cancelled) {
          record(sess.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `tick${i++} ` } });
          if (turn.steer) {
            info(sess.id, { kind: "steering_injected", message: turn.steer });
            reply += ` [steered: ${turn.steer}]`;
            turn.steer = null;
          }
          await sleep(50);
        }
      }
      if (turn.cancelled) {
        info(sess.id, { kind: "turn_end", turnEnd: { stopReason: "cancelled" }, stopReason: "cancelled", turnId });
        return { stopReason: "cancelled" };
      }
      for (const piece of [reply.slice(0, 6), reply.slice(6)]) {
        if (piece) record(sess.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } });
      }
      info(sess.id, {
        kind: "turn_completion",
        promptTurnSummaries: [{ unit: "credit", unitPlural: "credits", usage: 0.25, usedTools: perm ? ["execute_bash"] : [] }],
        elapsedTime: 42,
        status: "success",
        turnId,
      });
      // turn_end arrives before the prompt response; the server must not settle on it.
      info(sess.id, { kind: "turn_end", turnEnd: { stopReason: "end_turn" }, stopReason: "end_turn", turnId });
      await sleep(text.includes("[slow-response]") ? 400 : 5);
      return { stopReason: "end_turn" };
    } finally {
      l.activeTurn = null;
    }
  }
}

function loadStore() {
  const path = env.FAKE_KIRO_STORE;
  if (path && existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // fall through
    }
  }
  return { sessions: {} };
}

function saveStore(store) {
  if (env.FAKE_KIRO_STORE) writeFileSync(env.FAKE_KIRO_STORE, JSON.stringify(store));
}
