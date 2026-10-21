import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { fixture, environment, session, ROOT } from "./helpers.mjs";
import { LOG_POLICY, create_diagnostic_logger, read_diagnostic_logs, sanitize_diagnostics, register_diagnostic_secrets, diagnostic_state } from "../scripts/diagnostics.mjs";
import { support_bundle } from "../scripts/support_bundle.mjs";
import { project_directory } from "../scripts/project_paths.mjs";

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
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {create_diagnostic_logger} from ${JSON.stringify(source)}; const logger=create_diagnostic_logger('worker-${worker}'); for(let i=0;i<100;i++) logger.event('concurrent',{i});`], { env: f.env, windowsHide: true, stdio: "ignore" });
    child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error("Worker exited " + code)));
  }));
  await Promise.all(workers);
  const logs = read_diagnostic_logs(f.state);
  assert.deepEqual(logs.issues, []); assert.ok(logs.events.length >= 250);
  assert.equal(new Set(logs.events.map(event => event.session)).size, 3);
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
  const client = await session(t, "mcp/settings.mjs", [], f);
  const tools = (await client.request("tools/list")).tools;
  assert.deepEqual(tools.find(tool => tool.name === "settings.export_diagnostics")._meta.ui.visibility, ["app"]);
  assert.equal(tools.filter(tool => /diagnostic/.test(tool.name)).length, 1);
  const opened = await client.call("settings.open", {});
  assert.equal(opened.structuredContent.configurationError, true);
  const result = await client.call("settings.export_diagnostics", {}), report = JSON.parse(result._meta.data.text);
  assert.equal(result.structuredContent, undefined);
  assert.equal(JSON.stringify(result.content).includes(f.root), false);
  assert.equal(report.snapshot.settings.invalid, true);
  assert.equal(report.snapshot.current.unavailable, true);
  assert.equal(result._meta.data.text.includes("private-unmarked-598213"), false);
  assert.ok(report.events.some(event => event.event === "settings_unavailable"));
});

test("an unbound settings app can export without creating a project or preparing runtimes", async t => {
  const f = fixture(t), client = await session(t, "mcp/settings.mjs", [], f, { EDT_AI_PROJECT_ROOT: "" });
  client.roots = [];
  client.notify("notifications/roots/list_changed");
  const result = await client.call("settings.export_diagnostics", {}), report = JSON.parse(result._meta.data.text);
  assert.equal(report.snapshot.host.selectedRoot, null);
  assert.equal(report.snapshot.project, undefined);
  assert.equal(fs.existsSync(path.join(f.root, ".ai")), false);
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS), false);
});

test("a logging failure never breaks the operation or prevents support export", async t => {
  const f = fixture(t), state = path.join(f.base, "not-a-directory"); fs.writeFileSync(state, "file");
  const logger = create_diagnostic_logger("fixture", state);
  assert.equal(logger.event("test"), false); assert.equal(logger.status().dropped, 1);
  const report = JSON.parse((await support_bundle({ state, configPath: path.join(state, "settings.json"), selectedRoot: null, loggerStatus: logger.status() })).text);
  assert.equal(report.snapshot.host.loggerStatus.dropped, 1);
  assert.ok(report.collection.issues.length);
});

test("native log tails stay bounded, keep the latest error and redact custom header credentials", async t => {
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
  assert.equal(report.snapshot.codeIndex_stderr.truncated, true);
  assert.match(report.snapshot.codeIndex_stderr.tail, /Latest error: \[REDACTED\]$/);
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
