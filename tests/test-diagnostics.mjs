import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { fixture, environment, session, dialog_session, ROOT, node } from "./helpers.mjs";
import { LOG_POLICY, create_diagnostic_logger, read_diagnostic_logs, sanitize_diagnostics, register_diagnostic_secrets, diagnostic_state, diagnostic_journal, diagnostic_failure, diagnostic_id, diagnostic_project_id, connection_failure, environment_compatibility } from "../scripts/diagnostics.mjs";
import { support_bundle, saved_support_report, detailed_log_export } from "../scripts/support_bundle.mjs";

import { save_export_to_path } from "../scripts/settings_export.mjs";
import { project_directory } from "../scripts/project_paths.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { json_message } from "../scripts/mcp_codec.mjs";
import { RemoteRpcError } from "../scripts/remote_client.mjs";
import { SettingsOperations } from "../mcp/settings-operations.mjs";
import { save_readiness } from "../scripts/setup_readiness.mjs";
import { settings } from "../scripts/common.mjs";
import { instance_directory } from "../scripts/project_paths.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";

test("detailed log export filters the requested period and sanitizes event details", t => {
  const f = fixture(t), logger = create_diagnostic_logger("fixture", f.state);
  logger.event("operation_failed", { token: "private-secret", projectRoot: f.root });
  const recent = detailed_log_export(f.state, 1), future = detailed_log_export(f.state, 1, Date.now() + 2 * 86400000);
  assert.match(recent.text, /operation_failed/);
  assert.doesNotMatch(recent.text, /private-secret/);
  assert.doesNotMatch(future.text, /operation_failed/);
  assert.throws(() => detailed_log_export(f.state, 30), /период/);
});

test("errors, retained operations, readiness cache and exports exclude credential representations", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const secret = 'search-credential-9831/"'; process.env.PLAIN_VALUE = secret;
  const refs = { headers_env: { "X-Search": "PLAIN_VALUE" } };
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
  assert.match(failing.status(failure.id).error, /RPC -32000.*текст внешней ошибки скрыт/);
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
  assert.equal(journal.events[0].event,"event-239");assert.equal(journal.events[0].detail.password,undefined);
  assert.ok(journal.issues.length);assert.equal(journal.stats.invalidRecords,1);assert.equal(fs.existsSync(path.join(f.state,"runtime")),false);
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

test("journal state enums remain stable when a credential happens to have the same value", async t => {
  const f = fixture(t); f.env.SERVICE_PASSWORD = "ready";
  create_diagnostic_logger("edt", f.state).event("component_observed", { projectRoot: f.root, component: "edt", state: "ready" });
  const client = await session(t, "mcp/settings.mjs", [], f);
  const journal = (await client.call("settings.diagnostics", {}))._meta.data;
  assert.equal(journal.events.find(event => event.event === "component_observed").detail.state, "ready");
});

test("diagnostic storage follows CODEX_HOME, rotates within its bound and expires old events", t => {
  const f = fixture(t); environment(t, f.env);
  delete process.env.EDT_AI_STATE_DIR; process.env.CODEX_HOME = f.base;
  assert.equal(diagnostic_state(), path.join(f.base, "1c-ai-core"));
  process.env.EDT_AI_STATE_DIR = f.state;
  const logger = create_diagnostic_logger("fixture"), directory = path.join(f.state, "diagnostics");
  assert.equal(logger.event("sample", { index: 1 }), true);
  const sample = JSON.parse(fs.readFileSync(path.join(directory, "events.0.jsonl"), "utf8"));
  const filler = JSON.stringify({ ...sample, padding: "x".repeat(6000) }) + "\n";
  const full = filler.repeat(Math.floor((LOG_POLICY.fileBytes - 100) / Buffer.byteLength(filler)));
  for (let index = 0; index < LOG_POLICY.files; index++) fs.writeFileSync(path.join(directory, `events.${index}.jsonl`), full);
  fs.appendFileSync(path.join(directory, "events.0.jsonl"), " ".repeat(LOG_POLICY.fileBytes - Buffer.byteLength(full) - 100));
  assert.equal(logger.event("sample", { index: 419 }), true);
  const files = fs.readdirSync(directory);
  assert.equal(files.length, LOG_POLICY.files);
  assert.ok(files.every(name => fs.statSync(path.join(directory, name)).size <= LOG_POLICY.fileBytes));
  const { events, issues } = read_diagnostic_logs();
  assert.deepEqual(issues, []); assert.equal(events.at(-1).detail.index, 419); assert.equal(events.at(-1).rotatedBefore, true);
  assert.equal(logger.event("huge", { message: "Ж".repeat(20000) }), true);
  assert.equal(read_diagnostic_logs().events.at(-1).detail.message, undefined);
  const old = path.join(directory, "events.3.jsonl"), earlier = new Date(Date.now() - 8 * 86400000);
  fs.utimesSync(old, earlier, earlier); logger.event("cleanup");
  assert.equal(fs.existsSync(old), false);
  fs.appendFileSync(path.join(directory, "events.0.jsonl"), '{"unfinished":');
  assert.ok(read_diagnostic_logs().issues.some(issue => /invalid record/.test(issue)));
});

test("concurrent plugin processes leave complete records under one shared size limit", async t => {
  const f = fixture(t), source = pathToFileURL(path.join(ROOT, "scripts/diagnostics.mjs")).href;
  const workers = Array.from({ length: 3 }, (_, worker) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {create_diagnostic_logger} from ${JSON.stringify(source)}; const logger=create_diagnostic_logger('worker-${worker}'), written=[]; for(let i=0;i<100;i++) if(logger.event('concurrent',{i},i%3?'info':'error')) written.push(i); process.stdout.write(JSON.stringify({session:logger.session,written}));`], { env: f.env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
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

test("diagnostic events omit arbitrary text and URLs before writing", t => {
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
  assert.doesNotMatch(stored, /host\.invalid|\/mcp/);
  assert.equal(sanitize_diagnostics(value).args, "[OMITTED]");
});

test("user supplied request identifiers are hashed even when they look like a stored hash", t => {
  const f = fixture(t), logger = create_diagnostic_logger("edt", f.state), raw = "0123456789abcdef01234567";
  logger.event("request_started", { requestId: raw, projectRoot: f.root });
  logger.event("request_completed", { requestId: raw, projectRoot: f.root });
  logger.event("request_started", { requestId: 1, projectRoot: f.root });
  logger.event("request_started", { requestId: "1", projectRoot: f.root });
  const stored = fs.readFileSync(path.join(f.state, "diagnostics/events.0.jsonl"), "utf8");
  const events = read_diagnostic_logs(f.state).events;
  assert.doesNotMatch(stored, new RegExp(raw));
  assert.equal(events[0].detail.requestId, events[1].detail.requestId);
  assert.notEqual(events[2].detail.requestId, events[3].detail.requestId);
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4]);
});

test("support collection is partial, bounded, read-only and does not include source or chat files", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  fs.writeFileSync(path.join(f.root, "src/private.bsl"), "SOURCE-MUST-NOT-BE-EXPORTED");
  fs.writeFileSync(path.join(f.state, "chat.json"), "CHAT-MUST-NOT-BE-EXPORTED");
  fs.mkdirSync(path.join(f.root, ".ai/instances"), { recursive: true });
  fs.writeFileSync(path.join(f.root, ".ai/instances/first.local.yaml"), "legacy: LEGACY-INSTANCE-MUST-NOT-BE-EXPORTED\n");
  fs.mkdirSync(instance_directory(f.state, f.root), { recursive: true });
  fs.writeFileSync(path.join(instance_directory(f.state, f.root), "first.yaml"), "legacy: LEGACY-STATE-MUST-NOT-BE-EXPORTED\n");
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
  for (const secret of ["SOURCE-MUST-NOT", "CHAT-MUST-NOT", "malformed-secret", "LEGACY-INSTANCE-MUST-NOT", "LEGACY-STATE-MUST-NOT"]) assert.equal(exported.text.includes(secret), false);
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

test("detailed log export is app-only and writes a sanitized text file through MCP", async t => {
  const f=fixture(t);create_diagnostic_logger("fixture",f.state).event("operation_failed",{token:"not-for-export"});
  const {client,choose}=await dialog_session(t,f);choose(path.join(f.base,"events.txt"));
  const tools=(await client.request("tools/list")).tools;
  assert.deepEqual(tools.find(tool=>tool.name==="settings.export_log")._meta.ui.visibility,["app"]);
  const result=await client.call("settings.export_log",{days:3}), text=fs.readFileSync(result._meta.data.path,"utf8");
  assert.match(text,/operation_failed/);assert.doesNotMatch(text,/not-for-export/);assert.equal(result._meta.data.text,undefined);
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
  assert.throws(() => save_export_to_path("", { text: first }), /абсолютный путь/);
  const saved = save_export_to_path(target, { text: first }, 16 * 1024 * 1024);
  assert.equal(saved.path, target);
  assert.equal(fs.readFileSync(saved.path, "utf8"), first);
  const second = '{"format":"1c-ai-core-diagnostics","sequence":2}';
  assert.equal(save_export_to_path(target, { text: second }, 16 * 1024 * 1024).path, saved.path);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === saved.path) throw Object.assign(new Error("Disk unavailable"), { code: "EACCES" }); return rename(from, to); };
  try { assert.throws(() => save_export_to_path(target, { text: first }, 16 * 1024 * 1024), /Disk unavailable/); }
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
  fs.writeFileSync(path.join(home, "daemon.log"), "old-error\n" + "x".repeat(100000) + "\nLatest error: " + process.env.CUSTOM_SUPPORT_HEADER);
  const directory = path.join(f.state, "diagnostics"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "events.0.jsonl"), JSON.stringify({ time: new Date().toISOString(), detail: { message: process.env.CUSTOM_SUPPORT_HEADER } }) + "\n");
  const result = await support_bundle({ state: f.state, configPath: f.env.EDT_AI_SETTINGS, selectedRoot: f.root });
  assert.equal(result.text.includes(process.env.CUSTOM_SUPPORT_HEADER), false);
  const report = JSON.parse(result.text);
  assert.ok(report.snapshot["codeIndex_daemon.log"].bytes > 100000);
  assert.equal(report.snapshot["codeIndex_daemon.log"].omitted, "untrusted_runtime_log_content");
  assert.equal(report.snapshot["codeIndex_daemon.log"].tail, undefined);
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
  assert.ok(logs.events.some(event => event.event === "request_started" && event.detail.toolId === diagnostic_id("private_action")));
  assert.ok(logs.events.some(event => event.event === "request_failed"));
  assert.match(text, /ECONNREFUSED/);
  assert.equal(text.includes("PRIVATE-ARGUMENT"), false);
  assert.equal(text.includes("PRIVATE-RESULT"), false);
});

test("unbound relay discovery does not flood the journal and later binding failures remain visible", async t => {
  const f = fixture(t); f.save();
  const client = new McpClient([process.execPath, path.join(ROOT, "scripts/lazy_mcp.mjs"), "--component", "edt"], ROOT,
    { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10);
  f.clients.push(client); client.roots = []; await client.initialize();
  for (let i = 0; i < 4; i++) await client.request("tools/list");
  assert.deepEqual(read_diagnostic_logs(f.state).events, []);
  await client.call("core_runtime_status", { projectRoot: f.root });
  const events = read_diagnostic_logs(f.state).events;
  assert.ok(events.some(event => event.event === "connection_failed" && event.detail.projectId === diagnostic_project_id(f.root)));
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

test("unsupported diagnostic records cannot export arbitrary encoded credentials", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const encoded = [..."private-credential-8193"].join("~");
  fs.mkdirSync(path.join(f.state, "diagnostics"));
  fs.writeFileSync(path.join(f.state, "diagnostics/events.0.jsonl"), JSON.stringify({ time: new Date().toISOString(), event: "request_failed",
    detail: { error: { message: encoded, stack: encoded } } }) + "\n");
  const { events, issues, stats } = read_diagnostic_logs(f.state);
  assert.deepEqual(events, []);
  assert.ok(issues.includes("Unsupported log format: record details omitted"));
  assert.equal(stats.unsupportedRecords, 1);
  const bundle = await support_bundle({ state: f.state, configPath: f.env.EDT_AI_SETTINGS, selectedRoot: f.root });
  assert.equal((JSON.stringify(events) + bundle.text).includes(encoded), false);
});

test("failure evidence uses codes and never trusts unstructured error messages", () => {
  for (const [error, category, reason] of [
    [{ code: "ECONNREFUSED", message: "arbitrary" }, "connection", "connection_failed"],
    [{ code: "ETIMEDOUT" }, "timeout", "timeout"],
    [{ name: "AbortError" }, "cancelled", "cancelled"],
    [{ code: "RUNTIME_BUSY" }, "blocked", "runtime_busy"],
    [{ outcomeUnknown: true }, "outcome_unknown", "outcome_unknown"],
    [{ status: 403 }, "authorization", "authorization_denied"],
    [{ status: 408 }, "timeout", "timeout"],
    [{ status: 429 }, "blocked", "rate_limited"],
    [{ status: 503 }, "remote_error", "remote_error"],
    [{ code: -32602 }, "contract", "invalid_response"],
    [{ code: -32000 }, "remote_error", "remote_error"],
    [{ message: "timeout and password" }, "unknown", "unknown_failure"],
  ]) { const failure = diagnostic_failure(error); assert.equal(failure.category, category); assert.equal(failure.reasonCode, reason); }
  assert.equal(diagnostic_failure({ outcomeUnknown: true, code: "ETIMEDOUT" }).causeCategory, "timeout");
});

test("legacy stderr warnings become informational and arbitrary legacy details stay out of exports", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const directory = path.join(f.state, "diagnostics"); fs.mkdirSync(directory);
  const old = { formatVersion: 2, time: new Date().toISOString(), component: "edt", session: "b75d4132-d0e6-49d9-8348-40521e3437fa", instance: "first",
    event: "runtime_stderr", level: "warning", detail: { projectRoot: f.root, bytes: 12, content: "unmarked-legacy-secret-7981" } };
  fs.writeFileSync(path.join(directory, "events.0.jsonl"), JSON.stringify(old) + "\n");
  const events = read_diagnostic_logs(f.state).events;
  assert.equal(events[0].level, "info"); assert.equal(events[0].detail.bytes, 12);
  assert.equal(events[0].detail.projectId, diagnostic_project_id(f.root));
  const report = await support_bundle({ state: f.state, configPath: f.env.EDT_AI_SETTINGS, selectedRoot: f.root });
  assert.doesNotMatch(report.text, /unmarked-legacy-secret-7981/);
});

test("legacy truncated records keep the truncation marker without exporting their summaries", t => {
  const f = fixture(t), directory = path.join(f.state, "diagnostics"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "events.0.jsonl"), JSON.stringify({ formatVersion: 2, time: new Date().toISOString(), component: "settings",
    event: "operation_failed", level: "error", detail: { truncated: true, summary: "unmarked-truncated-secret-192" } }) + "\n");
  const { events } = read_diagnostic_logs(f.state);
  assert.equal(events[0].detail.truncated, true);
  assert.doesNotMatch(JSON.stringify(events), /unmarked-truncated-secret-192/);
});

test("priority retention keeps an error after ordinary log rotation without duplicate records", t => {
  const f = fixture(t), logger = create_diagnostic_logger("settings", f.state);
  logger.event("request_failed", { projectRoot: f.root, error: Object.assign(new Error("private"), { code: "EACCES" }) }, "error");
  assert.equal(read_diagnostic_logs(f.state).events.filter(event => event.event === "request_failed").length, 1);
  const directory = path.join(f.state, "diagnostics"), original = JSON.parse(fs.readFileSync(path.join(directory, "events.0.jsonl"), "utf8"));
  const filler = JSON.stringify({ ...original, recordId: "4909a832-4ad4-4d3d-8270-9f149b23f787", event: "request_started", level: "info", padding: "x".repeat(6000) }) + "\n";
  const content = filler.repeat(Math.floor((LOG_POLICY.fileBytes - 100) / Buffer.byteLength(filler)));
  for (let index = 0; index < LOG_POLICY.files; index++) fs.writeFileSync(path.join(directory, `events.${index}.jsonl`), content);
  fs.appendFileSync(path.join(directory, "events.0.jsonl"), " ".repeat(LOG_POLICY.fileBytes - Buffer.byteLength(content) - 100));
  assert.equal(logger.event("request_completed", { projectRoot: f.root }), true);
  const events = read_diagnostic_logs(f.state).events;
  assert.equal(events.filter(event => event.event === "request_failed").length, 1);
  assert.equal(events.find(event => event.event === "request_failed").detail.failure.osCode, "EACCES");
  assert.ok(events.some(event => event.rotatedBefore));
});

test("conflicting copies of a record are reported and do not hide the retained error", t => {
  const f = fixture(t), logger = create_diagnostic_logger("settings", f.state);
  logger.event("request_failed", { projectRoot: f.root, error: { code: "EACCES" } }, "error");
  const file = path.join(f.state, "diagnostics/events.0.jsonl"), original = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...original, event: "request_completed", level: "info", detail: {} }) + "\n");
  const { events, issues } = read_diagnostic_logs(f.state);
  assert.ok(issues.includes("Conflicting duplicate log record"));
  assert.ok(events.some(event => event.event === "request_failed" && event.detail.failure.osCode === "EACCES"));
});

test("a damaged priority file cannot disable the ordinary journal", t => {
  const f = fixture(t), directory = path.join(f.state, "diagnostics"), target = path.join(f.base, "external.log");
  fs.mkdirSync(directory); fs.writeFileSync(target, "unchanged");
  try { fs.linkSync(target, path.join(directory, "important.0.jsonl")); }
  catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("hard links unavailable"); throw error; }
  const logger = create_diagnostic_logger("settings", f.state);
  assert.equal(logger.event("request_failed", { error: { code: "EACCES" } }, "error"), true);
  assert.equal(logger.status().priorityDropped, 1);
  assert.equal(logger.event("request_completed", {}), true);
  assert.equal(fs.readFileSync(target, "utf8"), "unchanged");
  const logs = read_diagnostic_logs(f.state);
  assert.ok(logs.events.some(event => event.event === "request_failed"));
  assert.ok(logs.events.some(event => event.priorityDroppedBefore === 1));
  assert.ok(logs.issues.length);
});

test("support JSON projects saved evidence and isolates project events without copying arbitrary fields", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const other = path.join(f.base, "other"); fs.mkdirSync(other);
  const a = create_diagnostic_logger("edt", f.state), b = create_diagnostic_logger("edt", f.state);
  a.event("session_started", { projectRoot: f.root });
  a.event("request_failed", { projectRoot: f.root, tool: "unmarked-tool-secret-951", error: Object.assign(new Error("unmarked-error-secret-951"), { code: "ECONNREFUSED" }), result: "unmarked-result-secret-951" }, "error");
  b.event("request_failed", { projectRoot: other, error: Object.assign(new Error("other"), { code: "EACCES" }) }, "error");
  const checkedAt = new Date(Date.now() - 1800000).toISOString(), expiresAt = new Date(Date.now() - 600000).toISOString();
  const current = { values: { projectRoot: f.root, edtUrl: "http://unmarked-url-secret-951", codeIndexEnabled: true },
    profile: { status: "loaded", unrelated: "unmarked-profile-secret-951" }, summary: { observedAt: new Date().toISOString() },
    profileDirectoryContext: { edt: { projectCount: 1, connection: { status: "detected", workspace: f.root, port: 8765, liveVerified: false } } },
    componentChecks: [{ id: "edt", state: "check_stale", lastState: "ready", checkedAt, expiresAt,
      detail: "unmarked-detail-secret-951", repositories: [{ id: "private-repository-951", matched: true, ready: false }] }],
    readiness: { state: "stale", checkedAt, expiresAt }, testing: { yaxunit: false }, result: "unmarked-result-secret-951" };
  const before = structuredClone(current);
  const result = await support_bundle({ state: f.state, configPath: f.env.EDT_AI_SETTINGS, selectedRoot: f.root, readCurrent: () => current });
  const report = JSON.parse(result.text), edt = report.snapshot.current.components.edt;
  assert.equal(report.version, 2); assert.equal(edt.observation.state, "check_stale"); assert.equal(edt.observation.lastState, "ready");
  assert.equal(edt.observation.freshness, "stale"); assert.equal(edt.observation.checkedAt, checkedAt);
  assert.equal(edt.endpoint.scheme, "http"); assert.equal(edt.endpoint.hostKind, "other"); assert.equal(edt.endpoint.connectivity, "not_checked_by_export");
  assert.equal(edt.workspace.state, "detected"); assert.equal(edt.workspace.projectCount, 1); assert.equal(edt.workspace.liveVerified, false);
  assert.equal(edt.observation.repositories[0].matched, true); assert.equal(report.snapshot.current.components.v8std.currentState, "unknown");
  assert.ok(report.events.some(event => event.detail.failure?.osCode === "ECONNREFUSED" && event.scope === "project"));
  assert.ok(!report.events.some(event => event.detail.failure?.osCode === "EACCES"));
  assert.ok(report.collection.scope.excludedEvents >= 1);
  for (const value of ["unmarked-tool-secret-951", "unmarked-error-secret-951", "unmarked-url-secret-951", "unmarked-profile-secret-951", "unmarked-detail-secret-951", "unmarked-result-secret-951", "private-repository-951", f.root, other]) assert.equal(result.text.includes(value), false, value);
  assert.deepEqual(current, before, "collection does not alter component observations");
});

test("operation log links request ownership, progress, duration and changed observations", async t => {
  const f = fixture(t); environment(t, f.env);
  const logger = create_diagnostic_logger("settings", f.state), observed = [], operations = new SettingsOperations(async (action, args, context, progress) => {
    observed.push(context.operationId);
    if (action === "rebuild_index") { progress({ phase: "indexing", total: 2, completed: 1 }); return {}; }
    return { componentChecks: [{ id: "edt", state: "ready", checkedAt: new Date().toISOString() }], external: { edt: { configured: true, connected: true, ready: true, toolsVerified: true, server: { version: "2.1.3" } } } };
  }, (name, detail, level) => logger.event(name, detail, level));
  const context = { projectRoot: f.root, instance: "first" };
  const rebuild = operations.start("rebuild_index", { all: true }, context); await rebuild.finished;
  for (let i = 0; i < 2; i++) { const job = operations.start("refresh_readiness", {}, context); await job.finished; }
  const events = read_diagnostic_logs(f.state).events;
  assert.equal(observed[0], rebuild.id);
  assert.ok(events.some(event => event.event === "operation_phase" && event.detail.id === rebuild.id && event.detail.phase === "indexing"));
  assert.ok(events.some(event => event.event === "operation_completed" && event.detail.id === rebuild.id && Number.isSafeInteger(event.detail.durationMs)));
  assert.equal(events.filter(event => event.event === "component_observed" && event.detail.state === "ready").length, 1);
  assert.ok(events.some(event => event.event === "component_observed" && event.detail.version === "2.1.3" && event.detail.toolsVerified === true));
});

test("backend configuration failures preserve a structured reason across the settings process", async t => {
  const f = fixture(t); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  await assert.rejects(client.call("settings.update", { set: { edtUrl: "ftp://unmarked-host-secret.invalid/path" } }));
  const events = read_diagnostic_logs(f.state).events;
  const failed = events.find(event => event.event === "operation_failed" && event.detail.action === "update");
  assert.ok(failed); assert.equal(failed.detail.failure.category, "configuration");
  assert.equal(failed.detail.failure.reasonCode, "configuration_invalid");
  assert.ok(events.some(event => event.event === "backend_process_started" && event.detail.operationId === failed.detail.id));
  assert.doesNotMatch(JSON.stringify(events), /unmarked-host-secret/);
});

test("a stalled status read leaves other diagnostic sections available", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => original(callback, delay === 10000 ? 25 : delay, ...args));
  const result = await support_bundle({ state: f.state, configPath: f.env.EDT_AI_SETTINGS, selectedRoot: f.root, readCurrent: () => new Promise(() => {}) });
  const report = JSON.parse(result.text);
  assert.equal(report.snapshot.current.unavailable, true); assert.equal(report.snapshot.current.error, "READ_TIMEOUT");
  assert.ok(report.collection.issues.some(issue => issue.section === "current" && issue.reason === "READ_TIMEOUT"));
  assert.equal(report.snapshot.project.profile.exists, true); assert.ok(report.snapshot.host.node);
});

test("support JSON excludes events from another instance and reports capped unbound errors", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const own = create_diagnostic_logger("edt", f.state); own.event("connection_failed", { projectRoot: f.root, error: { code: "ECONNREFUSED" } }, "error");
  process.env.EDT_AI_INSTANCE = "second";
  const other = create_diagnostic_logger("edt", f.state); other.event("connection_failed", { projectRoot: f.root, error: { code: "EACCES" } }, "error");
  process.env.EDT_AI_INSTANCE = "first";
  const unbound = create_diagnostic_logger("cli", f.state);
  for (let i = 0; i < 105; i++) unbound.event("command_failed", { error: { code: "ENOENT" }, i }, "error");
  const report = JSON.parse((await support_bundle({ state: f.state, configPath: f.env.EDT_AI_SETTINGS, selectedRoot: f.root })).text);
  assert.ok(report.events.some(event => event.detail.failure?.osCode === "ECONNREFUSED"));
  assert.ok(!report.events.some(event => event.detail.failure?.osCode === "EACCES"));
  assert.equal(report.events.filter(event => event.scope === "unbound_unknown").length, 100);
  assert.equal(report.collection.scope.unboundEventsOmitted, 5);
});

test("support JSON lists concurrent operations only for the selected project and instance", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const main = { id: "c3bd7419-d4f6-4f45-aea9-a831a0b4f601", action: "rebuild_index", status: "running", projectRoot: f.root, instance: "first", startedAt: new Date().toISOString() };
  const background = { id: "c3bd7419-d4f6-4f45-aea9-a831a0b4f602", action: "refresh_readiness", status: "running", projectRoot: f.root, instance: "first", startedAt: main.startedAt };
  const foreign = { ...background, id: "c3bd7419-d4f6-4f45-aea9-a831a0b4f603", instance: "second" };
  const report = JSON.parse((await support_bundle({ state: f.state, configPath: f.env.EDT_AI_SETTINGS, selectedRoot: f.root,
    operation: main, operations: [main, background, foreign] })).text);
  assert.equal(report.snapshot.host.operation.id, main.id);
  assert.deepEqual(report.snapshot.host.otherOperations.map(item => item.id), [background.id]);
  assert.equal(report.snapshot.host.otherOperations[0].status, "running");
  assert.equal(report.collection.scope.excludedOperations, 1);
  const switched = JSON.parse((await support_bundle({ state: f.state, configPath: f.env.EDT_AI_SETTINGS, selectedRoot: f.root,
    operation: foreign, operations: [main, background, foreign] })).text);
  assert.deepEqual(switched.snapshot.host.operation, { status: "unavailable", reason: "different_scope" });
  assert.equal(JSON.stringify(switched).includes(foreign.id), false);
});

test("operation duration is measured at its snapshot time rather than at the end of collection", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const operation = { id: "c3bd7419-d4f6-4f45-aea9-a831a0b4f601", action: "check", status: "running", projectRoot: f.root,
    instance: "first", startedAt: "2025-01-01T00:00:00.000Z" };
  const observedAt = "2025-01-01T00:00:10.000Z";
  const report = JSON.parse((await support_bundle({ state: f.state, configPath: f.env.EDT_AI_SETTINGS, selectedRoot: f.root,
    operation, operationsObservedAt: observedAt })).text);
  assert.equal(report.snapshot.host.operationsObservedAt, observedAt);
  assert.equal(report.snapshot.host.operation.durationMs, 10000);
});

test("diagnostic document collection rejects linked files without losing other sections", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const destination = path.join(f.base, "other-settings.json"); fs.writeFileSync(destination, JSON.stringify({ password: "linked-secret-143" }));
  try { fs.linkSync(destination, f.env.EDT_AI_SETTINGS); } catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("hard links unavailable"); throw error; }
  const report = JSON.parse((await support_bundle({ state: f.state, configPath: f.env.EDT_AI_SETTINGS, selectedRoot: f.root })).text);
  assert.equal(report.snapshot.settings.unavailable, true);
  assert.equal(report.snapshot.project.profile.exists, true);
  assert.ok(report.collection.issues.some(issue => issue.section === "settings" && issue.reason === "path_not_regular"));
  assert.doesNotMatch(JSON.stringify(report), /linked-secret-143/);
});
