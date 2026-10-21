import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { fixture, ROOT, environment } from "./helpers.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { SettingsOperations } from "../mcp/settings-operations.mjs";
import { sleep } from "../scripts/common.mjs";
import { grant_preparation } from "../scripts/components.mjs";

async function unbound(t, f, file = "mcp/settings.mjs", args = []) {
  const client = new McpClient([process.execPath, path.join(ROOT, file), ...args], ROOT, { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10);
  f.clients.push(client); client.roots = []; await client.initialize(); return client;
}

test("chat setup binds only its settings session, reports repairs and needs no reload or source inspection", async t => {
  const f = fixture(t); f.save();
  const a = await unbound(t, f), b = await unbound(t, f);
  const before = fs.readFileSync(path.join(f.root, ".ai/project.yaml"));
  const view = (await a.call("settings.inspect", { projectRoot: f.root })).structuredContent;
  assert.equal(view.profile.status, "loaded");
  assert.equal(view.projectRoot, f.root);
  const full = await a.call("settings.read", {});
  const compact = await a.call("settings.inspect", {});
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(full)) * 0.75);
  assert.deepEqual(view.nextSteps, ["configure_connections", "prepare_managed_with_authorization"]);
  assert.equal((await b.call("settings.inspect", {})).structuredContent.projectRoot, "");
  assert.deepEqual(fs.readdirSync(f.state).filter(name => name !== "diagnostics"), []);
  assert.deepEqual(fs.readFileSync(path.join(f.root, ".ai/project.yaml")), before);
  const other = path.join(f.base, "other"); fs.mkdirSync(other);
  await assert.rejects(a.call("settings.inspect", { projectRoot: other }), /закреплён/);
  f.profile.compatibility.core = ">=0.1.0 <0.2.0"; f.save();
  const invalid = (await a.call("settings.inspect", {})).structuredContent;
  assert.equal(invalid.profile.status, "invalid");
  assert.equal(invalid.profile.compatibility.core, ">=0.1.0 <0.2.0");
  assert.deepEqual(invalid.nextSteps, ["repair_profile"]);
  const edit = (await a.call("settings.edit", {})).structuredContent;
  const data = JSON.parse(edit.text); data.profile.compatibility.core = ">=0.3.0 <0.4.0";
  const request = { text: JSON.stringify(data), mode: "edit", baseRevision: edit.baseRevision };
  const preview = (await a.call("settings.preview", request)).structuredContent;
  await a.call("settings.apply", { ...request, revision: preview.revision, replace: true });
  assert.equal((await a.call("settings.inspect", {})).structuredContent.profile.status, "loaded");
  a.roots = [{ uri: pathToFileURL(other).href }]; a.notify("notifications/roots/list_changed");
  assert.equal((await a.call("settings.inspect", {})).structuredContent.projectRoot, other);
  await assert.rejects(a.call("settings.inspect", { projectRoot: f.root }), /закреплён/);
});

test("invalid profile shapes remain inspectable and host selection cannot be overridden", async t => {
  const f = fixture(t); f.save();
  fs.writeFileSync(path.join(f.root, ".ai/project.yaml"), "repositories: [null, text]\n");
  const client = await unbound(t, f);
  const view = (await client.call("settings.inspect", { projectRoot: f.root })).structuredContent;
  assert.equal(view.profile.status, "invalid"); assert.deepEqual(view.nextSteps, ["repair_profile"]);
  const locked = new McpClient([process.execPath, path.join(ROOT, "mcp/settings.mjs")], f.root, f.env, 10);
  f.clients.push(locked); await locked.initialize();
  await assert.rejects(locked.call("settings.inspect", { projectRoot: f.state }), /закреплён/);
});

async function endpoint(t, root) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    if (!body) { response.writeHead(202).end(); return; }
    const message = JSON.parse(body); calls.push(message.method);
    const reply = result => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "server/discover") { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "legacy" } })); return; }
    if (message.method === "initialize") return reply({ protocolVersion: "2025-11-25", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } });
    if (message.method.startsWith("notifications/")) { response.writeHead(202).end(); return; }
    if (message.method === "tools/list") return reply({ tools: [{ name: "list_projects", inputSchema: { type: "object", properties: { format: { type: "string", enum: ["json"] } } } }] });
    if (message.method === "tools/call") return reply({ content: [], structuredContent: { projects: [{ name: "Product", path: root, open: true, state: "ready", edtProject: true }] } });
    reply({});
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, calls };
}

test("empty host roots can bind a relay without spawning substitutes or changing another session", async t => {
  const f = fixture(t), upstream = await endpoint(t, f.root); f.profile.connections = { edt: { url: upstream.url } }; f.save();
  const a = await unbound(t, f, "scripts/lazy_mcp.mjs", ["--component", "edt"]);
  const b = await unbound(t, f, "scripts/lazy_mcp.mjs", ["--component", "edt"]);
  assert.equal((await a.call("core_runtime_status", {})).structuredContent.selectedDirectory, null);
  const result = await a.call("core_runtime_status", { projectRoot: f.root });
  assert.equal(result.structuredContent.ready, true);
  assert.equal(result.structuredContent.selectionSource, "argument");
  assert.ok(result.content[0].text.length < JSON.stringify(result.structuredContent).length);
  assert.equal((await b.call("core_runtime_status", {})).structuredContent.selectedDirectory, null);
  await assert.rejects(a.call("core_runtime_status", { projectRoot: f.state }), /закреплён/);
  a.roots = []; a.notify("notifications/roots/list_changed");
  assert.equal((await a.call("core_runtime_status", {})).structuredContent.selectedDirectory, null);
});

test("one bounded setup probe verifies external connections and refuses a wrong EDT path", async t => {
  const f = fixture(t), upstream = await endpoint(t, f.root);
  f.profile.connections = { edt: { url: upstream.url }, v8std: { url: upstream.url } }; f.save();
  const client = await unbound(t, f); await client.call("settings.inspect", { projectRoot: f.root });
  const run = async () => {
    const operation = (await client.call("settings.probe_connections", {})).structuredContent;
    const completed = (await client.call("settings.operation", { operationId: operation.id, waitMs: 10000 })).structuredContent;
    assert.equal(completed.status, "completed"); return completed.result;
  };
  const result = await run();
  assert.equal(result.external.edt.projectReadiness, "verified");
  assert.equal(result.external.v8std.connected, true);
  assert.equal(result.fullReadiness, "not_verified");
  assert.equal(upstream.calls.filter(name => name === "tools/call").length, 1);
  assert.deepEqual(fs.readdirSync(f.state).filter(name => name !== "diagnostics"), []);
  f.profile.repositories[0].path = "src"; f.save();
  assert.equal((await run()).external.edt.repositories[0].matched, false);
  await assert.rejects(client.call("settings.operation", { waitMs: 10001 }), /диапазона/);
  await assert.rejects(client.call("settings.operation", { waitMs: 0.5 }), /тип/);
});

test("explicit managed binding notifies discovery and honors the preparation gate", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const preload = new URL("./fixtures/managed-spawn.mjs", import.meta.url).href;
  const client = new McpClient([process.execPath, path.join(ROOT, "scripts/lazy_mcp.mjs"), "--component", "code-index"], ROOT,
    { ...f.env, EDT_AI_PROJECT_ROOT: "", NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import " + preload].filter(Boolean).join(" ") }, 10);
  f.clients.push(client); client.roots = []; await client.initialize();
  const revision = client.tools_revision;
  await client.call("core_runtime_status", { projectRoot: f.root });
  assert.ok(client.tools_revision > revision);
  assert.deepEqual((await client.request("tools/list")).tools.map(tool => tool.name), ["core_runtime_status"]);
  assert.deepEqual(fs.readdirSync(f.state).filter(name => name !== "diagnostics"), []);
  grant_preparation(f.state, f.root, ["code-index"]);
  assert.ok((await client.request("tools/list")).tools.some(tool => tool.name === "inspect"));
  assert.equal((await client.call("core_runtime_status", {})).structuredContent.ready, true);
});

test("v8std binding never sends the local project directory, including unsolicited roots callbacks", async t => {
  const f = fixture(t), messages = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    const message = JSON.parse(body); messages.push(message);
    const reply = result => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "server/discover") return response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "legacy" } }));
    if (message.method === "initialize") {
      assert.equal(message.params.capabilities.roots, undefined);
      return reply({ protocolVersion: "2025-11-25", serverInfo: { name: "standards", version: "1" }, capabilities: { tools: {} } });
    }
    if (message.method === "tools/list") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('data: {"jsonrpc":"2.0","id":"unsolicited-roots","method":"roots/list","params":{}}\n\n');
      response.end('data: '+JSON.stringify({jsonrpc:"2.0",id:message.id,result:{tools:[]}})+'\n\n');return;
    }
    response.writeHead(202).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  f.profile.connections = { v8std: { url: `http://127.0.0.1:${server.address().port}/mcp` } }; f.save();
  const client = await unbound(t, f, "scripts/lazy_mcp.mjs", ["--component", "v8std"]);
  assert.equal((await client.call("core_runtime_status", { projectRoot: f.root })).structuredContent.ready, true);
  assert.deepEqual(messages.find(message => message.id === "unsolicited-roots").result.roots, []);
  assert.equal(JSON.stringify(messages).includes(JSON.stringify(f.root).slice(1, -1)), false);
});

test("bounded operation waits do not restart work and return promptly after completion", async () => {
  let calls = 0;
  const operations = new SettingsOperations(async () => { calls++; await sleep(50); return { checked: true }; });
  const job = operations.start("probe", {}, {});
  await operations.wait(job.id, 1); assert.equal(operations.status(job.id).status, "running");
  await operations.wait(job.id, 1000); assert.equal(operations.status(job.id).status, "completed");
  assert.equal(calls, 1);
});
