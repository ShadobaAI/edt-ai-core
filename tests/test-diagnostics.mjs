import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { fixture, environment, session, dialog_session, ROOT, node } from "./helpers.mjs";
import { LOG_POLICY, create_diagnostic_logger, read_diagnostic_logs, sanitize_diagnostics, register_diagnostic_secrets, diagnostic_state, diagnostic_journal, connection_failure, environment_compatibility } from "../scripts/diagnostics.mjs";
import { support_bundle, save_support_bundle, saved_support_report } from "../scripts/support_bundle.mjs";
import { project_directory } from "../scripts/project_paths.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { json_message } from "../scripts/mcp_codec.mjs";
import { RemoteRpcError } from "../scripts/remote_client.mjs";
import { SettingsOperations } from "../mcp/settings-operations.mjs";
import { save_readiness } from "../scripts/setup_readiness.mjs";
import { settings } from "../scripts/common.mjs";
import { instance_directory } from "../scripts/project_paths.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";

test("errors, retained operations, readiness cache and exports exclude credential representations", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const secret = 'search-credential-9831/"'; process.env.PLAIN_VALUE = secret;
  const refs = { openvikingHeadersEnv: { "X-Search": "PLAIN_VALUE" } };
  register_diagnostic_secrets(refs);
  const encoded = Buffer.from(secret).toString("base64"), arbitrary = [...secret].join(".");
  const logger = create_diagnostic_logger("fixture", f.state);
  logger.event("remote_error", { error: new RemoteRpcError({ code: -32000, message: arbitrary }) });
  logger.event("known_error", { message: secret + " " + encoded });
  const operations = new SettingsOperations(async () => ({ detail: secret + " " + encoded }));
  const job = operations.start("probe", {}, {}); await operations.wait(job.id, 1000);
  const failing = new SettingsOperations(async () => { throw new RemoteRpcError({ code: -32000, message: arbitrary }); });
  const failure = failing.start("probe", {}, {}); await failing.wait(failure.id, 1000);
  const config = settings(); config.active_project = f.root;
  save_readiness(f.state, config, f.profile, [], { edt: { ready: false, detail: secret + " " + encoded } });
  const cache = fs.readFileSync(path.join(instance_directory(f.state, f.root), "first.readiness.json"), "utf8");
  const bundle = await support_bundle({ state: f.state, configPath: f.env.EDT_AI_SETTINGS, selectedRoot: f.root,
    readCurrent: () => ({ values: refs }) });
  const outputs = [JSON.stringify(operations.status(job.id)), JSON.stringify(failing.status(failure.id)), cache,
    fs.readFileSync(path.join(f.state, "diagnostics/events.0.jsonl"), "utf8"), bundle.text].join("\n");
  for (const value of [secret, encoded, arbitrary]) assert.equal(outputs.includes(value), false);
  assert.match(failing.status(failure.id).error, /RPC -32000.*remote error text omitted/);
  const cli = node("scripts/settings_backend.mjs", [], { env: f.env, input: '{"secret":"unmarked-source-8812"' });
  assert.equal(cli.status, 1); assert.doesNotMatch(cli.stdout + cli.stderr, /unmarked-source-8812/);
});

test("bounded configuration diagnostics identify residual routes, competing connections and capture without exporting config", t => {
  const f = fixture(t), host = path.join(f.base, "host"); fs.mkdirSync(host);
  fs.mkdirSync(path.join(f.root, ".codex"));
  const text = '# auto_capture = true\n[mcp_servers.edt]\nurl = "https://private.example/mcp?token=never-export"\n[mcp_servers."old-docs"]\ncommand = "HelpSearchServer"\nargs = ["1c-docs-mcp", "secret-argument"]\nauto_capture = true\n';
  fs.writeFileSync(path.join(host, "config.toml"), text);
  fs.writeFileSync(path.join(f.root, ".codex/config.toml"), '[mcp_servers."1c-ssl-mcp"]\nenabled = false\n');
  const report = environment_compatibility({ projectRoot: f.root, pluginRoot: ROOT, codexHome: host });
  assert.equal(report.state, "attention_required");
  for (const code of ["forbidden_route", "parallel_connection", "auto_capture"])
    assert.ok(report.findings.some(item => item.code === code));
  assert.equal(report.findings.filter(item => item.code === "auto_capture").length, 1);
  assert.equal(report.hostToolCatalogue, "not_verified");
  assert.doesNotMatch(JSON.stringify(report), /never-export|secret-argument|private\.example/);
  assert.equal(fs.readFileSync(path.join(host, "config.toml"), "utf8"), text);
  fs.writeFileSync(path.join(host, "config.toml"), '[mcp_servers.old]\ncommand = "node" # "HelpSearchServer"\nargs = [\n# "1c-ssl-mcp"\n"1c-docs-mcp"\n]\n');
  const multiline = environment_compatibility({ pluginRoot: ROOT, codexHome: host });
  assert.deepEqual(multiline.findings.map(item => item.route), ["1c-docs-mcp"]);
  for (const quote of ["'''", '"""']) {
    fs.writeFileSync(path.join(host, "config.toml"), ["note = " + quote, "auto_capture = true", "[mcp_servers.1c-docs-mcp]", quote,
      "[mcp_servers.edt]", "auto_capture = true", "enabled = false"].join("\n"));
    assert.deepEqual(environment_compatibility({ pluginRoot: ROOT, codexHome: host }).findings, []);
  }
  fs.writeFileSync(path.join(host, "config.toml"), "x".repeat(256 * 1024 + 1));
  assert.equal(environment_compatibility({ pluginRoot: ROOT, codexHome: host }).sources.find(item => item.file === path.join(host, "config.toml")).state, "size_limit");
});

test("connection failures use numeric evidence and local phases instead of upstream claims", () => {
  for (const [error, phase, expected] of [
    [{ status: 401, message: "index corruption" }, "index", "authorization"],
    [{ status: 503, message: "wrong password" }, "authorization", "transport"],
    [{ code: -32602 }, "transport", "server_contract"],
    [new SyntaxError("invalid JSON"), "transport", "server_contract"],
    [{ cause: { code: "ECONNREFUSED" } }, "server_contract", "transport"],
    [new Error("authorization failed"), "index", "index"],
    [new Error("index failed"), "access_scope", "access_scope"],
  ]) assert.equal(connection_failure(error, phase).category, expected);
  assert.throws(() => json_message('{"jsonrpc":"1.0","id":1,"result":{}}'),
    error => connection_failure(error, "transport").category === "server_contract");
});

test("passive summary and support report describe knowledge without corpus contents or live probes", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network"); });
  const backend = new SettingsBackend(), current = await backend.main({ action: "read" });
  assert.equal(current.summary.knowledge.state, "disabled");
  assert.equal(current.summary.knowledge.authorizesWorkflow, false);
  const report = JSON.parse((await support_bundle({ state: f.state, configPath: f.env.EDT_AI_SETTINGS,
    selectedRoot: f.root, readCurrent: () => current })).text);
  assert.equal(report.snapshot.knowledge.configuration.provider, "none");
  assert.equal(report.snapshot.knowledge.setup.scope, "setup");
  assert.equal(report.snapshot.knowledge.liveAcceptance, "not_verified");
  assert.equal(report.snapshot.knowledge.corpusContents, "not_collected");
  assert.equal(report.snapshot.verificationLimits.hostHookActivation, "not_verified");
  assert.equal(report.snapshot.verificationLimits.serverEnforcementByPlugin, "not_verified");
  assert.equal(network.mock.callCount(), 0);
});

test("the settings journal returns a bounded newest-first window and survives corrupt log records", t => {
  const f=fixture(t);environment(t,f.env);const logger=create_diagnostic_logger("fixture",f.state);
  for(let i=0;i<240;i++)logger.event("event-"+i,{index:i,password:"hidden-secret",message:"x".repeat(2000)},i%2?"info":"error");
  fs.appendFileSync(path.join(f.state,"diagnostics/events.0.jsonl"),'{"unfinished":');
  const journal=diagnostic_journal(f.state);
  assert.equal(journal.total,240);assert.equal(journal.truncated,true);
  assert.ok(journal.events.length<=200);assert.ok(Buffer.byteLength(JSON.stringify(journal.events))<260*1024);
  assert.equal(journal.events[0].event,"event-239");assert.equal(journal.events[0].detail.password,"[REDACTED]");
  assert.ok(journal.issues.length);assert.equal(fs.existsSync(path.join(f.state,"runtime")),false);
});

test("journal events and session metadata stay app-only and remain readable with broken settings", async t => {
  const f=fixture(t);f.save();fs.writeFileSync(f.env.EDT_AI_SETTINGS,"broken: [");
  create_diagnostic_logger("fixture",f.state).event("fixture-error",{token:"private-token",message:"ECONNREFUSED"},"error");
  const client=await session(t,"mcp/settings.mjs",[],f),tools=(await client.request("tools/list")).tools;
  assert.deepEqual(tools.find(tool=>tool.name==="settings.diagnostics")._meta.ui.visibility,["app"]);
  const result=await client.call("settings.diagnostics",{}),journal=result._meta.data;
  assert.equal(result.structuredContent,undefined);assert.doesNotMatch(JSON.stringify(result.content),/fixture-error|ECONNREFUSED|private-token/);
  assert.ok(journal.events.some(event=>event.event==="fixture-error"));assert.doesNotMatch(JSON.stringify(journal),/private-token/);
  assert.match(journal.runtime.node,/^v\d/);assert.equal(journal.session.projectRoot,f.root);
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});

test("diagnostic storage follows CODEX_HOME, rotates within 2 MiB and expires old events", t => {
  const f = fixture(t); environment(t, f.env);
  delete process.env.EDT_AI_STATE_DIR; process.env.CODEX_HOME = f.base;
  assert.equal(diagnostic_state(), path.join(f.base, "1c-ai-core"));
  process.env.EDT_AI_STATE_DIR = f.state;
  const logger = create_diagnostic_logger("fixture"), directory = path.join(f.state, "diagnostics");
  for (let index = 0; index < 420; index++) assert.equal(logger.event("sample", { index, message: "Я".repeat(3000) }), true);
  const files = fs.readdirSync(directory);
  assert.equal(files.length, LOG_POLICY.files);
  assert.ok(files.every(name => fs.statSync(path.join(directory, name)).size <= LOG_POLICY.fileBytes));
  const { events, issues } = read_diagnostic_logs();
  assert.deepEqual(issues, []); assert.equal(events.at(-1).detail.index, 419); assert.ok(events[0].detail.index > 0);
  assert.equal(logger.event("huge", { message: "Ж".repeat(20000) }), true);
  assert.equal(read_diagnostic_logs().events.at(-1).detail.truncated, true);
  const old = path.join(directory, "events.3.jsonl"), earlier = new Date(Date.now() - 8 * 86400000);
  fs.utimesSync(old, earlier, earlier); logger.event("cleanup");
  assert.equal(fs.existsSync(old), false);
  fs.appendFileSync(path.join(directory, "events.0.jsonl"), '{"unfinished":');
  assert.ok(read_diagnostic_logs().issues.some(issue => /invalid record/.test(issue)));
});

test("concurrent plugin processes leave complete records under one shared size limit", async t => {
  const f = fixture(t), source = pathToFileURL(path.join(ROOT, "scripts/diagnostics.mjs")).href;
  const workers = Array.from({ length: 3 }, (_, worker) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {create_diagnostic_logger} from ${JSON.stringify(source)}; const logger=create_diagnostic_logger('worker-${worker}'), written=[]; for(let i=0;i<100;i++) if(logger.event('concurrent',{i})) written.push(i); process.stdout.write(JSON.stringify({session:logger.session,written}));`], { env: f.env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { output += chunk; });
    child.once("error", reject); child.once("close", code => { if (code !== 0) reject(new Error("Worker exited " + code)); else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } } });
  }));
  const completed = await Promise.all(workers);
  const logs = read_diagnostic_logs(f.state);
  assert.deepEqual(logs.issues, []);
  const expected = completed.flatMap(({ session, written }) => written.map(i => `${session}:${i}`)).sort();
  assert.ok(expected.length > 0);
  assert.deepEqual(logs.events.map(event => `${event.session}:${event.detail.i}`).sort(), expected);
});

test("secrets are removed before logging and again on export, with URLs still diagnosable", t => {
  const f = fixture(t); environment(t, f.env);
  process.env.CUSTOM_HEADER_VALUE = "custom-credential-983214";
  process.env.SERVICE_PASSWORD = "password-983214";
  register_diagnostic_secrets({ headers_env: { "X-Private": "CUSTOM_HEADER_VALUE" } });
  const value = { password: "inline-password", apiKey: "inline-key", env: { PUBLIC: "private" }, args: ["--secret", "value"],
    url: "https://person:passwd@host.invalid:8042/mcp?key=url-secret#fragment-secret",
    message: "CUSTOM custom-credential-983214 password-983214 Bearer bearer-secret token=plain-secret api_key=quoted-secret" };
  const logger = create_diagnostic_logger("fixture", f.state); logger.event("failure", value, "error");
  const stored = fs.readFileSync(path.join(f.state, "diagnostics/events.0.jsonl"), "utf8");
  for (const secret of ["inline-password", "inline-key", "custom-credential", "password-983214", "bearer-secret", "plain-secret", "quoted-secret", "url-secret", "fragment-secret", "person", "passwd@"])
    assert.equal(stored.includes(secret), false, secret);
  assert.match(stored, /https:\/\/host.invalid:8042\/mcp/);
  assert.equal(sanitize_diagnostics(value).args, "[OMITTED]");
});

test("support collection is partial, bounded, read-only and does not include source or chat files", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  fs.writeFileSync(path.join(f.root, "src/private.bsl"), "SOURCE-MUST-NOT-BE-EXPORTED");
  fs.writeFileSync(path.join(f.state, "chat.json"), "CHAT-MUST-NOT-BE-EXPORTED");
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, '{"password":"malformed-secret",');
  fs.writeFileSync(path.join(f.state, "runtime-lock.json"), JSON.stringify({ oversized: "x".repeat(300000) }));
  create_diagnostic_logger("fixture", f.state).event("failure", { message: "ECONNREFUSED", projectRoot: f.root });
  const before = fs.readFileSync(path.join(f.root, ".ai/project.yaml"));
  const exported = await support_bundle({ state: f.state, configPath: f.env.EDT_AI_SETTINGS, selectedRoot: f.root,
    operation: { status: "running", action: "check" }, readCurrent: () => { throw new Error("broken settings"); } });
  const report = JSON.parse(exported.text);
  assert.equal(report.format, "1c-ai-core-diagnostics"); assert.equal(report.snapshot.settings.invalid, true);
  assert.equal(report.snapshot.runtimeArtifacts.omitted, "file_size_limit");
  assert.equal(report.snapshot.host.operation.status, "running");
  assert.ok(report.collection.issues.some(issue => issue.section === "current"));
  for (const secret of ["SOURCE-MUST-NOT", "CHAT-MUST-NOT", "malformed-secret"]) assert.equal(exported.text.includes(secret), false);
  assert.deepEqual(fs.readFileSync(path.join(f.root, ".ai/project.yaml")), before);
  assert.equal(fs.existsSync(path.join(f.state, "runtime")), false);
});

test("export is app-only, contains no report in model content and survives corrupt settings", async t => {
  const f = fixture(t); f.save();
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, "broken: [\n  private-unmarked-598213");
  const { client, choose } = await dialog_session(t, f); choose(path.join(f.base, "diagnostics.json"));
  const tools = (await client.request("tools/list")).tools;
  assert.deepEqual(tools.find(tool => tool.name === "settings.export_diagnostics")._meta.ui.visibility, ["app"]);
  assert.deepEqual(tools.find(tool => tool.name === "settings.open_diagnostics_directory")._meta.ui.visibility, ["app"]);
  assert.equal(tools.find(tool => tool.name === "settings.export_diagnostics").annotations.readOnlyHint, false);
  const opened = await client.call("settings.open", {});
  assert.equal(opened.structuredContent.configurationError, true);
  const result = await client.call("settings.export_diagnostics", {}), text = fs.readFileSync(result._meta.data.path, "utf8"), report = JSON.parse(text);
  assert.equal(result.structuredContent, undefined);
  assert.equal(JSON.stringify(result.content).includes(f.root), false);
  assert.equal(report.snapshot.settings.invalid, true);
  assert.equal(report.snapshot.current.unavailable, true);
  assert.equal(result._meta.data.text, undefined);
  assert.equal(text.includes("private-unmarked-598213"), false);
  assert.equal(JSON.stringify(result.content).includes(f.state), false);
  assert.ok(report.events.some(event => event.event === "settings_unavailable"));
});

test("an unbound settings app can export without creating a project or preparing runtimes", async t => {
  const f = fixture(t), { client, choose } = await dialog_session(t, f, { extra: { EDT_AI_PROJECT_ROOT: "" }, roots: [] });
  choose(path.join(f.base, "diagnostics.json"));
  client.notify("notifications/roots/list_changed");
  const result = await client.call("settings.export_diagnostics", {}), report = JSON.parse(fs.readFileSync(result._meta.data.path, "utf8"));
  assert.equal(report.snapshot.host.selectedRoot, null);
  assert.equal(report.snapshot.project, undefined);
  assert.equal(fs.existsSync(path.join(f.root, ".ai")), false);
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS), false);
});

test("support export writes one real file and a failed replacement preserves the previous report", t => {
  const f = fixture(t), first = '{"format":"1c-ai-core-diagnostics","sequence":1}', target = path.join(f.base, "support.json");
  assert.throws(() => save_support_bundle(f.state, { text: first }), /Выберите место/);
  const saved = save_support_bundle(f.state, { text: first }, target);
  assert.equal(saved.path, target);
  assert.equal(fs.readFileSync(saved.path, "utf8"), first);
  const second = '{"format":"1c-ai-core-diagnostics","sequence":2}';
  assert.equal(save_support_bundle(f.state, { text: second }, target).path, saved.path);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === saved.path) throw Object.assign(new Error("Disk unavailable"), { code: "EACCES" }); return rename(from, to); };
  try { assert.throws(() => save_support_bundle(f.state, { text: first }, target), /Disk unavailable/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(saved.path, "utf8"), second);
  assert.equal(saved_support_report(f.state), null);
  assert.equal(fs.readdirSync(saved.directory).some(name => name.startsWith(".core-")), false);
});

test("failed disk export returns an error instead of a prepared-file success", async t => {
  const f = fixture(t), { client, choose } = await dialog_session(t, f);
  choose(f.base);
  const response = await client.request("tools/call", { name: "settings.export_diagnostics", arguments: {} });
  assert.equal(response.isError, true);
  assert.equal(response._meta, undefined);
  assert.equal(saved_support_report(f.state), null);
  await assert.rejects(client.call("settings.open_diagnostics_directory", {}), /Сначала сохраните/);
  await assert.rejects(client.call("settings.open_diagnostics_directory", { path: f.base }), /Неизвестное поле/);
});

test("a logging failure never breaks the operation or prevents support export", async t => {
  const f = fixture(t), state = path.join(f.base, "not-a-directory"); fs.writeFileSync(state, "file");
  const logger = create_diagnostic_logger("fixture", state);
  assert.equal(logger.event("test"), false); assert.equal(logger.status().dropped, 1);
  const report = JSON.parse((await support_bundle({ state, configPath: path.join(state, "settings.json"), selectedRoot: null, loggerStatus: logger.status() })).text);
  assert.equal(report.snapshot.host.loggerStatus.dropped, 1);
  assert.ok(report.collection.issues.length);
});

test("native logs contribute metadata without copying untrusted runtime contents", async t => {
  const f = fixture(t); environment(t, f.env);
  process.env.CUSTOM_SUPPORT_HEADER = "custom-support-secret-184782";
  f.profile.connections = { edt: { url: "http://localhost:4000/mcp", headers_env: { "X-Custom": "CUSTOM_SUPPORT_HEADER" } } }; f.save();
  const home = path.join(project_directory(f.state, f.root), "code-index"); fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "stderr.log"), "old-error\n" + "x".repeat(100000) + "\nLatest error: " + process.env.CUSTOM_SUPPORT_HEADER);
  const directory = path.join(f.state, "diagnostics"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "events.0.jsonl"), JSON.stringify({ time: new Date().toISOString(), detail: { message: process.env.CUSTOM_SUPPORT_HEADER } }) + "\n");
  const result = await support_bundle({ state: f.state, configPath: f.env.EDT_AI_SETTINGS, selectedRoot: f.root });
  assert.equal(result.text.includes(process.env.CUSTOM_SUPPORT_HEADER), false);
  const report = JSON.parse(result.text);
  assert.ok(report.snapshot.codeIndex_stderr.bytes > 100000);
  assert.equal(report.snapshot.codeIndex_stderr.omitted, "untrusted_runtime_log_content");
  assert.equal(report.snapshot.codeIndex_stderr.tail, undefined);
  assert.equal(result.text.includes("old-error"), false);
});

test("relay logs diagnose transport failures without recording tool arguments or results", async t => {
  const f = fixture(t), server = http.createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    if (!body) { response.writeHead(200); response.end(); return; }
    const message = JSON.parse(body);
    if (!Object.hasOwn(message, "id")) { response.writeHead(202); response.end(); return; }
    if (message.method === "server/discover") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Use initialize" } })); return;
    }
    const result = message.method === "initialize" ? { protocolVersion: "2025-11-25", serverInfo: { name: "fixture", version: "1" }, capabilities: {} }
      : message.method === "tools/list" ? { tools: [{ name: "private_action", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: "PRIVATE-RESULT-73482" }] };
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  f.profile.connections = { edt: { url: `http://127.0.0.1:${server.address().port}/mcp` } }; f.save();
  const client = await session(t, "scripts/lazy_mcp.mjs", ["--component", "edt"], f);
  await client.call("private_action", { source: "PRIVATE-ARGUMENT-73482" });
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(client.call("private_action", {}));
  const logs = read_diagnostic_logs(f.state), text = JSON.stringify(logs.events);
  assert.ok(logs.events.some(event => event.event === "request_started" && event.detail.tool === "private_action"));
  assert.ok(logs.events.some(event => event.event === "request_failed"));
  assert.match(text, /ECONNREFUSED/);
  assert.equal(text.includes("PRIVATE-ARGUMENT"), false);
  assert.equal(text.includes("PRIVATE-RESULT"), false);
});

test("a credential matching ready cannot rename operational keys or change readiness states", async t => {
  const f = fixture(t); environment(t, f.env); f.save(); process.env.PLAIN_VALUE = "ready";
  register_diagnostic_secrets({ headers_env: { "X-Search": "PLAIN_VALUE" } });
  const operations = new SettingsOperations(async () => ({ ready: true, state: "ready", detail: "ready" }));
  const job = operations.start("probe", {}, {}); await operations.wait(job.id, 1000);
  assert.equal(operations.status(job.id).result.ready, true);
  assert.equal(operations.status(job.id).result.state, "ready");
  assert.equal(operations.status(job.id).result.detail, "[REDACTED]");
  const config = settings(); config.active_project = f.root;
  const result = save_readiness(f.state, config, f.profile, [], { edt: { ready: true, detail: "ready" } });
  assert.equal(result.state, "ready");
  assert.ok(result.checks.every(item => ["ready", "disabled"].includes(item.state)));
  const cache = JSON.parse(fs.readFileSync(path.join(instance_directory(f.state, f.root), "first.readiness.json"), "utf8"));
  assert.equal(cache.result.state, "ready");
  assert.equal(cache.result.checks.find(item => item.id === "edt").detail, "[REDACTED]");
});

test("stdio timeout and exit omit stderr while preserving an unknown operation outcome", async t => {
  const f = fixture(t); environment(t, f.env);
  const encoded = [..."search-credential-7621"].join(".");
  for (const exit of [false, true]) {
    const client = new McpClient([process.execPath, "-e", `process.stderr.write(${JSON.stringify(encoded)});${exit ? "process.exit(3)" : "setInterval(()=>{},1000)"}`], f.root, f.env, 0.3);
    f.clients.push(client);
    await assert.rejects(client.request("initialize"), error => error.outcomeUnknown === true &&
      /outcome unknown/.test(error.message) && !error.message.includes(encoded));
    assert.equal(client.stderr.includes(encoded), false);
  }
});

test("legacy request failure records cannot export arbitrary encoded credentials", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const encoded = [..."private-credential-8193"].join("~");
  fs.mkdirSync(path.join(f.state, "diagnostics"));
  fs.writeFileSync(path.join(f.state, "diagnostics/events.0.jsonl"), JSON.stringify({ time: new Date().toISOString(), event: "request_failed",
    detail: { error: { message: encoded, stack: encoded } } }) + "\n");
  const events = read_diagnostic_logs(f.state).events;
  assert.equal(events[0].event, "legacy_event");
  assert.equal(events[0].detail.omitted, "untrusted_legacy_record");
  const bundle = await support_bundle({ state: f.state, configPath: f.env.EDT_AI_SETTINGS, selectedRoot: f.root });
  assert.equal((JSON.stringify(events) + bundle.text).includes(encoded), false);
});
