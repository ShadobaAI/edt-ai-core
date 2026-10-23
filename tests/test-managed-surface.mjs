import assert from "node:assert/strict";
import path from "node:path";
import { McpClient } from "../scripts/mcp_client.mjs";
import { sleep } from "../scripts/common.mjs";
import test from "node:test";
import { fixture, session, ROOT } from "./helpers.mjs";
import { grant_preparation } from "../scripts/components.mjs";
import { environment } from "./helpers.mjs";
import { dump } from "../scripts/common.mjs";
const preload = new URL("./fixtures/managed-spawn.mjs", import.meta.url).href;
test("profile import does not connect runtime; status bootstraps prepared tools without discovery", async (t) => {
  const f = fixture(t);
  environment(t, f.env);
  grant_preparation(f.state, f.root, ["code-index"]);
  const client = await session(t, "scripts/lazy_mcp.mjs", ["--component", "code-index"], f, {
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import " + preload].filter(Boolean).join(" "),
  });
  assert.equal((await client.call("core_runtime_status", {})).structuredContent.ready, false);
  const revision = client.tools_revision;
  const settings = await session(t, "mcp/settings.mjs", [], f);
  const request = { text: JSON.stringify(f.profile) };
  const preview = (await settings.call("settings.preview", request)).structuredContent;
  await settings.call("settings.apply", { ...request, revision: preview.revision });
  assert.equal(client.tools_revision, revision);
  const status = (await client.call("core_runtime_status", {})).structuredContent;
  assert.equal(status.ready, true);
  assert.equal(status.serverContract.serverInfo.name, "fixture");
  assert.ok((await client.request("tools/list")).tools.some(tool => tool.name === "inspect"));
  assert.ok(client.tools_revision > revision);
});

test("BSL status bootstraps native tools after preparation without a host discovery refresh and keeps scope isolated", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  dump({ mcp: { managed: { "bsl-ls": { enabled: true } } } }, f.env.EDT_AI_SETTINGS);
  const connect = async (instance = "first") => {
    const client = new McpClient([process.execPath, path.join(ROOT, "scripts/lazy_mcp.mjs"), "--component", "bsl-ls"], ROOT,
      { ...f.env, EDT_AI_PROJECT_ROOT: "", EDT_AI_INSTANCE: instance, FIXTURE_BSL_WORKSPACES: "1", NODE_OPTIONS: "--import " + preload }, 10);
    f.clients.push(client); client.roots = []; await client.initialize(); return client;
  };
  const client = await connect(), other = await connect(), otherInstance = await connect("second");
  const blocked = (await client.call("core_runtime_status", { projectRoot: f.root })).structuredContent;
  assert.equal(blocked.ready, false);
  assert.match(blocked.detail, /не подготовлен/);
  grant_preparation(f.state, f.root, ["bsl-ls"]);
  const revision = client.tools_revision;
  // No tools/list between binding, preparation and status: mirrors Codex's
  // initially cached status-only catalogue in the reported chat.
  const status = (await client.call("core_runtime_status", {})).structuredContent;
  assert.equal(status.state, "connected");
  assert.equal(status.binding.projectRoot, f.root);
  assert.equal(status.binding.instance, "first");
  assert.match(status.serverContract.instructions, /Native fixture contract/);
  assert.ok(client.tools_revision > revision);
  assert.equal((await client.call("core_runtime_status", {})).structuredContent.binding.connectionId, status.binding.connectionId);
  assert.equal((await other.call("core_runtime_status", {})).structuredContent.selectedDirectory, null);
  assert.equal((await otherInstance.call("core_runtime_status", { projectRoot: f.root })).structuredContent.ready, false);
  await assert.rejects(client.call("core_runtime_status", { projectRoot: f.state }), /закреплён/);
  const tools = (await client.request("tools/list")).tools;
  assert.ok(tools.some(tool => tool.name === "register_workspace_folder"));
  assert.deepEqual(tools.find(tool => tool.name === "analyze_workspace").inputSchema.required, ["workspaceFolder"]);
  assert.equal((await client.call("inspect", {})).structuredContent.binding, f.root);
});
test("managed stdio relay preserves schemas/results and refreshes discovery only at boundaries", async (t) => {
  const f = fixture(t);
  environment(t, f.env);
  grant_preparation(f.state, f.root, ["code-index"]);
  f.save();
  const client = await session(
    t,
    "scripts/lazy_mcp.mjs",
    ["--component", "code-index"],
    f,
    {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import " + preload]
        .filter(Boolean)
        .join(" "),
    },
  );
  const tools = (await client.request("tools/list")).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["core_runtime_status", "core_runtime_tools", "core_runtime_call", "inspect", "tail"],
  );
  const inspect = tools.find(tool => tool.name === "inspect");
  assert.equal(inspect.inputSchema.properties.change.type, "boolean");
  assert.equal(inspect.annotations.readOnlyHint, true);
  assert.equal(inspect.outputSchema.type, "object");
  const before = (await client.call("inspect", {})).structuredContent;
  for (let i = 0; i < 3; i++)
    assert.deepEqual(
      (await client.call("inspect", {})).structuredContent,
      before,
    );
  assert.equal(before.rows_elided_already_delivered, 3);
  assert.equal(before.response_sections_omitted, true);
  await client.call("inspect", { change: true });
  const refreshed = (await client.call("inspect", {})).structuredContent;
  assert.equal(refreshed.discoveries, before.discoveries + 2);
  assert.ok(
    (await client.request("tools/list")).tools.some(
      (tool) => tool.name === "later",
    ),
  );
});
test("managed BSL binding fails closed on a lifecycle-incompatible native catalogue", async (t) => {
  const f = fixture(t);
  environment(t, f.env);
  dump({ mcp: { managed: { "bsl-ls": { enabled: true } } } }, f.env.EDT_AI_SETTINGS);
  grant_preparation(f.state, f.root, ["bsl-ls"]);
  f.save();
  const client = await session(
    t,
    "scripts/lazy_mcp.mjs",
    ["--component", "bsl-ls"],
    f,
    {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import " + preload]
        .filter(Boolean)
        .join(" "),
    },
  );
  await client.request("tools/list");
  const status = (await client.call("core_runtime_status", {}))
    .structuredContent;
  assert.equal(status.ready, false);
  assert.match(status.detail, /native multi-workspace API/);
  assert.deepEqual(
    (await client.request("tools/list")).tools.map((tool) => tool.name),
    ["core_runtime_status", "core_runtime_tools", "core_runtime_call"],
  );
});

test("cached host catalogue can discover and call native BSL tools, with validation and no implicit retry", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  dump({ mcp: { managed: { "bsl-ls": { enabled: true } } } }, f.env.EDT_AI_SETTINGS);
  const client = new McpClient([process.execPath, path.join(ROOT, "scripts/lazy_mcp.mjs"), "--component", "bsl-ls"], ROOT,
    { ...f.env, EDT_AI_PROJECT_ROOT: "", FIXTURE_BSL_WORKSPACES: "1", FIXTURE_RUNTIME_BATCH: "1", NODE_OPTIONS: "--import " + preload }, 10);
  f.clients.push(client); client.roots = []; await client.initialize();
  const initial = (await client.request("tools/list")).tools;
  assert.deepEqual(initial.map(tool => tool.name), ["core_runtime_status", "core_runtime_tools", "core_runtime_call"]);
  assert.equal(initial.find(tool => tool.name === "core_runtime_call").annotations.readOnlyHint, false);
  await assert.rejects(client.call("core_runtime_tools", { projectRoot: f.root }), /не подготовлен/);
  grant_preparation(f.state, f.root, ["bsl-ls"]);
  // Deliberately never refresh the host tools/list after the initial snapshot.
  const schema = (await client.call("core_runtime_tools", { names: ["analyze_workspace"] })).structuredContent;
  assert.deepEqual(schema.tools[0].inputSchema.required, ["workspaceFolder"]);
  const batch = calls => client.request("tools/call", { name: "core_runtime_call", arguments: { calls } });
  const valid = await batch([{ name: "inspect", arguments: { change: true } }, { name: "later", arguments: {} }]);
  assert.equal(valid.structuredContent.completed, 2);
  assert.equal(valid.structuredContent.results[0].result.structuredContent.pid, valid.structuredContent.results[1].result.structuredContent.pid);
  for (const calls of [
    [{ name: "analyze_workspace", arguments: {} }, { name: "inspect", arguments: {} }],
    [{ name: "inspect", arguments: { change: "wrong type" } }],
    [{ name: "unknown", arguments: {} }],
    [{ name: "core_runtime_status", arguments: {} }],
  ]) {
    const invalid = await batch(calls);
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.completed, 0);
    assert.equal(invalid.structuredContent.results.length, 1);
  }
  const failed = await batch([{ name: "inspect", arguments: {} }, { name: "fail", arguments: {} }, { name: "inspect", arguments: {} }]);
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.completed, 1);
  assert.equal(failed.structuredContent.results.length, 2);
  assert.equal(failed.structuredContent.results[1].result.structuredContent.nativeError, true);
  const rpc = await batch([{ name: "inspect", arguments: {} }, { name: "rpc_fail", arguments: {} }, { name: "inspect", arguments: {} }]);
  assert.equal(rpc.isError, true);
  assert.equal(rpc.structuredContent.completed, 1);
  assert.equal(rpc.structuredContent.results.length, 2);
  assert.equal(rpc.structuredContent.results[1].error.code, -32002);
  assert.equal(rpc.structuredContent.results[1].error.outcome, "unknown");
  let hostId;
  const cancelled = client.request("tools/call", { name: "core_runtime_call", arguments: { calls: [{ name: "slow", arguments: {} }, { name: "inspect", arguments: {} }] } }, { onId: id => { hostId = id; } });
  await sleep(80);
  client.notify("notifications/cancelled", { requestId: hostId });
  const stopped = await cancelled;
  assert.equal(stopped.isError, true);
  const native = stopped.structuredContent.results[0].result.structuredContent;
  assert.equal(native.notifications.find(n => n.method === "notifications/cancelled").params.requestId, native.upstreamId);
  assert.equal(stopped.structuredContent.results[1].error.outcome, "not_executed");
  await assert.rejects(client.call("core_runtime_call", { projectRoot: f.state, calls: [{ name: "inspect", arguments: {} }] }), /закреплён/);
});

test("native call envelope preserves code-index profile alias checks", async t => {
  const f = fixture(t); environment(t, f.env); f.save(); grant_preparation(f.state, f.root, ["code-index"]);
  const client = await session(t, "scripts/lazy_mcp.mjs", ["--component", "code-index"], f, { NODE_OPTIONS: "--import " + preload });
  const result = await client.request("tools/call", { name: "core_runtime_call", arguments: { calls: [{ name: "inspect", arguments: { repo: "foreign" } }] } });
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.results[0].error.message, /alias is outside/);
});
