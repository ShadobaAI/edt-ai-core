import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { edt_fixture, environment, session } from "./helpers.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { instance_directory } from "../scripts/project_paths.mjs";
import { save_readiness } from "../scripts/setup_readiness.mjs";
import { runtime_client_type, read_edt_launch } from "../scripts/edt_launch_adapter.mjs";
import { probe_yaxunit } from "../scripts/yaxunit_readiness.mjs";
import { project_profile } from "../scripts/profile.mjs";

const schema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const client = (name = "Unit tests", project = "Product", applicationId = "test-app") => ({ name, project, applicationId, type: runtime_client_type, attach: false });
async function fixture(t) {
  const f = edt_fixture(t); environment(t, f.env);
  f.profile.testing.yaxunit = true;
  f.profile.testing.yaxunit_config = { repository_id: "product", runner: "edt", results: "results" }; f.save();
  const calls = [], closed = [], data = {
    projects: [{ name: "Product", path: f.root, open: true, edtProject: true, state: "ready" }],
    configurations: [client()], applications: { Product: { project: "Product", applications: [{ id: "test-app" }], count: 1 } },
    tools: [
      { name: "list_projects", inputSchema: schema({ format: { type: "string", enum: ["json"] } }) },
      { name: "list_configurations", inputSchema: schema({ type: { type: "string", enum: ["all", "client", "attach"] } }) },
      { name: "get_applications", inputSchema: schema({ projectName: { type: "string" } }, ["projectName"]) },
      { name: "run_yaxunit_tests", inputSchema: schema({ projectName: { type: "string" }, applicationId: { type: "string" }, launchConfigurationName: { type: "string" } }) },
    ],
  };
  let hook = null;
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") { closed.push(req.headers["mcp-session-id"]); return res.writeHead(200).end(); }
    let body = ""; for await (const part of req) body += part;
    const message = JSON.parse(body); calls.push(message);
    const reply = result => res.writeHead(200, { "Content-Type": "application/json", ...(message.method === "initialize" ? { "Mcp-Session-Id": "isolated-session" } : {}) }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    const rpc = code => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code, message: "upstream-token-must-not-leak" } }));
    if (message.method === "server/discover") return rpc(-32601);
    if (message.method === "initialize") return reply({ protocolVersion: "2025-11-25", serverInfo: { name: "fixture" }, capabilities: { tools: {} } });
    if (message.method.startsWith("notifications/")) return res.writeHead(202).end();
    if (message.method === "tools/list") {
      if (req.url === "/index") return reply({ tools: [{ name: "health", inputSchema: schema() }] });
      if (req.url === "/bsl") return reply({ tools: [...["register_workspace_folder", "list_workspace_folders", "unregister_workspace_folder"].map(name => ({ name, inputSchema: schema() })), { name: "analyze", inputSchema: schema({ workspaceFolder: { type: "string" } }, ["workspaceFolder"]) }] });
      return reply({ tools: data.tools });
    }
    const { name, arguments: args } = message.params;
    if (req.url === "/index" && name === "health") return reply({ structuredContent: { mcp: { status: "ok" }, daemon: { status: "online" }, repos: data.indexRepositories || [{ repo: "product", root_path: f.root, path_status: { status: "ready" }, data_version: { stale: false } }] } });
    assert.ok(["list_projects", "list_configurations", "get_applications"].includes(name), "a readiness check must never call a mutation or runner");
    if (hook) { const handled = await hook(name, args, reply, rpc); if (handled) return; }
    const result = name === "list_projects" ? { projects: data.projects } : name === "list_configurations" ? { configurations: data.configurations, count: data.configurations.length } : data.applications[args.projectName];
    reply(data.text ? { content: [{ type: "text", text: JSON.stringify(result) }] } : { structuredContent: result });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  const backend = new SettingsBackend();
  await backend.main({ action: "update", set: { edtUrl: "http://127.0.0.1:" + server.address().port + "/mcp", codeIndexEnabled: false, bslLsEnabled: false } });
  const probe = async () => (await backend.main({ action: "probe", component: "yaxunit" }));
  const receipt = () => path.join(instance_directory(f.state, f.root), "first.readiness.json");
  return { f, backend, data, calls, closed, probe, receipt, hook: value => { hook = value; } };
}

test("missing both launch routes explains the EDT setup action and caches evidence without changing settings", async t => {
  const x = await fixture(t); x.data.configurations = []; x.data.applications.Product = { project: "Product", applications: [], count: 0 };
  const profile = fs.readFileSync(path.join(x.f.root, ".ai/project.yaml")), settings = fs.readFileSync(path.join(x.f.root, ".ai/project.local.yaml"));
  const result = await x.probe(), check = result.componentChecks[0];
  assert.equal(check.state, "not_verified"); assert.equal(check.reasonCode, "launch_required"); assert.equal(check.title, "Требуется настройка запуска");
  assert.equal(check.detail, "В EDT не найдены конфигурации запуска и приложения для связанных проектов. Подключите тестовую информационную базу и настройте запуск в EDT, затем повторите проверку");
  assert.equal(check.nextStep.code, "configure_edt"); assert.ok(fs.existsSync(x.receipt()));
  assert.deepEqual(fs.readFileSync(path.join(x.f.root, ".ai/project.yaml")), profile); assert.deepEqual(fs.readFileSync(path.join(x.f.root, ".ai/project.local.yaml")), settings);
  assert.equal(x.calls.filter(item => item.method === "tools/list").length, 1); assert.deepEqual(x.closed, ["isolated-session"]);
});

for (const named of [true, false]) for (const text of [true, false]) test(`launch settings become ready for ${named ? "an exact name" : "a project/application pair"} with ${text ? "text JSON" : "structured JSON"}`, async t => {
  const x = await fixture(t); x.data.text = text;
  if (named) { x.f.profile.testing.yaxunit_config.launch_configuration = "Unit tests"; x.f.save(); }
  const check = (await x.probe()).componentChecks[0];
  assert.equal(check.state, "ready"); assert.equal(check.title, "Готово"); assert.equal(check.reasonCode, "launch_verified");
  assert.equal(check.target.kind, named ? "configuration" : "application"); assert.equal(check.target.applicationId, "test-app");
  assert.match(check.detail, /Тесты этой проверкой не запускались/); assert.equal(x.closed.length, 1);
  const calls = x.calls.length, cache = fs.readFileSync(x.receipt());
  const read = await x.backend.main({ action: "read" }); assert.equal(read.componentChecks[0].state, "ready");
  const mcp = await session(t, "mcp/settings.mjs", [], x.f), inspect = (await mcp.call("settings.inspect", { projectRoot: x.f.root })).structuredContent;
  assert.equal(inspect.componentChecks[0].target.applicationId, "test-app"); assert.equal(x.calls.length, calls);
  assert.deepEqual(fs.readFileSync(x.receipt()), cache, "inspect must not write or renew cached evidence");
});

for (const [fault, code] of [["missing", "configuration_missing"], ["foreign", "configuration_project"], ["attach", "configuration_type"], ["application", "target_unconfirmed"], ["project", "project_mismatch"], ["building", "project_not_ready"]]) test(`explicit configuration rejects ${fault} evidence without falling back`, async t => {
  const x = await fixture(t); x.f.profile.testing.yaxunit_config.launch_configuration = "Selected"; x.f.save();
  x.data.configurations = [client("Selected"), client("Other")];
  if (fault === "missing") x.data.configurations.shift();
  if (fault === "foreign") x.data.configurations[0].project = "Another";
  if (fault === "attach") x.data.configurations[0].type = "com._1c.g5.v8.dt.launching.core.RemoteRuntime";
  if (fault === "application") x.data.configurations[0].applicationId = "missing-app";
  if (fault === "project") x.data.projects[0].path = x.f.base;
  if (fault === "building") x.data.projects[0].state = "building";
  const check = (await x.probe()).componentChecks[0];
  assert.equal(check.reasonCode, code); assert.notEqual(check.state, "ready"); assert.ok(check.nextStep.detail); assert.equal(check.target, undefined);
});

test("ambiguous launch targets offer discovered client names only", async t => {
  const x = await fixture(t); x.data.configurations.push(client("Alternative"), client("Foreign", "Other"), { ...client("Attach"), type: "attach" });
  const check = (await x.probe()).componentChecks[0]; assert.equal(check.reasonCode, "ambiguous");
  assert.deepEqual(check.choices, [{ name: "Unit tests", projectName: "Product" }, { name: "Alternative", projectName: "Product" }]);
  assert.equal(check.nextStep.code, "select_configuration");
});

test("related test extensions need no independent infobase and inherited applications do not create duplicate targets", async t => {
  const x = await fixture(t), directory = path.join(x.f.root, "Tests"); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, ".project"), "<projectDescription><name>Tests</name></projectDescription>");
  x.f.profile.repositories.push({ id: "tests", path: "Tests", alias: "tests", edt_project: "Tests" });
  Object.assign(x.f.profile.testing.yaxunit_config, { repository_id: "tests", product_repository_ids: ["product"] }); x.f.save();
  x.data.projects.push({ name: "Tests", path: directory, open: true, edtProject: true, state: "ready" });
  for (const inherited of [false, true]) {
    x.data.applications.Tests = { project: "Tests", applications: inherited ? [{ id: "test-app" }] : [], ...(inherited ? { inheritedFromProject: "Product" } : {}) };
    const check = (await x.probe()).componentChecks[0]; assert.equal(check.state, "ready"); assert.equal(check.target.projectName, "Product");
  }
});

test("YaXUnit requires every owner, framework and product EDT assignment even when optional for main work", async t => {
  const x = await fixture(t), dependencies = ["Owner", "Framework", "Dependency"];
  for (const name of dependencies) {
    const directory = path.join(x.f.root, name); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, ".project"), `<projectDescription><name>${name}</name></projectDescription>`);
    x.f.profile.repositories.push({ id: name.toLowerCase(), path: name, alias: name.toLowerCase(), edt_project: name, edt_required: false });
    x.data.projects.push({ name, path: directory, open: true, state: "ready", edtProject: true });
    x.data.applications[name] = { project: name, applications: [] };
  }
  Object.assign(x.f.profile.testing.yaxunit_config, { repository_id: "owner", framework_repository_id: "framework", product_repository_ids: ["product", "dependency"] }); x.f.save();
  const refresh = () => x.backend.main({ action: "refresh_readiness", scope: x.f.root + "#first" });
  for (const name of dependencies) {
    const project = x.data.projects.find(item => item.name === name);
    Object.assign(project, { open: false, state: "not_available" }); delete project.edtProject;
    const offset = x.calls.length, closed = await refresh(), edt = closed.componentChecks.find(item => item.id === "edt"), yaxunit = closed.componentChecks.find(item => item.id === "yaxunit");
    assert.equal(edt.state, "ready", name); assert.equal(edt.repositories.find(item => item.id === name.toLowerCase()).ready, false);
    assert.equal(yaxunit.state, "not_verified", name); assert.equal(yaxunit.reasonCode, "project_not_ready"); assert.equal(yaxunit.target, undefined);
    assert.ok(x.calls.slice(offset).filter(item => item.method === "tools/call").every(item => item.params.name === "list_projects"), "launch discovery stops before using an unready dependency");
    Object.assign(project, { open: true, state: "building", edtProject: true });
    assert.equal((await x.probe()).componentChecks[0].reasonCode, "project_not_ready", name);
    project.state = "ready";
    assert.equal((await x.probe()).componentChecks[0].state, "ready", name);
  }
  x.data.configurations = []; x.data.applications.Product.applications = []; x.data.applications.Product.count = 0;
  const result = await refresh();
  assert.equal(result.componentChecks.find(item => item.id === "edt").state, "ready");
  assert.equal(result.componentChecks.find(item => item.id === "yaxunit").reasonCode, "launch_required", "opening projects does not replace launch checks");
});

test("full setup preserves independent main, EDT and test readiness with an optional closed test project", async t => {
  const x = await fixture(t), directory = path.join(x.f.root, "Tests"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, ".project"), "<projectDescription><name>Tests</name></projectDescription>");
  x.f.profile.repositories.push({ id: "tests", path: "Tests", alias: "tests", edt_project: "Tests", edt_required: false });
  Object.assign(x.f.profile.testing.yaxunit_config, { repository_id: "tests", product_repository_ids: ["product"] }); x.f.save();
  const project = { name: "Tests", path: directory, open: false, state: "not_available" }; x.data.projects.push(project);
  x.data.applications.Tests = { project: "Tests", applications: [] };
  x.data.indexRepositories = x.f.profile.repositories.map(repo => ({ repo: repo.alias, root_path: path.join(x.f.root, repo.path), path_status: { status: "ready" }, data_version: { stale: false } }));
  const config = x.backend.current(), base = new URL(x.backend.effective(config).mcp.required.edt.url).origin;
  for (const [id, endpoint] of [["code-index", "/index"], ["bsl-ls", "/bsl"]]) Object.assign(config.mcp.managed[id], { enabled: true, mode: "external", url: base + endpoint });
  fs.writeFileSync(x.f.env.EDT_AI_SETTINGS, JSON.stringify(config));
  await x.backend.main({ action: "update", set: { codeIndexEnabled: true, bslLsEnabled: true, v8stdUrl: base + "/v8std" } });
  const check = () => x.backend.main({ action: "check", authorization: { scope: x.f.root + "#first", effects: ["launch"], evidence: "isolated setup fixture" } });
  const closed = await check();
  assert.equal(closed.fullReadiness, "not_ready"); assert.equal(closed.readiness.state, "blocked");
  assert.deepEqual(closed.readiness.mainReadiness, { scope: "setup_main", state: "ready" });
  assert.equal(closed.readiness.workflowReadiness.state, "not_checked");
  assert.equal(closed.componentChecks.find(item => item.id === "edt").state, "ready");
  assert.equal(closed.componentChecks.find(item => item.id === "code-index").state, "ready", "closed projects remain in the independent index check");
  assert.equal(closed.componentChecks.find(item => item.id === "yaxunit").reasonCode, "project_not_ready");
  const saved = (await x.backend.main({ action: "read" })).readiness;
  assert.equal(saved.state, "blocked"); assert.equal(saved.mainReadiness.state, "ready");
  assert.deepEqual(saved.checks.find(item => item.id === "edt").repositories, closed.external.edt.repositories);
  Object.assign(project, { open: true, state: "building", edtProject: true });
  await x.backend.main({ action: "refresh_readiness", component: "edt", scope: x.f.root + "#first" });
  const observed = (await x.backend.main({ action: "read" })).readiness;
  assert.equal(observed.state, "blocked"); assert.equal(observed.mainReadiness.state, "blocked");
  assert.equal(observed.checks.find(item => item.id === "edt").state, "building");
  assert.equal(observed.checkedAt, closed.readiness.checkedAt); assert.equal(observed.expiresAt, closed.readiness.expiresAt);
  const building = await check();
  assert.equal(building.componentChecks.find(item => item.id === "edt").state, "building");
  assert.equal(building.readiness.mainReadiness.state, "blocked");
  project.state = "ready";
  await x.probe();
  assert.equal((await x.backend.main({ action: "read" })).readiness.mainReadiness.state, "blocked", "test readiness must not replace an unready EDT check");
  await x.backend.main({ action: "refresh_readiness", component: "edt", scope: x.f.root + "#first" });
  const opened = (await x.backend.main({ action: "read" })).readiness;
  assert.equal(opened.state, "ready"); assert.equal(opened.mainReadiness.state, "ready");
  assert.equal(opened.expiresAt, building.readiness.expiresAt);
  const ready = await check();
  assert.equal(ready.fullReadiness, "verified"); assert.equal(ready.readiness.state, "ready"); assert.equal(ready.readiness.mainReadiness.state, "ready");
  assert.equal(ready.componentChecks.find(item => item.id === "yaxunit").state, "ready");
});

for (const fault of ["missing_api", "schema", "unknown", "malformed_row", "incomplete", "request", "rpc", "empty_format"]) test(`EDT ${fault} is never reported as an empty application list`, async t => {
  const x = await fixture(t);
  if (fault === "missing_api") x.data.tools = x.data.tools.filter(item => item.name !== "get_applications");
  if (fault === "schema") x.data.tools.find(item => item.name === "get_applications").inputSchema.required.push("newRequired");
  x.hook((name, args, reply, rpc) => {
    if (name !== "get_applications") return false;
    if (fault === "unknown") reply({ structuredContent: { project: "Product", result: [] } });
    else if (fault === "malformed_row") reply({ structuredContent: { project: "Product", applications: [{}] } });
    else if (fault === "incomplete") reply({ structuredContent: { project: "Product", applications: [], count: 2 } });
    else if (fault === "request") reply({ structuredContent: { success: false, message: "upstream-token-must-not-leak" } });
    else if (fault === "rpc") rpc(-32000);
    else if (fault === "empty_format") reply({ content: [{ type: "text", text: "No applications" }] });
    else return false;
    return true;
  });
  const check = (await x.probe()).componentChecks[0];
  assert.equal(check.reasonCode, ["missing_api", "schema"].includes(fault) ? "api_unsupported" : ["request", "rpc"].includes(fault) ? "request_failed" : "unsupported_response");
  assert.equal(check.state, ["request", "rpc"].includes(fault) ? "error" : "not_verified"); assert.ok(check.diagnostic);
  assert.doesNotMatch(JSON.stringify(check), /upstream-token-must-not-leak/); assert.equal(x.closed.length, 1);
});

test("disabled and unconfigured YaXUnit do not contact EDT", async t => {
  const x = await fixture(t); x.f.profile.testing.yaxunit = false; x.f.save();
  assert.equal((await x.probe()).componentChecks[0].state, "disabled"); assert.equal(x.calls.length, 0);
  const profile = structuredClone(x.f.profile); profile.testing = { yaxunit: true };
  assert.equal((await probe_yaxunit(x.backend.effective(x.backend.current()), x.f.root, profile)).reasonCode, "profile_missing"); assert.equal(x.calls.length, 0);
});

test("unavailable EDT produces an error with a concrete connection action", async t => {
  const x = await fixture(t); await x.backend.main({ action: "update", set: { edtUrl: "http://127.0.0.1:1/mcp" } });
  const check = (await x.probe()).componentChecks[0]; assert.equal(check.reasonCode, "edt_unavailable"); assert.equal(check.state, "error"); assert.equal(check.nextStep.code, "check_connection");
});

test("a bounded probe releases its session when a request never replies", async t => {
  const x = await fixture(t); x.hook(name => name === "get_applications");
  const options = x.backend.effective(x.backend.current()).mcp.required.edt, started = Date.now();
  await assert.rejects(read_edt_launch({ ...options, timeout_seconds: 0.8 }, ["Product"], () => null), error => ["timeout", "request_failed"].includes(error.code));
  assert.ok(Date.now() - started < 3000); assert.equal(x.closed.length, 1);
});

for (const fault of ["runner", "application_only", "no_default", "unknown_project", "duplicate", "unknown_owner"]) test(`incomplete ${fault} evidence cannot yield a green result`, async t => {
  const x = await fixture(t);
  if (fault === "runner") x.data.tools = x.data.tools.filter(item => item.name !== "run_yaxunit_tests");
  if (fault === "application_only") x.data.configurations = [];
  if (fault === "no_default") delete x.data.configurations[0].applicationId;
  if (fault === "unknown_project") delete x.data.configurations[0].project;
  if (fault === "duplicate") x.data.configurations.push(client());
  if (fault === "unknown_owner") x.data.applications.Product.inheritedFromProject = "Foreign";
  const check = (await x.probe()).componentChecks[0]; assert.notEqual(check.state, "ready"); assert.notEqual(check.reasonCode, "launch_required");
});

test("a named configuration may use the default application only when EDT confirms its identity", async t => {
  const x = await fixture(t); delete x.data.configurations[0].applicationId;
  x.data.applications.Product.defaultApplicationId = "test-app";
  x.f.profile.testing.yaxunit_config.launch_configuration = "Unit tests"; x.f.save();
  assert.equal((await x.probe()).componentChecks[0].state, "ready");
});

for (const binding of [undefined, "launch:Unit tests"]) test(`automatic selection cannot replace ${binding || "a missing application binding"} with the default application`, async t => {
  const x = await fixture(t);
  if (binding === undefined) delete x.data.configurations[0].applicationId;
  else x.data.configurations[0].applicationId = binding;
  x.data.applications.Product.defaultApplicationId = "test-app";
  const automatic = (await x.probe()).componentChecks[0];
  assert.equal(automatic.state, "not_verified"); assert.equal(automatic.reasonCode, "target_unconfirmed"); assert.equal(automatic.target, undefined);
  assert.deepEqual(automatic.choices, [{ name: "Unit tests", projectName: "Product" }]);
  x.f.profile.testing.yaxunit_config.launch_configuration = "Unit tests"; x.f.save();
  const named = (await x.probe()).componentChecks[0];
  assert.equal(named.state, "ready"); assert.equal(named.target.kind, "configuration");
  assert.equal(named.target.launchConfigurationName, "Unit tests"); assert.equal(named.target.applicationId, "test-app");
});

for (const combined of [false, true]) test(`an unrelated closed EDT project does not block ${combined ? "combined" : "addressed"} YaXUnit readiness`, async t => {
  const x = await fixture(t);
  x.data.projects.push({ name: "Unused", path: path.join(x.f.base, "Unused"), open: false, state: "closed", natures: "-" });
  const result = combined ? await x.backend.main({ action: "refresh_readiness", scope: x.f.root + "#first" }) : await x.probe();
  const check = result.componentChecks.find(item => item.id === "yaxunit");
  assert.equal(check.state, "ready"); assert.equal(check.target.projectName, "Product");
});

for (const open of [false, true]) test(`a related ${open ? "uninspected" : "closed"} project reports project readiness instead of an unsupported API`, async t => {
  const x = await fixture(t); delete x.data.projects[0].edtProject;
  Object.assign(x.data.projects[0], { open, state: open ? "ready" : "closed" });
  const check = (await x.probe()).componentChecks[0];
  assert.equal(check.reasonCode, "project_not_ready"); assert.equal(check.state, "not_verified"); assert.equal(check.target, undefined);
  assert.ok(x.calls.filter(item => item.method === "tools/call").every(item => item.params.name === "list_projects"));
});

for (const edtProject of [null, "true"]) test(`an invalid EDT nature flag ${JSON.stringify(edtProject)} remains an unsupported response`, async t => {
  const x = await fixture(t); x.data.projects[0].edtProject = edtProject;
  const check = (await x.probe()).componentChecks[0];
  assert.equal(check.reasonCode, "unsupported_response"); assert.equal(check.target, undefined);
});

test("generic connection probes keep their external scope without YaXUnit discovery calls", async t => {
  const x = await fixture(t); await x.backend.main({ action: "probe" });
  assert.ok(x.calls.filter(item => item.method === "tools/call").every(item => item.params.name === "list_projects"));
});

test("all-component refresh reuses one EDT session, catalogue and inventory for YaXUnit", async t => {
  const x = await fixture(t), result = await x.backend.main({ action: "refresh_readiness", scope: x.f.root + "#first" });
  assert.equal(result.componentChecks.length, 7); assert.equal(result.componentChecks.find(item => item.id === "edt").state, "ready");
  assert.equal(result.componentChecks.find(item => item.id === "yaxunit").state, "ready");
  assert.equal(x.calls.filter(item => item.method === "tools/list").length, 1);
  assert.equal(x.calls.filter(item => item.method === "tools/call" && item.params.name === "list_projects").length, 1);
  assert.equal(x.closed.length, 1);
});

test("an unavailable EDT does not turn disabled YaXUnit into an error during a combined refresh", async t => {
  const x = await fixture(t); x.f.profile.testing.yaxunit = false; x.f.save();
  await x.backend.main({ action: "update", set: { edtUrl: "http://127.0.0.1:1/mcp" } });
  const result = await x.backend.main({ action: "refresh_readiness", scope: x.f.root + "#first" });
  assert.equal(result.componentChecks.find(item => item.id === "yaxunit").state, "disabled");
});

test("shared EDT inventory preserves incomplete response markers instead of confirming YaXUnit", async t => {
  const x = await fixture(t);
  x.hook((name, args, reply) => { if (name !== "list_projects") return false; reply({ structuredContent: { projects: x.data.projects, partial: true } }); return true; });
  const result = await x.backend.main({ action: "refresh_readiness", scope: x.f.root + "#first" });
  assert.equal(result.componentChecks.find(item => item.id === "yaxunit").reasonCode, "unsupported_response");
  assert.equal(result.componentChecks.find(item => item.id === "edt").state, "not_verified");
  assert.equal(result.external.edt.failure.category, "server_contract");
  assert.equal(x.calls.filter(item => item.method === "tools/call" && item.params.name === "list_projects").length, 1);
});

test("a late all-component refresh cannot overwrite a newer addressed YaXUnit result", async t => {
  const x = await fixture(t); let first = true, release, entered;
  const gate = new Promise(done => { release = done; }), waiting = new Promise(done => { entered = done; });
  x.hook(async (name, args, reply) => {
    if (name !== "get_applications" || !first) return false;
    first = false; const snapshot = structuredClone(x.data.applications.Product); entered(); await gate; reply({ structuredContent: snapshot }); return true;
  });
  const pending = x.backend.main({ action: "refresh_readiness", scope: x.f.root + "#first" }); await waiting;
  x.data.configurations = []; x.data.applications.Product = { project: "Product", applications: [] };
  const newer = (await x.probe()).componentChecks[0]; assert.equal(newer.reasonCode, "launch_required");
  release(); assert.equal((await pending).superseded, true);
  const saved = (await x.backend.main({ action: "read" })).componentChecks.find(item => item.id === "yaxunit");
  assert.equal(saved.reasonCode, "launch_required"); assert.equal(saved.checkedAt, newer.checkedAt);
});

for (const olderAction of ["probe", "refresh_readiness", "check"]) for (const olderFirst of [true, false]) test(`independent MCP sessions retain newer evidence after ${olderAction}, completing ${olderFirst ? "older" : "newer"} first`, { timeout: 20000 }, async t => {
  const x = await fixture(t), a = await session(t, "mcp/settings.mjs", [], x.f), b = await session(t, "mcp/settings.mjs", [], x.f);
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const entered = [deferred(), deferred()], gates = [deferred(), deferred()]; let count = 0;
  t.after(() => gates.forEach(gate => gate.resolve()));
  x.hook(async (name, args, reply) => {
    if (name !== "get_applications") return false;
    const index = count++, snapshot = structuredClone(x.data.applications.Product);
    entered[index].resolve(); await gates[index].promise; reply({ structuredContent: snapshot }); return true;
  });
  const old = (await a.call(olderAction === "probe" ? "settings.probe_connections" : olderAction === "check" ? "settings.run_check" : "settings.refresh_readiness",
    olderAction === "probe" ? { component: "yaxunit" } : olderAction === "check" ? { authorization: { scope: x.f.root + "#first", effects: ["launch"], evidence: "isolated concurrency fixture" } } : { scope: x.f.root + "#first" })).structuredContent;
  await entered[0].promise;
  x.data.configurations = []; x.data.applications.Product = { project: "Product", applications: [], count: 0 };
  const newer = (await b.call("settings.probe_connections", { component: "yaxunit" })).structuredContent; await entered[1].promise;
  const complete = async (client, job, index) => {
    gates[index].resolve();
    const operation = (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
    assert.equal(operation.status, "completed"); return operation.result;
  };
  let oldResult, newerResult, saved;
  if (olderFirst) { oldResult = await complete(a, old, 0); newerResult = await complete(b, newer, 1); }
  else { newerResult = await complete(b, newer, 1); saved = fs.readFileSync(x.receipt()); oldResult = await complete(a, old, 0); }
  assert.equal(oldResult.superseded, true); assert.equal(newerResult.superseded, false);
  assert.equal(newerResult.componentChecks[0].reasonCode, "launch_required");
  const cached = (await x.backend.main({ action: "read" })).componentChecks.find(item => item.id === "yaxunit");
  assert.equal(cached.state, "not_verified"); assert.equal(cached.reasonCode, "launch_required");
  assert.equal(cached.checkedAt, newerResult.componentChecks[0].checkedAt);
  if (saved) assert.deepEqual(fs.readFileSync(x.receipt()), saved, "late results must not replace or renew newer evidence");
});

test("concurrent checks of different components merge without discarding either result", async t => {
  const x = await fixture(t), url = new URL(x.backend.effective(x.backend.current()).mcp.required.edt.url).origin;
  await x.backend.main({ action: "update", set: { v8stdUrl: url + "/v8std" } });
  let release, entered; const gate = new Promise(done => { release = done; }), started = new Promise(done => { entered = done; });
  t.after(() => release());
  x.hook(async name => { if (name === "get_applications") { entered(); await gate; } return false; });
  const pending = x.probe(); await started;
  const other = await x.backend.main({ action: "probe", component: "v8std" });
  release(); const yaxunit = await pending;
  assert.equal(other.superseded, false); assert.equal(yaxunit.superseded, false);
  const checks = (await x.backend.main({ action: "read" })).componentChecks;
  for (const id of ["v8std", "yaxunit"]) assert.equal(checks.find(item => item.id === id).state, "ready");
});

for (const change of ["profile", "edt_required", "connection", "project", "instance", "receipt"]) test(`a late ${change} probe cannot replace a newer context or receipt`, async t => {
  const x = await fixture(t); await x.probe(); const before = fs.readFileSync(x.receipt());
  let release, entered; const gate = new Promise(done => { release = done; }), waiting = new Promise(done => { entered = done; });
  x.hook(async name => { if (name === "get_applications") { entered(); await gate; } return false; });
  const pending = x.probe(); await waiting;
  if (change === "profile") { x.f.profile.testing.yaxunit_config.launch_configuration = "Changed"; x.f.save(); }
  if (change === "edt_required") { x.f.profile.repositories[0].edt_required = false; x.f.save(); }
  if (change === "connection") await x.backend.main({ action: "update", set: { edtUrl: "http://127.0.0.1:2/mcp" } });
  if (change === "project") process.env.EDT_AI_PROJECT_ROOT = "";
  if (change === "instance") process.env.EDT_AI_INSTANCE = "another";
  if (change === "receipt") { const receipt = JSON.parse(before); receipt.newerOperation = "retained"; fs.writeFileSync(x.receipt(), JSON.stringify(receipt)); }
  release(); const result = await pending;
  assert.equal(result.superseded, true); assert.equal(result.instance, "first");
  if (change !== "receipt") assert.deepEqual(fs.readFileSync(x.receipt()), before);
  else assert.equal(JSON.parse(fs.readFileSync(x.receipt())).newerOperation, "retained");
});

test("expiry and profile changes invalidate green evidence without renewing it", async t => {
  const x = await fixture(t), saved = (await x.probe()).componentChecks[0], cache = fs.readFileSync(x.receipt()), now = Date.now();
  t.mock.method(Date, "now", () => now + 16 * 60000);
  let check = (await x.backend.main({ action: "read" })).componentChecks[0]; assert.equal(check.state, "check_stale"); assert.equal(check.reasonCode, "check_stale"); assert.equal(check.checkedAt, saved.checkedAt); assert.equal(check.expiresAt, saved.expiresAt);
  assert.deepEqual(fs.readFileSync(x.receipt()), cache);
  t.mock.restoreAll(); x.f.profile.testing.yaxunit_config.launch_configuration = "Changed"; x.f.save();
  check = (await x.backend.main({ action: "read" })).componentChecks[0]; assert.equal(check.state, "check_stale"); assert.equal(check.target, undefined);
});

test("YaXUnit blocks full readiness until its addressed check succeeds, and partial checks preserve full receipt expiry", async t => {
  const x = await fixture(t), config = x.backend.effective(x.backend.current());
  const managed = ["code-index", "bsl-ls", "policy"].map(name => ({ name, ready: true, state: "ready" }));
  const full = save_readiness(x.f.state, config, project_profile(x.f.root), managed, { edt: { ready: true }, v8std: { ready: true } });
  assert.equal(full.state, "blocked");
  await x.probe(); let read = await x.backend.main({ action: "read" }); assert.equal(read.readiness.state, "ready"); assert.equal(read.readiness.expiresAt, full.expiresAt); assert.equal(read.readiness.checkedAt, full.checkedAt);
  x.data.configurations = []; x.data.applications.Product.applications = []; x.data.applications.Product.count = 0;
  await x.probe(); read = await x.backend.main({ action: "read" }); assert.equal(read.readiness.state, "blocked"); assert.equal(read.readiness.checks.find(item => item.id === "yaxunit").reasonCode, "launch_required");
  x.f.profile.testing.yaxunit = false; x.f.save();
  assert.equal(save_readiness(x.f.state, x.backend.effective(x.backend.current()), project_profile(x.f.root), managed, { edt: { ready: true }, v8std: { ready: true } }).state, "ready");
});

test("the full setup operation includes YaXUnit and reaches ready without executing a test runner", async t => {
  const x = await fixture(t);
  const config = x.backend.current(), base = new URL(x.backend.effective(config).mcp.required.edt.url).origin;
  for (const [id, endpoint] of [["code-index", "/index"], ["bsl-ls", "/bsl"]]) Object.assign(config.mcp.managed[id], { enabled: true, mode: "external", url: base + endpoint });
  fs.writeFileSync(x.f.env.EDT_AI_SETTINGS, JSON.stringify(config));
  await x.backend.main({ action: "update", set: { codeIndexEnabled: true, bslLsEnabled: true, v8stdUrl: base + "/v8std" } });
  const result = await x.backend.main({ action: "check", authorization: { scope: x.f.root + "#first", effects: ["launch"], evidence: "isolated setup fixture" } });
  assert.equal(result.readiness.state, "ready"); assert.equal(result.componentChecks.find(item => item.id === "yaxunit").state, "ready");
  assert.equal((await x.backend.main({ action: "read" })).readiness.state, "ready");
  assert.ok(x.calls.filter(item => item.method === "tools/call").every(item => ["list_projects", "list_configurations", "get_applications", "health"].includes(item.params.name)));
  assert.equal(x.calls.filter(item => item.method === "tools/call" && item.params.name === "list_projects").length, 1, "the full check must reuse EDT inventory");
});
