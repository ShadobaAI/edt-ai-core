import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { fixture, environment, session } from "./helpers.mjs";
import { settings } from "../scripts/common.mjs";
import { validate } from "../scripts/profile.mjs";
import { knowledge_status, knowledge_gate, WORKFLOW_ACTIONS } from "../scripts/knowledge.mjs";
import { probe_connections } from "../scripts/setup_probe.mjs";
import { save_readiness } from "../scripts/setup_readiness.mjs";
import { guard } from "../scripts/guard.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { setup_inspection } from "../scripts/setup_inspection.mjs";
import { inspect } from "../scripts/doctor.mjs";

test("disabled knowledge never contacts OpenViking even with a saved enabled endpoint", async t => {
  const f = fixture(t); environment(t, f.env);
  const config = settings();
  config.mcp.optional.openviking = { enabled: true, url: "http://127.0.0.1:1/mcp" };
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network"); });
  const result = await probe_connections(config, f.root, f.profile);
  assert.equal(network.mock.callCount(), 0);
  assert.equal(result.external.openviking.connected, false);
  assert.equal(result.knowledge.provider, "none");
  config.mcp.optional.openviking.enabled = false;
  assert.equal(knowledge_status(f.profile, config).state, "disabled");
});

test("OpenViking uses explicit nonempty collections without requiring the recommended set", t => {
  const f = fixture(t); environment(t, f.env);
  f.profile.knowledge = { mode: "transitional", provider: "openviking", manifest: null, required: false, dependent_actions: [] };
  assert.throws(() => validate(f.profile), /collections/);
  f.profile.knowledge.collections = [];
  assert.throws(() => validate(f.profile), /collections/);
  f.profile.knowledge.collections = ["team-architecture"];
  validate(f.profile);
  const config = settings();
  assert.equal(knowledge_status(f.profile, config).state, "not_configured");
  config.mcp.optional.openviking = { enabled: true, url: "http://127.0.0.1:1/mcp" };
  assert.deepEqual(knowledge_status(f.profile, config).collections, ["team-architecture"]);
  assert.equal(knowledge_status(f.profile, config).state, "not_verified");
  assert.equal(knowledge_status(f.profile, config).coverageScope, "selected_collections");
  assert.equal(knowledge_status(f.profile, config).apiExistence, "not_determined");
});

test("a connected MCP with tools does not prove selected-collection search readiness", async t => {
  const f = fixture(t); environment(t, f.env);
  f.profile.knowledge = { mode: "transitional", provider: "openviking", manifest: null, collections: ["architecture"], required: false, dependent_actions: [] };
  const config = settings();
  config.mcp.optional.openviking = { enabled: true, url: "http://127.0.0.1:1/mcp" };
  const methods = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.method === "DELETE") return new Response(null, { status: 202 });
    const message = JSON.parse(options.body); methods.push(message.method);
    if (message.method.startsWith("notifications/")) return new Response(null, { status: 202 });
    const body = message.method === "server/discover"
      ? { error: { code: -32601, message: "legacy" } }
      : { result: message.method === "initialize"
        ? { protocolVersion: "2025-11-25", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } }
        : { tools: [{ name: "custom_search", inputSchema: { type: "object" } }] } };
    return Response.json({ jsonrpc: "2.0", id: message.id, ...body });
  });
  const result = await probe_connections(config, f.root, f.profile);
  assert.equal(result.external.openviking.connected, true);
  assert.equal(result.external.openviking.ready, false);
  assert.deepEqual(result.external.openviking.collections, ["architecture"]);
  assert.equal(methods.includes("tools/call"), false);
  assert.equal(result.knowledge.coverage, "not_verified");
  assert.equal(result.knowledge.apiExistence, "not_determined");
});

test("missing transport and disabled knowledge do not imply that an API is absent", t => {
  const f = fixture(t); environment(t, f.env);
  const config = settings();
  for (const provider of ["none", "openviking"]) {
    f.profile.knowledge = { mode: provider === "none" ? "disabled" : "transitional", provider, manifest: null, collections: provider === "none" ? [] : ["custom-team-docs"], required: false, dependent_actions: [] };
    validate(f.profile);
    const result = knowledge_status(f.profile, config);
    assert.equal(result.apiExistence, "not_determined");
    assert.equal(result.coverage, "not_verified");
    assert.equal(knowledge_gate(f.profile, config, "review").allowed, true);
    assert.deepEqual(result.collections, f.profile.knowledge.collections);
  }
});

test("required knowledge blocks only the declared dependent phases", t => {
  const f = fixture(t); environment(t, f.env);
  const config = settings();
  f.profile.knowledge = { mode: "transitional", provider: "openviking", manifest: null, collections: ["architecture"], required: true, dependent_actions: ["design", "implementation"] };
  validate(f.profile);
  assert.equal(knowledge_gate(f.profile, config, "implementation").allowed, false);
  assert.equal(knowledge_gate(f.profile, config, "design").allowed, false);
  assert.equal(knowledge_gate(f.profile, config, "review").allowed, true);
  assert.equal(knowledge_gate(f.profile, config, "knowledge_search").allowed, false);
  f.profile.knowledge.required = false;
  f.profile.knowledge.dependent_actions = [];
  assert.equal(knowledge_gate(f.profile, config, "implementation").allowed, true);
  f.profile.knowledge.required = true; f.profile.knowledge.dependent_actions = [];
  assert.throws(() => validate(f.profile), /dependent_actions/);
  delete f.profile.knowledge.required;
  assert.throws(() => validate(f.profile), /required/);
});

test("settings.inspect exposes the profile's knowledge dependency scope", async t => {
  const f = fixture(t);
  f.profile.knowledge = { mode: "transitional", provider: "openviking", manifest: null, collections: ["architecture"], required: true, dependent_actions: ["implementation"] };
  f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  const result = await client.call("settings.inspect", {});
  assert.equal(result.structuredContent.knowledge.required, true);
  assert.deepEqual(result.structuredContent.knowledge.dependentActions, ["implementation"]);
  assert.equal(result.structuredContent.knowledge.state, "not_configured");
});

test("connection failure never downgrades the chosen mode or its requirements", async t => {
  const f = fixture(t); environment(t, f.env);
  const config = settings();
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Fixture outage"); });
  for (const mode of ["transitional", "kora"]) {
    f.profile.knowledge = { mode, provider: "openviking", manifest: null, collections: ["architecture"], required: true, dependent_actions: mode === "kora" ? [...WORKFLOW_ACTIONS] : ["implementation"] };
    validate(f.profile);
    for (const transport of [{ enabled: true, url: "http://127.0.0.1:1/mcp" }, { enabled: true, url: "" }, { enabled: false, url: "http://127.0.0.1:1/mcp" }]) {
      config.mcp.optional.openviking = transport;
      const before = structuredClone({ profile: f.profile, config });
      const result = await probe_connections(config, f.root, f.profile);
      assert.equal(result.knowledge.mode, mode);
      assert.equal(result.knowledge.provider, "openviking");
      assert.equal(result.knowledge.required, true);
      assert.equal(knowledge_gate(f.profile, config, "implementation").allowed, false);
      assert.deepEqual({ profile: f.profile, config }, before);
    }
  }
  delete f.profile.knowledge.mode;
  assert.throws(() => validate(f.profile), /mode/);
  f.profile.knowledge.mode = "kora"; f.profile.knowledge.required = false;
  assert.throws(() => validate(f.profile), /required/);
});

test("KORA blocks every workflow phase and cannot borrow general setup readiness", async t => {
  const f = fixture(t); environment(t, f.env);
  const config = settings(); config.active_project = f.root;
  f.profile.knowledge = { mode: "kora", provider: "openviking", manifest: null, collections: ["architecture"], required: true, dependent_actions: [...WORKFLOW_ACTIONS] };
  f.save();
  for (const action of [...WORKFLOW_ACTIONS, "knowledge_search", "workflow", "future_operation"])
    assert.equal(knowledge_gate(f.profile, config, action).allowed, false, action);
  const result = save_readiness(f.state, config, f.profile, [], { edt: { ready: true }, v8std: { ready: true }, openviking: { ready: true } });
  assert.equal(result.state, "blocked");
  assert.equal(result.knowledge.koraReady, false);
  assert.equal(result.knowledge.workflowScope, "all");
  assert.equal(guard({ cwd: f.root, tool_name: "mcp__edt__read_metadata", tool_input: {} }).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(guard({ cwd: f.root, tool_name: "mcp__1c-ai-settings__settings.inspect", tool_input: {} }), {});
  assert.equal(guard({ cwd: f.root, tool_name: "mcp__custom__settings.execute_bsl", tool_input: {} }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(guard({ cwd: f.root, tool_name: "mcp__1c-ai-settings__settings.execute_bsl", tool_input: {} }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(guard({ cwd: f.root, tool_name: "mcp__custom__core_runtime_status", tool_input: {} }).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(guard({ cwd: f.root, tool_name: "mcp__edt__core_runtime_status", tool_input: {} }), {});
  f.profile.knowledge.required = false; f.save();
  assert.deepEqual(guard({ cwd: f.root, tool_name: "mcp__1c-ai-settings__settings.inspect", tool_input: {} }), {});
  assert.deepEqual(guard({ cwd: f.root, tool_name: "mcp__1c_ai_settings__settings_profile", tool_input: {} }), {});
  const settingsClient = await session(t, "mcp/settings.mjs", [], f);
  const settingsTools = await settingsClient.request("tools/list", {});
  for (const tool of settingsTools.tools)
    assert.deepEqual(guard({ cwd: f.root, tool_name: "mcp__1c-ai-settings__" + tool.name, tool_input: {} }), {}, tool.name);
  assert.equal(guard({ cwd: f.root, tool_name: "mcp__edt__read_metadata", tool_input: {} }).hookSpecificOutput.permissionDecision, "deny");
  f.profile.knowledge.mode = "transitional";
  f.profile.knowledge.required = false;
  f.profile.knowledge.dependent_actions = [];
  validate(f.profile);
  const status = knowledge_status(f.profile, config);
  assert.equal(status.koraReady, false);
  assert.equal(status.workflowScope, "dependent_actions");
  assert.equal(knowledge_gate(f.profile, config, "design").allowed, true);
});

test("KORA blocks native relay calls, batches, resources and prompts while keeping controls available", async t => {
  const f = fixture(t);
  let workflowCalls = 0;
  const server = createServer(async (req, res) => {
    let text = ""; for await (const part of req) text += part;
    if (!text) return res.writeHead(202).end();
    const message = JSON.parse(text);
    const reply = body => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }));
    if (message.method === "server/discover") return reply({ error: { code: -32601, message: "legacy" } });
    if (message.method === "initialize") return reply({ result: { protocolVersion: "2025-11-25", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {}, resources: {}, prompts: {} } } });
    if (message.method.startsWith("notifications/")) return res.writeHead(202).end();
    if (message.method === "tools/list") return reply({ result: { tools: [{ name: "read_metadata", inputSchema: { type: "object" } }] } });
    workflowCalls++;
    reply({ result: { content: [] } });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  f.profile.connections = { edt: { url: "http://127.0.0.1:" + server.address().port + "/mcp" } };
  f.save();
  const client = await session(t, "scripts/lazy_mcp.mjs", ["--component", "edt"], f);
  await client.call("core_runtime_status", {});
  await client.call("read_metadata", {});
  assert.equal(workflowCalls, 1);
  f.profile.knowledge = { mode: "kora", provider: "openviking", manifest: null, collections: ["architecture"], required: true, dependent_actions: [...WORKFLOW_ACTIONS] }; f.save();
  const status = (await client.call("core_runtime_status", {})).structuredContent;
  assert.equal(status.knowledge.mode, "kora");
  assert.equal(status.knowledge.koraReady, false);
  await client.call("core_runtime_tools", {});
  await assert.rejects(client.call("read_metadata", {}), /Knowledge workflow blocked/);
  const batch = await client.request("tools/call", { name: "core_runtime_call", arguments: { calls: [{ name: "read_metadata", arguments: {} }, { name: "read_metadata", arguments: {} }] } });
  assert.equal(batch.isError, true);
  assert.equal(batch.structuredContent.completed, 0);
  assert.equal(batch.structuredContent.results[0].error.outcome, "not_executed");
  for (const [method, args] of [["resources/list", {}], ["resources/read", { uri: "fixture://data" }], ["prompts/get", { name: "fixture" }]])
    await assert.rejects(client.request(method, args), /Knowledge workflow blocked/);
  assert.equal(workflowCalls, 1);
});

test("mode/provider/transport/collection/requirement matrix never silently repairs contradictions", t => {
  const f = fixture(t); environment(t, f.env);
  const config = settings();
  for (const mode of ["disabled", "transitional", "kora"])
    for (const provider of ["none", "openviking"])
      for (const required of [false, true])
        for (const selected of [false, true])
          for (const enabled of [false, true])
            for (const url of ["", "http://127.0.0.1:1/mcp"]) {
              f.profile.knowledge = { mode, provider, required, manifest: null, collections: selected ? ["team"] : [],
                dependent_actions: required ? mode === "kora" ? [...WORKFLOW_ACTIONS] : ["implementation"] : [] };
              config.mcp.optional.openviking = { enabled, url };
              const label = JSON.stringify({ mode, provider, required, selected, enabled, url });
              const before = structuredClone({ profile: f.profile, config });
              const profileValid = provider === "none" ? mode === "disabled" && !required && !selected
                : mode !== "disabled" && selected && (mode !== "kora" || required);
              if (profileValid) validate(f.profile); else assert.throws(() => validate(f.profile), undefined, label);
              const status = knowledge_status(f.profile, config);
              const invalid = !profileValid || provider === "none" && enabled;
              const expected = invalid ? "invalid" : provider === "none" ? "disabled" : enabled && url ? "not_verified" : "not_configured";
              assert.equal(status.state, expected, label);
              assert.equal(status.koraReady, false, label);
              if (invalid || mode === "kora" || required)
                assert.equal(knowledge_gate(f.profile, config, "implementation").allowed, false, label);
              assert.deepEqual({ profile: f.profile, config }, before, label);
            }
});

test("malformed knowledge fields and transports fail closed without network access", async t => {
  const f = fixture(t); environment(t, f.env);
  const config = settings();
  config.mcp.optional.openviking = { enabled: true, url: "http://127.0.0.1:1/mcp" };
  const valid = { mode: "transitional", provider: "openviking", required: true, manifest: null, collections: ["team"], dependent_actions: ["implementation"] };
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network"); });
  for (const patch of [{ dependent_actions: [] }, { required: false }, { collections: ["team", "team"] }, { collections: [" "] }, { collections: "team" }, { required: "false" }, { mode: "unknown" }]) {
    f.profile.knowledge = { ...valid, ...patch };
    assert.throws(() => validate(f.profile));
    assert.equal(knowledge_gate(f.profile, config, "review").allowed, false);
    const result = await probe_connections(config, f.root, f.profile);
    assert.equal(result.external.openviking.state, "invalid");
  }
  f.profile.knowledge = valid;
  for (const transport of [{ enabled: "false", url: "http://127.0.0.1:1/mcp" }, { enabled: true, url: "http://user:password@localhost/mcp" }]) {
    config.mcp.optional.openviking = transport;
    assert.equal(knowledge_status(f.profile, config).state, "invalid");
    await probe_connections(config, f.root, f.profile);
  }
  assert.equal(network.mock.callCount(), 0);
});

test("inspection, doctor and setup report a conflicting transport without disabling or repairing it", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const backend = new SettingsBackend();
  await backend.main({ action: "update", set: { openvikingEnabled: true } });
  const saved = fs.readFileSync(f.env.EDT_AI_SETTINGS, "utf8");
  const read = await backend.main({ action: "read" });
  assert.equal(read.knowledge.state, "invalid");
  const snapshot = setup_inspection(read, f.state);
  assert.ok(snapshot.issues.some(item => item.code === "knowledge_configuration_invalid"));
  assert.ok(snapshot.nextSteps.includes("repair_knowledge_configuration"));
  const config = backend.effective(backend.current());
  const report = await inspect(f.root, config, f.state, false, true);
  assert.equal(report.status, "error");
  assert.ok(report.errors.some(item => item.includes("knowledge:")));
  const readiness = save_readiness(f.state, config, f.profile, [], {});
  assert.equal(readiness.state, "blocked");
  assert.equal(readiness.checks.find(item => item.id === "knowledge").state, "error");
  assert.equal(fs.readFileSync(f.env.EDT_AI_SETTINGS, "utf8"), saved);
  assert.equal(JSON.parse(saved).mcp.optional.openviking.enabled, true);
});
