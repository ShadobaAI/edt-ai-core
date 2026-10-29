import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { McpClient } from "../scripts/mcp_client.mjs";
import { settings } from "../scripts/common.mjs";
import { fixture, ROOT } from "./helpers.mjs";

// Codex 0.165 applies a shared 64,000-byte agent-plugin budget to model
// specifications, including the namespace description once per tool. This is
// a conservative local estimate, not a claim about another host's catalogue.
const truncateUtf8 = (text, limit) => {
  let result = "";
  for (const char of text) {
    if (Buffer.byteLength(result + char) > limit) break;
    result += char;
  }
  return result;
};

test("model-visible plugin catalogue stays bounded after native discovery", async t => {
  const f = fixture(t);
  const server = createServer(async (request, response) => {
    let text = ""; for await (const part of request) text += part;
    if (!text) return response.writeHead(202).end();
    const message = JSON.parse(text);
    const reply = result => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "server/discover") return response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "legacy" } }));
    if (message.method === "initialize") return reply({ protocolVersion: "2025-11-25", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } });
    if (message.method === "tools/list") return reply({ tools: [...Array.from({ length: 12 }, (_, i) => ({
      name: "native_" + i, description: "fixture ".repeat(100), inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true },
    })), ...["register_workspace_folder", "list_workspace_folders", "unregister_workspace_folder"].map(name => ({ name, inputSchema: { type: "object", properties: {} } })),
      { name: "analyze_workspace", inputSchema: { type: "object", properties: { workspaceFolder: { type: "string" } }, required: ["workspaceFolder"] } }] });
    return response.writeHead(202).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  f.profile.connections = { edt: { url }, v8std: { url } }; f.save();
  const config = settings(f.env.EDT_AI_SETTINGS);
  for (const name of ["code-index", "bsl-ls"]) Object.assign(config.mcp.managed[name], { enabled: true, mode: "external", url });
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(config));
  const entries = Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, "mcp.json"), "utf8")).mcpServers);
  let total = 0;
  for (const [name, entry] of entries) {
    assert.equal(entry.type, "stdio", `Add budget coverage for ${name}'s transport`);
    const command = entry.command === "node" ? process.execPath : entry.command;
    const args = entry.args.map(arg => arg.replaceAll("${PLUGIN_ROOT}", ROOT));
    const isRelay = args.some(arg => arg.replaceAll("\\", "/").endsWith("/scripts/lazy_mcp.mjs"));
    const client = new McpClient([command, ...args], ROOT,
      { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10);
    f.clients.push(client); client.roots = [];
    const init = await client.initialize();
    const initial = (await client.request("tools/list")).tools;
    if (isRelay) {
      assert.equal((await client.call("core_runtime_status", { projectRoot: f.root })).structuredContent.ready, true);
      const nativeNames = (await client.call("core_runtime_tools", { detail: "names" })).structuredContent.names;
      assert.equal(nativeNames.length, 16); assert.ok(nativeNames.includes("native_0"));
      const selected = (await client.call("core_runtime_tools", { names: ["native_0"] })).structuredContent.tools;
      assert.equal(selected[0].description, "fixture ".repeat(100));
      assert.deepEqual((await client.request("tools/list")).tools, initial);
    }
    const definitions = initial.filter(tool =>
      !tool._meta?.ui?.visibility || tool._meta.ui.visibility.includes("model"));
    if (isRelay)
      assert.deepEqual(definitions.map(tool => tool.name), ["core_runtime_status", "core_runtime_tools", "core_runtime_call"]);
    for (const tool of definitions) {
      const modelSpec = { type: "namespace", name: "mcp__" + name.replaceAll("-", "_"),
        description: truncateUtf8(init.instructions || "", 1000), tools: [{ type: "function", name: tool.name,
          description: truncateUtf8(tool.description || "", 1000), strict: false, parameters: tool.inputSchema }] };
      // Reserve additional bytes for host-side normalization and framing.
      const bytes = Buffer.byteLength(JSON.stringify(modelSpec)) + 64;
      assert.ok(bytes < 8000, `${name}/${tool.name} estimate is ${bytes} bytes`);
      total += bytes;
    }
  }
  // Other agent plugins share Codex's budget; this cannot guarantee their fit.
  assert.ok(total < 58000, `initial catalogue estimate is ${total} bytes`);
});
