import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { loadProfile, digest, interactiveParameters } from "../vanessa/profile.mjs";
import { clientControlKey, managerStartupTimeoutMs, probeManager, registryDir, start } from "../vanessa/runtime.mjs";
import { main } from "../vanessa/vanessa.mjs";
import { requiredTools, runtimeContract } from "../vanessa/readiness.mjs";
import { windows_tcp_rows, match_testclient_binding } from "../scripts/windows_process.mjs";
import * as wire from "./test-vanessa-ui-fixtures.mjs";

async function unusedPort() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function fixture(t, { port } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vanessa-start-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tmp = path.join(root, "temp"); fs.mkdirSync(tmp);
  t.mock.method(os, "tmpdir", () => tmp);
  fs.mkdirSync(path.join(root, "config")); fs.mkdirSync(path.join(root, "features"));
  fs.writeFileSync(path.join(root, "1cv8c.exe"), "fixture");
  fs.writeFileSync(path.join(root, "runtime.epf"), "fixture");
  const file = path.join(root, "config", "profile.json"), selectedPort = port ?? await unusedPort();
  fs.writeFileSync(file, JSON.stringify({
    version: 1, id: "fixture", projectRoot: "..", platform: "../1cv8c.exe", runtime: { epf: "../runtime.epf" },
    manager: { infobase: { type: "server", server: "localhost", database: "ui-demo" }, user: { name: "Manager", password: "", interface: "taxi" } },
    infobase: { type: "server", server: "localhost", database: "ui-demo" }, users: { Client: { name: "User", password: "", interface: "taxi" } },
    mcp: { url: `http://127.0.0.1:${selectedPort}/mcp`, port: selectedPort }, features: "../features", results: "../results",
  }));
  const profile = loadProfile(file), ownerFile = path.join(registryDir(), `endpoint-${selectedPort}.owner.json`), stateFile = path.join(profile.stateDir, "manager.json");
  const fingerprint = digest(JSON.stringify([profile.platform, profile.runtime, profile.manager, { infobase: profile.client.infobase }, profile.stateDir, interactiveParameters(profile)]));
  const record = (pid = 41, created = "win32-filetime:1") => ({ profile: profile.identity, client: clientControlKey(profile),
    clientKeyVersion: 3, fingerprint, status: "running", pid, created });
  const write = (owner, state = owner) => {
    fs.mkdirSync(registryDir(), { recursive: true }); fs.mkdirSync(profile.stateDir, { recursive: true });
    if (owner) fs.writeFileSync(ownerFile, JSON.stringify(owner));
    if (state) fs.writeFileSync(stateFile, JSON.stringify(state));
  };
  const processes = new Map();
  let now = 0, launches = 0, probes = 0;
  const system = {
    platform: "win32", processIdentity(pid) { const value = processes.get(pid); if (value instanceof Error) throw value; return value ?? null; },
    now: () => now, sleep: async ms => { now += ms; }, startupTimeoutMs: managerStartupTimeoutMs, pollIntervalMs: 2000,
    async launchManager() { launches++; processes.set(99, { pid: 99, executable: profile.platform, created: "win32-filetime:99" }); return 99; },
    async probeManager() { probes++; return { status: "ready", runtimeVersion: "fixture" }; },
  };
  return { root, file, profile, ownerFile, stateFile, record, write, processes, system,
    launches: () => launches, probes: () => probes, now: () => now };
}

for (const mode of ["absent", "other_application"]) {
  test(`stale manager PID used by ${mode} is replaced after a verified launch`, async t => {
    const f = await fixture(t), previous = f.record(); f.write(previous);
    if (mode === "other_application") f.processes.set(previous.pid, { pid: previous.pid, executable: "C:\\Tools\\other.exe", created: "win32-filetime:2" });
    let attempts = 0;
    f.system.probeManager = async () => ++attempts < 3 ? { status: "pending" } : { status: "ready", runtimeVersion: "fixture" };
    const result = await start(f.profile, { system: f.system });
    assert.equal(result.status, "started"); assert.equal(result.readiness, "manager_mcp_ready");
    assert.equal(f.launches(), 1); assert.equal(f.now(), 4000);
    for (const file of [f.ownerFile, f.stateFile]) {
      const saved = JSON.parse(fs.readFileSync(file));
      assert.equal(saved.status, "running"); assert.equal(saved.pid, 99); assert.equal(saved.created, "win32-filetime:99");
    }
  });
}

test("another 1C using a saved PID is observed for five minutes and is not replaced", async t => {
  const f = await fixture(t), previous = f.record(); f.write(previous);
  f.processes.set(previous.pid, { pid: previous.pid, executable: "C:\\Program Files\\1cv8\\bin\\1cv8.exe", created: "win32-filetime:2" });
  f.system.probeManager = async () => ({ status: "pending" });
  const before = fs.readFileSync(f.ownerFile, "utf8"), result = await start(f.profile, { system: f.system });
  assert.equal(result.status, "unverified"); assert.equal(result.reason, "manager_mcp_timeout");
  assert.match(result.nextAction, /перезапустить менеджер.*запустить MCP/);
  assert.equal(f.now(), managerStartupTimeoutMs); assert.equal(f.launches(), 0);
  assert.equal(fs.readFileSync(f.ownerFile, "utf8"), before);
});

test("a live owned manager waits for MCP, but a different 1C process is never adopted", async t => {
  const f = await fixture(t), previous = f.record(); f.write(previous);
  const observed = { pid: previous.pid, executable: f.profile.platform, created: previous.created };
  f.processes.set(previous.pid, observed);
  let calls = 0;
  f.system.probeManager = async () => ++calls < 3 ? { status: "pending" } : { status: "ready", runtimeVersion: "fixture" };
  const running = await start(f.profile, { system: f.system });
  assert.equal(running.status, "running"); assert.equal(running.readiness, "manager_mcp_ready");
  assert.equal(calls, 3); assert.equal(f.launches(), 0);
  f.processes.set(previous.pid, { ...observed, created: "win32-filetime:2" });
  const unowned = await start(f.profile, { system: f.system });
  assert.equal(unowned.status, "unverified"); assert.equal(unowned.reason, "manager_ownership_unverified");
  assert.equal(f.launches(), 0); assert.equal(JSON.parse(fs.readFileSync(f.ownerFile)).created, previous.created);
});

test("startup timeout preserves the new PID and never launches twice", async t => {
  const f = await fixture(t);
  f.system.probeManager = async () => ({ status: "pending" });
  const result = await start(f.profile, { system: f.system });
  assert.equal(result.status, "unverified"); assert.equal(result.reason, "manager_mcp_timeout");
  assert.equal(result.pid, 99); assert.equal(f.launches(), 1); assert.equal(f.now(), managerStartupTimeoutMs);
  assert.equal(JSON.parse(fs.readFileSync(f.ownerFile)).pid, 99);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).pid, 99);
  const retry = await start(f.profile, { system: f.system });
  assert.equal(retry.reason, "manager_mcp_timeout"); assert.equal(f.launches(), 1);
});

test("changed launch settings do not let a live 1C process be adopted", async t => {
  const f = await fixture(t), previous = { ...f.record(), fingerprint: "old-settings" }; f.write(previous);
  f.processes.set(previous.pid, { pid: previous.pid, executable: f.profile.platform, created: previous.created });
  const result = await start(f.profile, { system: f.system });
  assert.equal(result.reason, "manager_ownership_unverified"); assert.equal(f.launches(), 0);
  assert.equal(JSON.parse(fs.readFileSync(f.ownerFile)).fingerprint, "old-settings");
});

test("changing TestClient credentials does not invalidate a running manager", async t => {
  const f = await fixture(t), previous = f.record(); f.write(previous);
  f.processes.set(previous.pid, { pid: previous.pid, executable: f.profile.platform, created: previous.created });
  const changedClient = { ...f.profile.client, user: { ...f.profile.client.user, name: "AnotherUser", password: "rotated" } };
  const updated = { ...f.profile, client: changedClient, ownerClient: changedClient };
  const result = await start(updated, { system: f.system });
  assert.equal(result.status, "running"); assert.equal(f.launches(), 0);
  const changedManager = { ...updated, manager: { ...updated.manager, user: { ...updated.manager.user, password: "changed" } } };
  assert.equal((await start(changedManager, { system: f.system })).reason, "manager_ownership_unverified");
});

test("a manager whose PID changes during the wait is never replaced", async t => {
  const f = await fixture(t), previous = f.record(); f.write(previous);
  f.processes.set(previous.pid, { pid: previous.pid, executable: f.profile.platform, created: previous.created });
  f.system.probeManager = async () => {
    f.processes.set(previous.pid, { pid: previous.pid, executable: f.profile.platform, created: "win32-filetime:2" });
    return { status: "pending" };
  };
  const result = await start(f.profile, { system: f.system });
  assert.equal(result.reason, "manager_process_changed"); assert.equal(f.launches(), 0);
});

test("a changed ownership record during MCP verification never yields ready", async t => {
  const f = await fixture(t), previous = f.record(); f.write(previous);
  f.processes.set(previous.pid, { pid: previous.pid, executable: f.profile.platform, created: previous.created });
  f.system.probeManager = async () => {
    fs.writeFileSync(f.ownerFile, JSON.stringify({ ...previous, fingerprint: "changed" }));
    return { status: "ready", runtimeVersion: "fixture" };
  };
  const result = await start(f.profile, { system: f.system });
  assert.equal(result.reason, "manager_ownership_changed"); assert.equal(f.launches(), 0);
});

test("a conflicting listener prevents overwriting a stale PID", async t => {
  const f = await fixture(t), previous = f.record(); f.write(previous);
  const server = net.createServer(); server.listen(f.profile.mcp.port, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(start(f.profile, { system: f.system }), /Порт подключения занят/);
  assert.equal(f.launches(), 0); assert.equal(JSON.parse(fs.readFileSync(f.ownerFile)).pid, previous.pid);
});

test("unknown process state, uncertain launch, and a separate live state record stop a new manager", async t => {
  const f = await fixture(t), previous = f.record(); f.write(previous);
  f.processes.set(previous.pid, new Error("access denied"));
  await assert.rejects(start(f.profile, { system: f.system }), /Не удалось проверить процесс/);
  f.processes.delete(previous.pid);
  f.write({ ...previous, status: "starting", pid: undefined }, { ...previous, status: "starting", pid: undefined });
  await assert.rejects(start(f.profile, { system: f.system }), /Исход предыдущего запуска неизвестен/);
  const other = f.record(42, "win32-filetime:42"); f.write(previous, other);
  f.processes.set(42, { pid: 42, executable: f.profile.platform, created: other.created });
  f.system.probeManager = async () => ({ status: "ready", runtimeVersion: "fixture" });
  const result = await start(f.profile, { system: f.system });
  assert.equal(result.reason, "manager_ownership_unverified"); assert.equal(f.launches(), 0);
});

test("a dispatched launch with unknown outcome leaves a barrier in both records", async t => {
  const f = await fixture(t);
  f.write(f.record());
  f.system.launchManager = async () => { throw new Error("unknown dispatch outcome"); };
  await assert.rejects(start(f.profile, { system: f.system }), error => error.code === "manager_launch_indeterminate");
  assert.equal(JSON.parse(fs.readFileSync(f.ownerFile)).status, "starting");
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).status, "starting");
  await assert.rejects(start(f.profile, { system: f.system }), /Исход предыдущего запуска неизвестен/);
});

test("a preparation failure before dispatch preserves the stale records and permits a later start", async t => {
  const f = await fixture(t), previous = f.record(); f.write(previous);
  fs.writeFileSync(f.profile.results, "not a directory");
  await assert.rejects(start(f.profile, { system: f.system }), error => error.code === "EEXIST");
  assert.equal(JSON.parse(fs.readFileSync(f.ownerFile)).status, "running");
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).status, "running");
  assert.equal(f.launches(), 0);
  fs.unlinkSync(f.profile.results);
  assert.equal((await start(f.profile, { system: f.system })).status, "started");
  assert.equal(f.launches(), 1);
});

test("a failed reservation before dispatch restores both previous records", async t => {
  const f = await fixture(t), previous = f.record(); f.write(previous);
  const oldOwner = fs.readFileSync(f.ownerFile, "utf8"), oldState = fs.readFileSync(f.stateFile, "utf8"), rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (String(target).endsWith("interactive.json")) throw Object.assign(new Error("fixture rename failure"), { code: "EACCES" });
    return rename(source, target);
  };
  try { await assert.rejects(start(f.profile, { system: f.system }), /fixture rename failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(f.launches(), 0); assert.equal(fs.readFileSync(f.ownerFile, "utf8"), oldOwner);
  assert.equal(fs.readFileSync(f.stateFile, "utf8"), oldState);
  assert.equal((await start(f.profile, { system: f.system })).status, "started");
});

test("MCP readiness checks the live response, configured base and process connection", async t => {
  let baseMatches = true, afterDelete = () => {};
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") { afterDelete(); return res.writeHead(204).end(); }
    let body = ""; for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body);
    if (msg.method === "notifications/initialized") return res.writeHead(202).end();
    const result = msg.method === "initialize" ? { protocolVersion: "2025-03-26", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } }
      : msg.method === "tools/list" ? { tools: [{ name: "get_environment_data", inputSchema: { type: "object" } }] }
        : baseMatches ? wire.environment : wire.response(wire.environment.content[0].text.replace('Ref="ui-demo";', 'Ref="different";'));
    return res.writeHead(200, { "Content-Type": "application/json", "Connection": "close",
      ...(msg.method === "initialize" ? { "Mcp-Session-Id": "fixture-session" } : {}) }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const f = await fixture(t, { port: server.address().port });
  const observed = { pid: 41, executable: f.profile.platform, created: "win32-filetime:41" };
  f.processes.set(observed.pid, observed);
  const address = "7f000001", port = f.profile.mcp.port;
  const listener = { family: 2, state: 2, pid: observed.pid, localPort: port, localAddress: address, localScope: 0 };
  const rows = socket => {
    const caller = { family: 2, state: 5, pid: process.pid, localAddress: address, localScope: 0, localPort: socket.localPort, remoteAddress: address, remoteScope: 0, remotePort: port };
    return [listener, caller, { ...caller, pid: observed.pid, localPort: port, remotePort: socket.localPort }];
  };
  f.system.tcpRows = rows;
  assert.equal((await probeManager(f.profile, observed, { system: f.system })).status, "ready");
  if (process.platform === "win32") {
    // The fixture server and caller share this process; verify the real TCP
    // table at connect time even though each response closes its socket.
    const actual = { pid: process.pid, executable: f.profile.platform, created: "win32-filetime:51" };
    const { tcpRows, ...nativeSystem } = f.system;
    nativeSystem.processIdentity = pid => pid === actual.pid ? actual : null;
    assert.equal((await probeManager(f.profile, actual, { system: nativeSystem })).status, "ready");
  }
  baseMatches = false;
  assert.equal((await probeManager(f.profile, observed, { system: f.system })).reason, "manager_infobase_mismatch");
  baseMatches = true; f.system.tcpRows = socket => rows(socket).map((row, i) => i === 2 ? { ...row, pid: 42 } : row);
  assert.equal((await probeManager(f.profile, observed, { system: f.system })).reason, "manager_mcp_binding_unverified");
  f.system.tcpRows = rows;
  afterDelete = () => f.processes.set(observed.pid, { ...observed, created: "win32-filetime:999" });
  assert.equal((await probeManager(f.profile, observed, { system: f.system })).reason, "manager_process_changed");
});

test("setup verifies the actual manager and TestClient TCP links with closing HTTP connections", { skip: process.platform !== "win32", timeout: 15000 }, async t => {
  const child = spawn(process.execPath, ["-e", `
    const net = require("node:net");
    const server = net.createServer(socket => socket.on("error", () => {}));
    server.listen(0, "127.0.0.1", () => process.send({port: server.address().port}));
    process.on("disconnect", () => server.close());
  `], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [info] = await once(child, "message"), link = net.connect(info.port, "127.0.0.1");
  await once(link, "connect"); t.after(() => link.destroy());
  let configured = false, connected = false, bindingChecks = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") return res.writeHead(204, { Connection: "close" }).end();
    let body = ""; for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body);
    if (msg.method === "notifications/initialized") return res.writeHead(202, { Connection: "close" }).end();
    let result;
    if (msg.method === "initialize") result = { protocolVersion: "2025-03-26", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } };
    else if (msg.method === "tools/list") result = { tools: requiredTools.map(name => ({ name, inputSchema: { type: "object" } })) };
    else {
      const { name, arguments: args } = msg.params;
      if (name === "manage_test_client_profiles" && args.action === "add") { configured = true; result = wire.response("added"); }
      else if (name === "manage_test_client_profiles") {
        result = configured ? wire.response(wire.profiles.content[0].text.replaceAll("ExistingClient", "Client")
          .replace('/N"FixtureUser"', '/iTaxi /N"User" /P""').replace("| PID | 0 |", `| PID | ${connected ? child.pid : 0} |`)
          .replace("❌ не подключен", connected ? "✅ подключен" : "❌ не подключен")) : wire.emptyProfiles;
      } else if (name === "manage_test_client") { connected = true; result = wire.response("connected"); }
      else if (name === "get_environment_data") result = wire.environment;
      else if (name === "get_vanessa_automation_state") result = connected ? wire.response(wire.connectedState.content[0].text.replaceAll("TestClient", "Client")) : wire.state;
      else if (name === "get_editor_state") result = wire.editor;
      else if (name === "get_extension_list") result = wire.extensions;
      else if (name === "get_process_list_os") result = wire.response(wire.clientProcess.content[0].text
        .replace("Найдено по отбору: 1 из 2. Показано: 1.", "Найдено: 1. Показано: 1.").replace("Отбор: 19968.\n", "")
        .replaceAll("19968", String(child.pid)).replace("-TPort 48000", `-TPort ${info.port}`));
      else result = wire.response("ok");
    }
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const f = await fixture(t, { port: server.address().port }), owner = f.record(process.pid, "win32-filetime:51");
  f.write(owner); f.processes.set(process.pid, { pid: process.pid, executable: f.profile.platform, created: owner.created });
  const contract = { ...runtimeContract,
    processIdentity: pid => pid === child.pid ? { pid, executable: "C:\\Fixture\\1cv8c.exe", created: "win32-filetime:55" } : null,
    processBinding: (mcpPort, pid, testPort) => {
      bindingChecks++;
      const rows = [...windows_tcp_rows(2), ...windows_tcp_rows(23)];
      return match_testclient_binding(rows, mcpPort, pid, testPort) === process.pid ? { managerPid: process.pid, managerCreated: owner.created } : null;
    } };
  const result = await main(["setup", "--profile", f.file], { contract, managerSystem: f.system });
  assert.equal(result.status, "ready", JSON.stringify(result));
  assert.ok(bindingChecks >= 2); assert.equal(connected, true);
});
