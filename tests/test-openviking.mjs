import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, session, ROOT, node, success } from "./helpers.mjs";
import { COMPONENTS, component_settings, managed_components } from "../scripts/components.mjs";
import { settings } from "../scripts/common.mjs";
import { OpenVikingAdapter, OPENVIKING_LIMITS } from "../scripts/openviking_adapter.mjs";
import { SEARCH_REQUIREMENTS } from "../scripts/knowledge.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { all_pages } from "../scripts/mcp_pages.mjs";

test("OpenViking registry uses optional settings and a dedicated bounded MCP entry", async t => {
  const f = fixture(t); f.save();
  const config = settings(f.env.EDT_AI_SETTINGS);
  assert.equal(component_settings(config, "openviking"), config.mcp.optional.openviking);
  assert.equal(managed_components.includes("openviking"), false);
  const entry = JSON.parse(fs.readFileSync(path.join(ROOT, "mcp.json"))).mcpServers.openviking;
  assert.deepEqual(entry.args, ["${PLUGIN_ROOT}/" + COMPONENTS.openviking.adapter]);
  const client = await session(t, COMPONENTS.openviking.adapter, [], f);
  assert.deepEqual((await client.request("tools/list")).tools.map(tool => tool.name), ["knowledge_status", "knowledge_search", "knowledge_read"]);
  assert.equal((await client.call("knowledge_status", {})).structuredContent.state, "disabled");
  await assert.rejects(client.call("core_runtime_call", { calls: [] }), /Invalid knowledge/);
  f.profile.knowledge = { provider: "openviking", mode: "transitional", manifest: null,
    collections: ["architecture"], required: false, dependent_actions: [] };
  f.profile.connections = { openviking: { enabled: true, url: "https://example.org/mcp" } }; f.save();
  const output = path.join(f.base, "generated.json");
  success(node("scripts/runtime.mjs", ["config", "--output", output], { env: f.env }));
  assert.deepEqual(JSON.parse(fs.readFileSync(output)).mcpServers.openviking.args, [path.join(ROOT, COMPONENTS.openviking.adapter)]);
});
test("OpenViking rejects malformed roots without exiting and honors the host's current selection", async t => {
  const f = fixture(t), other = fixture(t); f.save(); other.save();
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/openviking.mjs")], ROOT, { ...f.env, EDT_AI_PROJECT_ROOT: "" }, 10);
  f.clients.push(client); client.roots = [{ uri: "https://invalid.example/root", name: "invalid" }];
  await client.initialize();
  await assert.rejects(client.call("knowledge_status", {}));
  assert.equal((await client.request("tools/list")).tools.length, 3);
  for (const root of [f.root, other.root]) {
    client.roots = [{ uri: pathToFileURL(root).href, name: "selected" }];
    client.notify("notifications/roots/list_changed"); await client.request("tools/list");
    assert.equal((await client.call("knowledge_status", {})).structuredContent.projectRoot, root);
  }
});

const nativeTools = () => [
  { name: "find", inputSchema: { type: "object", properties: { query: { type: "string" }, target_uri: { type: "string" }, limit: { type: "integer" } }, required: ["query"], additionalProperties: false }, outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false } },
  { name: "read", inputSchema: { type: "object", properties: { uris: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["uris"], additionalProperties: false } },
];
const uri = "viking://resources/team/architecture/design.md";
const metadata = () => ({ schema_version: "0.1", kind: "document", id: "design", title: "Design", provenance: { source: "https://example.org/source" }, scope: ["Fixture subsystem"], revision: "edition-1", compatibility: { project_revision: "reviewed" }, status: "published" });
const markdown = (data = metadata(), body = "# Body\n") => "---\n" + JSON.stringify(data) + "\n---\n" + body;
const card = () => ({ ...metadata(), kind: "api_card", status: "confirmed", intent: ["Find a mechanism"], recommended_api: "Example.Method",
  recommendation: "use", when_to_use: ["Within fixture scope"], when_not_to_use: ["Outside fixture scope"], contract: "No persistent effects", context: ["Server"],
  verification_ref: "https://example.org/review", verified_at: "2026-10-24" });
const textResult = text => ({ content: [{ type: "text", text }] });
function adapterFixture(t) {
  const f = fixture(t), config = settings(f.env.EDT_AI_SETTINGS), calls = [];
  f.profile.knowledge = { provider: "openviking", mode: "transitional", manifest: null, collections: ["architecture"], required: false, dependent_actions: [], collection_uris: { architecture: "viking://resources/team/architecture" } };
  config.mcp.optional.openviking = { ...config.mcp.optional.openviking, enabled: true, url: "https://example.org/mcp" };
  const client = { tools: nativeTools(), initialized: 0, closed: 0, tools_revision: 0,
    async initialize() { this.initialized++; }, async close() { this.closed++; },
    async request(method, params) {
      calls.push({ method, params });
      if (method === "tools/list") return { tools: this.tools };
      return this.respond(params);
    },
    respond(params) { return params.name === "read" ? textResult(markdown()) : { ...textResult(`Found 1 item(s):\n\n- [resource 90%] ${uri}\n    Summary\n\nUse the read tool to expand a URI.`), structuredContent: { result: `Found 1 item(s):\n\n- [resource 90%] ${uri}\n    Summary\n\nUse the read tool to expand a URI.` } }; }
  };
  return { ...f, config, calls, client, adapter: () => new OpenVikingAdapter(f.profile, config, client) };
}
test("OpenViking negotiates live schemas and calls only scoped search/read", async t => {
  const f = adapterFixture(t), adapter = f.adapter();
  const status = await adapter.connect(); assert.equal(status.ready, false);
  assert.equal((await adapter.search({ query: "design", collection: "architecture" })).items[0].uri, uri);
  assert.equal((await adapter.read({ uri, collection: "architecture" })).text, markdown());
  const before = f.calls.length;
  for (const request of [{ query: "", collection: "architecture" }, { query: "x", collection: "other" }, { query: "x", collection: "architecture", limit: 500 }])
    await assert.rejects(adapter.search(request));
  for (const target of ["viking://user/personal.md", "viking://resources/team/architecture2/a.md", "viking://resources/team/architecture/../a.md", "https://example.org/a.md"])
    await assert.rejects(adapter.read({ uri: target, collection: "architecture" }));
  assert.equal(f.calls.length, before);
});
test("OpenViking returns compact sourced editions and expands only addressed materials", async t => {
  const f = adapterFixture(t), adapter = f.adapter(); await adapter.connect();
  const native = f.client.respond;
  f.client.respond = params => params.name === "read" ? textResult(markdown(metadata(), "x".repeat(1500))) : native(params);
  const result = await adapter.search({ query: "x", collection: "architecture" });
  assert.equal(result.items[0].source, metadata().provenance.source);
  assert.equal(result.items[0].revision, "edition-1");
  assert.equal(result.items[0].excerpt.length, 1000);
  assert.equal(result.items[0].excerptTruncated, true);
  assert.equal(f.calls.filter(call => call.params?.name === "read").length, 1);
  f.client.respond = params => params.name === "read" ? textResult(markdown(metadata(), "x".repeat(21000))) : native(params);
  const expanded = await adapter.read({ uri, collection: "architecture" });
  assert.equal(expanded.text.length, 20000); assert.equal(expanded.truncated, true);
});
test("OpenViking preserves incomplete search and resumes character-limited material windows", async t => {
  const f = adapterFixture(t), adapter = f.adapter(); await adapter.connect();
  const original = f.client.respond;
  f.client.respond = params => params.name === "read" ? textResult(markdown(metadata(), "x".repeat(41000))) : original(params);
  const first = await adapter.read({ uri, collection: "architecture" });
  const second = await adapter.read({ uri, collection: "architecture", ...first.next });
  const third = await adapter.read({ uri, collection: "architecture", ...second.next });
  assert.equal(first.text + second.text + third.text, markdown(metadata(), "x".repeat(41000)));
  assert.equal(third.next, null); assert.equal(third.complete, false);
  f.client.respond = () => ({ ...textResult("No matching context found."), structuredContent: { result: "No matching context found." }, truncated: true });
  const empty = await adapter.search({ query: "x", collection: "architecture" });
  assert.equal(empty.serverPartial, true); assert.equal(empty.complete, false); assert.equal(empty.apiExistence, "not_determined");
  f.client.respond = () => ({ ...original({ name: "find" }), nextCursor: "tail" });
  await assert.rejects(adapter.search({ query: "x", collection: "architecture" }), /pagination.*incomplete/);
  f.client.respond = () => ({ ...textResult(`Found 2 item(s):\n\n- [resource 90%] ${uri}\n    truncated`), structuredContent: { result: `Found 2 item(s):\n\n- [resource 90%] ${uri}\n    truncated` } });
  await assert.rejects(adapter.search({ query: "x", collection: "architecture" }), /incomplete/);
});
test("catalog discovery consumes pages and rejects incomplete or endless empty pagination", async () => {
  let pages = 0;
  const client = { request: async () => ({ tools: [{ name: "tool" + ++pages }], ...(pages < 3 ? { nextCursor: "page" + pages } : {}) }) };
  assert.equal((await all_pages(client, "tools/list", "tools")).tools.length, 3);
  let empty = 0;
  await assert.rejects(all_pages({ request: async () => ({ tools: [], nextCursor: "page" + ++empty }) }, "tools/list", "tools", { maxPages: 4 }), /page limit/);
  assert.equal(empty, 4);
  await assert.rejects(all_pages({ request: async () => ({ tools: [], truncated: true }) }, "tools/list", "tools"), /Incomplete/);
});
test("material continuation uses OpenViking splitlines semantics for CR and Unicode separators", async t => {
  for (const separator of ["\r", "\u2028", "\u2029", "\v", "\x85"]) {
    const f = adapterFixture(t), adapter = f.adapter(); await adapter.connect();
    f.client.respond = params => textResult(params.arguments.offset === 0 ? markdown(metadata(), ("row" + separator).repeat(197)) : "tail" + separator);
    const first = await adapter.read({ uri, collection: "architecture" });
    assert.equal(first.next.offset, 200);
    const tail = await adapter.read({ uri, collection: "architecture", ...first.next });
    assert.equal(tail.text, "tail" + separator); assert.equal(tail.next, null);
  }
});
test("API statuses remain scoped, review pointers require verification and obsolete cards are filtered", async t => {
  const f = adapterFixture(t), adapter = f.adapter(); await adapter.connect();
  const original = f.client.respond;
  for (const status of ["confirmed", "review_required", "obsolete"]) {
    f.client.respond = params => params.name === "read" ? textResult(markdown({ ...card(), status })) : original(params);
    const result = await adapter.search({ query: "x", collection: "architecture" });
    if (status === "obsolete") {
      assert.equal(result.items.length, 0); assert.equal(result.filtered, 1); assert.equal(result.complete, false);
      assert.equal(result.apiExistence, "not_determined");
      await assert.rejects(adapter.read({ uri, collection: "architecture" }), /Inactive/);
    } else {
      assert.deepEqual(result.items[0].scope, card().scope);
      assert.equal(result.items[0].apiPolicy.applicabilityToCurrentTask, "not_verified");
      assert.equal(result.items[0].apiPolicy.evidenceRole, status === "confirmed" ? "declared_scoped_confirmation" : "verification_pointer");
      assert.equal(result.items[0].evidence.metadata, "unverified_declaration");
      assert.equal(result.items[0].evidence.publication, "not_verified");
      assert.equal(result.items[0].apiPolicy.newCall, status === "confirmed" ? "candidate_after_scope_verification" : "requires_reverification");
      assert.equal((await adapter.read({ uri, collection: "architecture" })).apiPolicy.verificationRef, card().verification_ref);
    }
  }
});
test("avoid API cards produce an avoidance warning for both confirmed and review_required status", async t => {
  const f = adapterFixture(t), adapter = f.adapter(); await adapter.connect();
  const original = f.client.respond;
  for (const status of ["confirmed", "review_required"]) {
    f.client.respond = params => params.name === "read" ? textResult(markdown({ ...card(), status, recommendation: "avoid", avoid_reason: "Use the maintained wrapper" }, "Old example: Example.Method()")) : original(params);
    const result = await adapter.search({ query: "x", collection: "architecture" });
    assert.equal(result.items[0].apiPolicy.newCall, "not_recommended");
    assert.equal(result.items[0].apiPolicy.evidenceRole, "avoidance_warning");
    assert.equal(result.items[0].excerpt, "Use the maintained wrapper");
    assert.equal((await adapter.read({ uri, collection: "architecture" })).apiPolicy.newCall, "not_recommended");
  }
});
test("published documents retain their own metadata without becoming API evidence", async t => {
  const f = adapterFixture(t), adapter = f.adapter(); await adapter.connect();
  const result = await adapter.search({ query: "architecture", collection: "architecture" });
  const item = result.items[0];
  assert.equal(item.status, "published"); assert.equal(item.kind, "document"); assert.equal(item.apiPolicy, undefined);
  assert.equal(item.documentPolicy.apiApplicability, "not_proven");
  assert.equal(item.evidence.publication, "not_verified");
  const original = f.client.respond;
  for (const status of ["draft", "obsolete"]) {
    f.client.respond = params => params.name === "read" ? textResult(markdown({ ...metadata(), status })) : original(params);
    const filtered = await adapter.search({ query: "x", collection: "architecture" });
    assert.equal(filtered.outcome, "filtered_empty"); assert.equal(filtered.filtered, 1); assert.equal(filtered.complete, false);
    await assert.rejects(adapter.read({ uri, collection: "architecture" }), /Inactive/);
  }
  for (const data of [{ ...metadata(), status: "confirmed" }, { ...metadata(), recommended_api: "Example.Method" }, { ...metadata(), revision: "" }, { ...metadata(), provenance: {} }]) {
    f.client.respond = params => params.name === "read" ? textResult(markdown(data)) : original(params);
    await assert.rejects(adapter.search({ query: "x", collection: "architecture" }), /metadata/);
  }
});
test("OpenViking bounds parallel traffic and rejects excess queued work", async t => {
  const f = adapterFixture(t), adapter = f.adapter(); await adapter.connect();
  const original = f.client.respond;
  let active = 0, peak = 0;
  f.client.respond = async params => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return original(params);
  };
  const results = await Promise.allSettled(Array.from({ length: 15 }, () => adapter.read({ uri, collection: "architecture" })));
  assert.equal(peak, 2);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 10);
  assert.equal(results.filter(result => result.status === "rejected" && /queue budget/.test(result.reason.message)).length, 5);
  assert.equal(adapter.active, 0); assert.equal(adapter.waiters.length, 0);
});
test("OpenViking caps selected hits and serialized output without a corpus walk", async t => {
  const f = adapterFixture(t);
  f.profile.knowledge.search = { ...SEARCH_REQUIREMENTS, max_results: 100, max_excerpt_chars: 8000, max_material_chars: 100000 };
  const adapter = f.adapter(); await adapter.connect();
  f.client.respond = params => {
    if (params.name === "read") return textResult(markdown(metadata(), "x".repeat(15000)));
    const text = "Found 10 item(s):\n\n" + Array.from({ length: 10 }, (_, i) => `- [resource 90%] viking://resources/team/architecture/item-${i}.md\n    Summary`).join("\n") + "\n\nUse the read tool to expand a URI.";
    return { ...textResult(text), structuredContent: { result: text } };
  };
  const result = await adapter.search({ query: "x", collection: "architecture", limit: 100 });
  assert.equal(result.effectiveLimit, 10); assert.equal(result.budgetLimited, true);
  assert.ok(result.items.length < 10); assert.ok(result.unexpanded > 0);
  assert.ok(JSON.stringify(result).length < OPENVIKING_LIMITS.resultChars);
  assert.ok(f.calls.filter(call => call.params?.name === "read").length < 10);
  const read = await adapter.read({ uri, collection: "architecture" });
  assert.ok(JSON.stringify(read).length < OPENVIKING_LIMITS.resultChars);
  f.client.respond = () => textResult(markdown(metadata(), "Body" + "\t".repeat(15000)));
  const escaped = await adapter.read({ uri, collection: "architecture" });
  assert.equal(escaped.truncated, true); assert.ok(escaped.next.charOffset > 0);
  assert.ok(JSON.stringify(escaped).length < OPENVIKING_LIMITS.resultChars);
});
test("OpenViking revalidates live changes without pinning a native catalogue or health probing", async t => {
  const f = adapterFixture(t), adapter = f.adapter();
  // Extra and unknown native tools remain outside the adapter surface.
  f.client.tools.push({ name: "future_write", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } });
  await adapter.connect();
  await adapter.search({ query: "x", collection: "architecture" });
  await adapter.search({ query: "y", collection: "architecture" });
  assert.equal(f.calls.filter(call => call.method === "tools/list").length, 1);
  const descriptor = f.client.tools[0]; descriptor.name = "search";
  descriptor.inputSchema.properties.mode = { const: "list" }; descriptor.inputSchema.required.push("mode");
  const original = f.client.respond;
  f.client.respond = params => original({ ...params, name: params.name === "search" ? "find" : params.name });
  f.client.tools_revision++;
  await adapter.search({ query: "z", collection: "architecture" });
  const call = f.calls.findLast(call => call.params?.name === "search");
  assert.equal(call.params.arguments.mode, "list");
  assert.equal(f.calls.filter(call => call.method === "tools/list").length, 2);
  f.client.tools[0].inputSchema.required.push("new_required"); f.client.tools_revision++;
  const count = f.calls.filter(call => call.method === "tools/call").length;
  await assert.rejects(adapter.search({ query: "x", collection: "architecture" }), /Incompatible live arguments/);
  assert.equal(f.calls.filter(call => call.method === "tools/call").length, count);
  assert.equal(adapter.connected, false);
  assert.equal(f.calls.some(call => call.params?.name === "health" || call.params?.name === "future_write"), false);
});
test("OpenViking rejects incompatible contracts, arguments, output and disabled configurations", async t => {
  for (const change of [tools => tools.pop(), tools => { tools[0].inputSchema.required.push("unprovided"); }, tools => { tools[1].inputSchema.properties.uris = { type: "integer" }; }]) {
    const f = adapterFixture(t); change(f.client.tools);
    await assert.rejects(f.adapter().connect(), /contract|arguments/); assert.ok(f.client.closed);
  }
  const f = adapterFixture(t), adapter = f.adapter(); await adapter.connect();
  for (const response of [{ content: [] }, { ...textResult("x"), isError: true }, { ...textResult("x"), structuredContent: { result: 1 } }, { ...textResult("x"), structuredContent: { result: "different" } }]) {
    f.client.respond = () => response; await assert.rejects(adapter.search({ query: "x", collection: "architecture" }));
  }
  const disabled = adapterFixture(t); disabled.profile.knowledge = { provider: "none", manifest: null }; disabled.config.mcp.optional.openviking.enabled = false;
  await assert.rejects(disabled.adapter().connect()); assert.equal(disabled.client.initialized, 0);
  const unmapped = adapterFixture(t); delete unmapped.profile.knowledge.collection_uris;
  await assert.rejects(unmapped.adapter().connect(), /mapping required/); assert.equal(unmapped.client.initialized, 0);
});
test("OpenViking MCP entry reaches an isolated HTTP server using effective settings", async t => {
  const f = adapterFixture(t);
  let descriptors = nativeTools();
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") return res.writeHead(204).end();
    let text = ""; for await (const chunk of req) text += chunk;
    const message = JSON.parse(text), reply = result => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "server/discover") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "legacy fixture" } }));
    if (message.method === "initialize") return reply({ protocolVersion: "2025-11-25", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } });
    if (message.method.startsWith("notifications/")) return res.writeHead(202).end();
    if (message.method === "tools/list") return reply({ tools: descriptors });
    reply(f.client.respond(message.params));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  f.profile.connections = { openviking: { enabled: true, url: "http://127.0.0.1:" + server.address().port + "/mcp" } }; f.save();
  const client = await session(t, "mcp/openviking.mjs", [], f);
  assert.equal((await client.call("knowledge_status", {})).structuredContent.connected, true);
  const retrieved = (await client.call("knowledge_search", { query: "x", collection: "architecture" })).structuredContent;
  assert.equal(retrieved.items.length, 1);
  assert.deepEqual(retrieved.binding.collections, ["architecture"]);
  assert.equal(retrieved.binding.projectRoot, f.root);
  assert.equal(retrieved.publication.snapshot, null); assert.equal(retrieved.reusable, false);
  descriptors = [];
  assert.equal((await client.call("knowledge_status", {})).structuredContent.connected, false);
  descriptors = nativeTools();
  assert.equal((await client.call("knowledge_status", {})).structuredContent.connected, true);
  const normal = f.client.respond;
  f.client.respond = params => params.name === "read" ? textResult(markdown(metadata(), "x".repeat(30000))) : normal(params);
  const expanded = (await client.call("knowledge_read", { uri, collection: "architecture" })).structuredContent;
  assert.ok(expanded.next.continuation.connectionId);
  const other = await session(t, "mcp/openviking.mjs", [], f);
  await assert.rejects(other.call("knowledge_read", { uri, collection: "architecture", ...expanded.next }), /another knowledge binding or session/);
  assert.ok((await client.call("knowledge_read", { uri, collection: "architecture", ...expanded.next })).structuredContent.text.length);
  f.client.respond = params => params.name === "read" ? textResult(markdown({ ...metadata(), revision: "edition-2" }, "x".repeat(30000))) : normal(params);
  await assert.rejects(client.call("knowledge_read", { uri, collection: "architecture", ...expanded.next }), /revision changed/);
  await assert.rejects(client.call("write", { uri }), /Invalid knowledge/);
});
