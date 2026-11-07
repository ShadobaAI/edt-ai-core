import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { fixture, environment } from "./helpers.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { instance_directory } from "../scripts/project_paths.mjs";
import { project_profile } from "../scripts/profile.mjs";
import { probe_vanessa } from "../scripts/vanessa_readiness.mjs";
import { save_component_checks, read_component_checks } from "../scripts/setup_readiness.mjs";
import * as wire from "./test-vanessa-ui-fixtures.mjs";

async function managerFixture(t) {
  const f = fixture(t); environment(t, f.env);
  let mode = "ready", release, entered;
  const calls = [];
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") { calls.push("DELETE"); return res.writeHead(204).end(); }
    let body = ""; for await (const part of req) body += part;
    const message = JSON.parse(body); calls.push(message.method + (message.params?.name ? ":" + message.params.name : ""));
    if (mode === "unavailable") return req.socket.destroy();
    if (mode === "http-error") return res.writeHead(503).end();
    if (message.method === "notifications/initialized") return res.writeHead(mode === "notification-error" ? 400 : 202).end();
    const reply = result => res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "test-session" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") {
      if (mode === "malformed-handshake") return res.writeHead(200, { "Content-Type": "application/json" }).end("not JSON");
      return reply({ protocolVersion: mode === "incompatible-handshake" ? "2099-01-01" : "2025-03-26", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } });
    }
    if (message.method === "tools/list") return reply({ tools: mode === "missing-tool" ? [] : [{ name: "get_environment_data", inputSchema: { type: "object" } }] });
    if (message.method === "tools/call") {
      if (mode === "hold") { entered(); await new Promise(resolve => { release = resolve; }); }
      if (mode === "tool-error") return reply({ isError: true, content: [{ type: "text", text: "opaque-private-secret-592" }] });
      if (mode === "unrecognized") return reply(wire.response("unknown environment"));
      let text = wire.environment.content[0].text;
      if (mode === "mismatch") text = text.replace('Ref="ui-demo"', 'Ref="other"');
      if (mode === "server-alias") text = text.replace('Srvr="localhost"', 'Srvr="127.0.0.1"');
      if (mode === "file") text = text.replace('Srvr="localhost";Ref="ui-demo";', `File="${path.join(f.root, "base")}";`);
      text += '\n- Private: opaque-private-secret-592';
      return reply(wire.response(text));
    }
    return reply({});
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  const port = server.address().port, file = path.join(f.root, ".ai", "vanessa.local.json");
  f.profile.testing.vanessa = true;
  f.profile.testing.vanessa_config = { repository_id: "product", runtime_profile: ".ai/vanessa.local.json", features: "features", results: "results", server_name: "vanessa" };
  f.save();
  const base = { type: "server", server: "localhost", database: "ui-demo" };
  const runtime = { version: 1, id: "fixture", projectRoot: "..", platform: "../1cv8c", runtime: { epf: "../vanessa.epf" },
    manager: { infobase: base }, client: { name: "TestClient", infobase: base }, mcp: { serverName: "vanessa", url: `http://127.0.0.1:${port}/mcp`, port },
    features: "../features", results: "../results", limits: { timeoutMs: 1000 } };
  const saveRuntime = () => fs.writeFileSync(file, JSON.stringify(runtime)); saveRuntime();
  const backend = new SettingsBackend();
  return { ...f, file, runtime, saveRuntime, backend, calls, setMode: value => { mode = value; },
    waitForCall: () => new Promise(resolve => { entered = resolve; }), release: () => release(),
    probe: () => backend.main({ action: "probe", component: "vanessa" }) };
}

test("manual Vanessa check verifies the live manager without touching clients and expires independently", async t => {
  const f = await managerFixture(t);
  assert.deepEqual((await f.backend.main({ action: "read" })).componentChecks, []);
  assert.equal(f.calls.length, 0, "passive reads do not contact the manager");
  const result = await f.probe(), check = result.componentChecks[0];
  assert.equal(check.state, "ready"); assert.match(check.detail, /MCP менеджера отвечает/);
  assert.equal(Date.parse(check.expiresAt) - Date.parse(check.checkedAt), 60000);
  assert.deepEqual(f.calls, ["initialize", "notifications/initialized", "tools/list", "tools/call:get_environment_data", "DELETE"]);
  const receipt = path.join(instance_directory(f.state, f.root), "first.readiness.json");
  assert.equal((JSON.stringify(result) + fs.readFileSync(receipt, "utf8")).includes("opaque-private-secret-592"), false);
  const before = f.calls.length;
  assert.equal((await f.backend.main({ action: "status" })).componentChecks.find(item => item.id === "vanessa").state, "ready");
  assert.equal(f.calls.length, before, "reading a saved result does not recheck");
  const saved = JSON.parse(fs.readFileSync(receipt, "utf8"));
  saved.components.vanessa.result.checkedAt = new Date(Date.now() - 61000).toISOString();
  saved.components.vanessa.result.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(receipt, JSON.stringify(saved));
  assert.equal((await f.backend.main({ action: "read" })).componentChecks.find(item => item.id === "vanessa").state, "check_stale");
  assert.equal(f.calls.length, before, "expiry does not perform a network check");
});

for (const [mode, expected] of [["unavailable", "stopped"], ["http-error", "not_verified"], ["incompatible-handshake", "not_verified"], ["malformed-handshake", "not_verified"], ["notification-error", "not_verified"], ["mismatch", "mismatch"], ["server-alias", "not_verified"], ["missing-tool", "not_verified"], ["unrecognized", "not_verified"], ["tool-error", "not_verified"]]) {
  test(`Vanessa manager check reports ${mode} as ${expected} without exposing responses`, async t => {
    const f = await managerFixture(t); f.setMode(mode);
    const result = await f.probe(); assert.equal(result.componentChecks[0].state, expected);
    assert.equal(JSON.stringify(result).includes("opaque-private-secret-592"), false);
    assert.equal((await f.backend.main({ action: "read" })).componentChecks.find(item => item.id === "vanessa").state, expected);
  });
}

test("manager status follows loss of connection and later recovery", async t => {
  const f = await managerFixture(t);
  assert.equal((await f.probe()).componentChecks[0].state, "ready");
  f.setMode("unavailable"); assert.equal((await f.probe()).componentChecks[0].state, "stopped");
  f.setMode("ready"); assert.equal((await f.backend.main({ action: "refresh_readiness", scope: f.root + "#first" })).componentChecks.find(item => item.id === "vanessa").state, "ready");
  assert.equal((await f.backend.main({ action: "read" })).componentChecks.find(item => item.id === "vanessa").state, "ready");
});

test("disabled and invalid runtime profiles do not contact the manager", async t => {
  const f = await managerFixture(t);
  f.profile.testing.vanessa = false; f.save(); assert.equal((await f.probe()).componentChecks[0].state, "disabled");
  f.profile.testing.vanessa = true; f.save(); fs.unlinkSync(f.file);
  assert.equal((await f.probe()).componentChecks[0].state, "missing_config");
  f.runtime.mcp.url = "https://example.invalid/mcp"; f.saveRuntime();
  const invalid = (await f.probe()).componentChecks[0];
  assert.equal(invalid.state, "missing_config"); assert.match(invalid.detail, /параметры менеджера/);
  assert.equal(f.calls.length, 0);
});

test("manager availability is independent of TestClient and unrelated launch settings", async t => {
  const f = await managerFixture(t);
  delete f.runtime.client; delete f.runtime.platform; delete f.runtime.runtime;
  f.runtime.clients = [{ userEnv: "private-username-variable" }, {}]; f.saveRuntime();
  const result = await f.probe(); assert.equal(result.componentChecks[0].state, "ready");
  assert.match(result.componentChecks[0].detail, /Настройки запуска, TestClient/);
  assert.equal(JSON.stringify(result).includes("private-username-variable"), false);
});

test("a slow combined operation cannot renew a completed manager observation", async t => {
  const f = await managerFixture(t), profile = project_profile(f.root), config = f.backend.effective(f.backend.current());
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const observation = await probe_vanessa(f.root, profile);
  assert.equal(observation.state, "ready");
  assert.equal(Date.parse(observation.checkedAt), Date.now());
  t.mock.timers.tick(61000);
  const saved = save_component_checks(f.state, config, profile, [observation])[0];
  assert.equal(saved.checkedAt, observation.checkedAt);
  assert.equal(Date.parse(saved.expiresAt) - Date.parse(saved.checkedAt), 60000);
  assert.equal(read_component_checks(f.state, config, profile).find(item => item.id === "vanessa").state, "check_stale");
});

test("manager file bases are compared by local filesystem identity", async t => {
  const f = await managerFixture(t); fs.mkdirSync(path.join(f.root, "base"));
  f.runtime.manager.infobase = { type: "file", path: "../base" };
  f.runtime.client.infobase = { type: "file", path: "../base" }; f.saveRuntime(); f.setMode("file");
  assert.equal((await f.probe()).componentChecks[0].state, "ready");
  f.runtime.manager.infobase.path = "../missing-base"; f.saveRuntime();
  assert.equal((await f.probe()).componentChecks[0].state, "not_verified");
});

test("repointing the configured file-base link invalidates the saved manager check", async t => {
  const f = await managerFixture(t), link = path.join(f.root, "base-link"), first = path.join(f.root, "base"), second = path.join(f.root, "other-base");
  fs.mkdirSync(first); fs.mkdirSync(second);
  fs.symlinkSync(first, link, process.platform === "win32" ? "junction" : "dir");
  f.runtime.manager.infobase = { type: "file", path: "../base-link" };
  f.runtime.client.infobase = { type: "file", path: "../base-link" }; f.saveRuntime(); f.setMode("file");
  assert.equal((await f.probe()).componentChecks[0].state, "ready");
  fs.unlinkSync(link); fs.symlinkSync(second, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await f.backend.main({ action: "read" })).componentChecks.find(item => item.id === "vanessa").state, "check_stale");
});

test("changes to the runtime profile invalidate only Vanessa's saved evidence", async t => {
  const f = await managerFixture(t); await f.probe();
  const result = await f.backend.main({ action: "probe", component: "v8std" });
  const other = result.componentChecks[0].state;
  f.runtime.mcp.url = f.runtime.mcp.url.replace("/mcp", "/other"); f.saveRuntime();
  const checks = (await f.backend.main({ action: "read" })).componentChecks;
  assert.equal(checks.find(item => item.id === "vanessa").state, "check_stale");
  assert.equal(checks.find(item => item.id === "v8std").state, other);
});

for (const action of ["probe", "refresh_readiness"]) test(`a runtime profile change during ${action} discards the old manager result`, async t => {
  const f = await managerFixture(t); f.setMode("hold");
  const entered = f.waitForCall();
  const pending = f.backend.main({ action, component: "vanessa", ...(action === "refresh_readiness" ? { scope: f.root + "#first" } : {}) });
  await entered; f.runtime.mcp.url = f.runtime.mcp.url.replace("/mcp", "/new"); f.saveRuntime(); f.release();
  const result = await pending; assert.equal(result.superseded, true);
  assert.equal((await f.backend.main({ action: "read" })).componentChecks.some(item => item.id === "vanessa" && item.state === "ready"), false);
});
