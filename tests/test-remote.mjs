import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { fixture, session } from "./helpers.mjs";
import { dump, sleep, settings } from "../scripts/common.mjs";
import { smoke } from "../scripts/runtime.mjs";
import { reconnect_file } from "../scripts/project_paths.mjs";
import {
  RemoteMcp,
  RemoteRpcError,
  RemoteHttpError,
  RemoteSessionExpired,
  header_value,
  tool_header_fields,
} from "../scripts/remote_client.mjs";
import { all_pages } from "../scripts/mcp_pages.mjs";

async function endpoint(t, handler) {
  const calls = [],
    server = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      let message;
      try {
        message = text ? JSON.parse(text) : {};
      } catch {
        res.writeHead(400).end();
        return;
      }
      calls.push({
        message,
        headers: req.headers,
        path: req.url,
        method: req.method,
      });
      const reply = (result, status = 200, headers = {}) =>
        res
          .writeHead(status, { "Content-Type": "application/json", ...headers })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      const error = (code, status = 200) =>
        res
          .writeHead(status, { "Content-Type": "application/json" })
          .end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code, message: "fixture " + code },
            }),
          );
      try {
        await handler({ req, res, message, reply, error });
      } catch (error) {
        res.destroy(error);
      }
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  });
  return { calls, url: "http://127.0.0.1:" + server.address().port + "/mcp" };
}

test("workspace port changes rebind only the selected EDT relay", async t => {
  const first = fixture(t), other = fixture(t);
  const serve = id => endpoint(t, ({ res, message, reply, error }) => {
    if (message.method === "server/discover") return error(-32601);
    if (message.method === "initialize") return reply({ protocolVersion: "2025-11-25", serverInfo: { name: "edt-fixture", version: "1" }, capabilities: { tools: {} } });
    if (message.method.startsWith("notifications/")) return res.writeHead(202).end();
    if (message.method === "tools/list") return reply({ tools: [{ name: "ping", inputSchema: { type: "object" } }] });
    return reply({ content: [], structuredContent: { endpoint: id } });
  });
  const a = await serve("a"), b = await serve("b"),
    preferences = path.join(first.base, ".metadata/.plugins/org.eclipse.core.runtime/.settings/com.ditrix.edt.mcp.server.prefs");
  fs.mkdirSync(path.dirname(preferences), { recursive: true });
  const port = url => fs.writeFileSync(preferences, "mcpServerPort=" + new URL(url).port);
  port(a.url); first.save();
  other.profile.connections = { edt: { url: a.url } }; other.save();
  const c1 = await session(t, "scripts/lazy_mcp.mjs", ["--component", "edt"], first),
    c2 = await session(t, "scripts/lazy_mcp.mjs", ["--component", "edt"], other);
  for (const client of [c1, c2]) {
    assert.equal((await client.call("ping", {})).structuredContent.endpoint, "a");
  }
  const before = (await c2.call("core_runtime_status", {})).structuredContent;
  port(b.url);
  assert.equal((await c1.call("ping", {})).structuredContent.endpoint, "b");
  assert.equal((await c2.call("ping", {})).structuredContent.endpoint, "a");
  assert.equal((await c2.call("core_runtime_status", {})).structuredContent.binding.connectionId, before.binding.connectionId);
});

test("external code-index preparation checks scoped health without installing a managed runtime", async t => {
  const f = fixture(t), config = settings();
  let unhealthy = false;
  const e = await endpoint(t, ({ res, message, reply, error }) => {
    if (message.method === "server/discover") return error(-32601);
    if (message.method === "initialize") return reply({ protocolVersion: "2025-11-25", serverInfo: { name: "external-index", version: "fixture" }, capabilities: { tools: {} } });
    if (message.method.startsWith("notifications/")) return res.writeHead(202).end();
    if (message.method === "tools/list") return reply({ tools: [{ name: "health", inputSchema: { type: "object" } }] });
    assert.equal(message.method, "tools/call");
    assert.equal(message.params.name, "health");
    if (unhealthy) return reply({ isError: true, content: [{ type: "text", text: "health unavailable" }] });
    return reply({ content: [{ type: "text", text: JSON.stringify({ mcp: { status: "ok" }, daemon: { status: "online" }, repos: [{ repo: "product", root_path: f.root, path_status: { status: "ready" }, data_version: { stale: false } }] }) }] });
  });
  Object.assign(config.mcp.managed["code-index"], { mode: "external", url: e.url });
  const result = await smoke(f.state, config, f.root, f.profile, "code-index", 5);
  assert.equal(result.index_ready, true);
  assert.equal(result.server.name, "external-index");
  assert.deepEqual(fs.readdirSync(f.state).filter(name => name !== "diagnostics"), []);
  unhealthy = true;
  await assert.rejects(smoke(f.state, config, f.root, f.profile, "code-index", 5), /health failed.*health unavailable/);
});
test("environment credential references apply to authenticated calls and session cleanup",async t=>{
  const previous=process.env.CORE_TEST_AUTH_HEADER;process.env.CORE_TEST_AUTH_HEADER="Bearer fixture";
  t.after(()=>{if(previous===undefined)delete process.env.CORE_TEST_AUTH_HEADER;else process.env.CORE_TEST_AUTH_HEADER=previous;});
  const e=await endpoint(t,({req,res,message,reply,error})=>{
    assert.equal(req.headers.authorization,"Bearer fixture");
    if(req.method==="DELETE")return res.writeHead(204).end();
    if(message.method==="server/discover")return error(-32601);
    if(message.method==="initialize")return reply({protocolVersion:"2024-11-05",capabilities:{}},200,{"Mcp-Session-Id":"authenticated"});
    if(message.method.startsWith("notifications/"))return res.writeHead(202).end();return reply({tools:[]});
  });
  const c=new RemoteMcp(e.url,5,{headers_env:{Authorization:"CORE_TEST_AUTH_HEADER"}});
  await c.initialize();await c.request("tools/list");await c.close();
  assert.equal(e.calls.at(-1).method,"DELETE");assert.equal(e.calls.at(-1).headers.authorization,"Bearer fixture");
});
for(const type of ["application/json","text/event-stream"])test("configured memory budget covers HTTP "+type,async t=>{
  const e=await endpoint(t,({res,message})=>{const text=JSON.stringify({jsonrpc:"2.0",id:message.id,result:{content:[{type:"text",text:"x".repeat(2048)}]}});res.writeHead(200,{"Content-Type":type}).end(type==="application/json"?text:"data: "+text+"\n\n");});
  const c=new RemoteMcp(e.url,5,{maxBytes:1024});await assert.rejects(c.request("tools/call",{name:"large"}),/budget exceeded/);
});
test("remote relay cancellation uses the upstream HTTP id before the response finishes",async t=>{
  const f=fixture(t);let cancelled=null;
  const e=await endpoint(t,({res,message,reply,error})=>{
    if(message.method==="server/discover")return error(-32601);
    if(message.method==="initialize")return reply({protocolVersion:"2024-11-05",capabilities:{tools:{}}});
    if(message.method==="notifications/cancelled"){cancelled=message.params.requestId;return res.writeHead(202).end();}
    if(message.method.startsWith("notifications/"))return res.writeHead(202).end();
    if(message.method==="tools/list")return reply({tools:[{name:"slow",inputSchema:{type:"object"}}]});
    setTimeout(()=>reply({content:[],structuredContent:{upstreamId:message.id,cancelled}}),350);
  });
  f.profile.connections={edt:{url:e.url}};f.save();const c=await session(t,"scripts/lazy_mcp.mjs",["--component","edt"],f);
  await c.request("tools/list");const work=c.request("tools/call",{name:"slow"}),hostId=c.sequence;
  await sleep(70);c.notify("notifications/cancelled",{requestId:hostId});
  const result=(await work).structuredContent;assert.equal(result.cancelled,result.upstreamId);
});
test("legacy negotiation omits initialize version header; sessions reuse and DELETE remain isolated", async (t) => {
  let counter = 0;
  const deleted = [];
  const e = await endpoint(t, ({ req, res, message, reply, error }) => {
    if (req.method === "DELETE") {
      deleted.push(req.headers["mcp-session-id"]);
      res.writeHead(204).end();
      return;
    }
    if (message.method === "server/discover") return error(-32601);
    if (message.method === "initialize") {
      assert.equal(req.headers["mcp-protocol-version"], undefined);
      return reply({ protocolVersion: "2024-11-05", capabilities: {} }, 200, {
        "Mcp-Session-Id": "session-" + ++counter,
      });
    }
    if (message.method.startsWith("notifications/"))
      return res.writeHead(202).end();
    return reply({ tools: [] });
  });
  const a = new RemoteMcp(e.url),
    b = new RemoteMcp(e.url);
  await a.initialize();
  await b.initialize();
  const second = b.session;
  await a.close();
  assert.deepEqual(deleted, ["session-1"]);
  assert.equal(b.session, second);
  await b.request("tools/list");
  assert.equal(e.calls.at(-1).headers["mcp-session-id"], second);
  await b.close();
});
test("modern negotiation is stateless and mirrors validated Unicode, number and boolean headers", async (t) => {
  const e = await endpoint(t, ({ req, res, message, reply }) => {
    assert.equal(req.headers["mcp-session-id"], undefined);
    assert.equal(
      message.params._meta["io.modelcontextprotocol/protocolVersion"],
      "2026-07-28",
    );
    if (message.method === "server/discover")
      return reply({
        supportedVersions: ["2026-07-28"],
        capabilities: {},
        instructions: "modern",
      });
    if (message.method === "tools/list")
      return reply({
        tools: [
          {
            name: "стандарт",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", "x-mcp-header": "Query" },
                count: { type: "integer", "x-mcp-header": "Count" },
                flag: { type: "boolean", "x-mcp-header": "Flag" },
              },
            },
          },
        ],
      });
    assert.equal(req.headers["mcp-name"], header_value("стандарт"));
    assert.equal(req.headers["mcp-param-query"], header_value("строка\ntext"));
    assert.equal(req.headers["mcp-param-count"], "42");
    assert.equal(req.headers["mcp-param-flag"], "false");
    return reply({ content: [] });
  });
  const client = new RemoteMcp(e.url);
  await client.initialize();
  await client.request("tools/list");
  await client.request("tools/call", {
    name: "стандарт",
    arguments: { query: "строка\ntext", count: 42, flag: false },
    _meta: { "io.modelcontextprotocol/protocolVersion": "wrong" },
  });
  const before = e.calls.length;
  await assert.rejects(
    client.request("tools/call", {
      name: "стандарт",
      arguments: { count: true },
    }),
    /Invalid HTTP-mirrored/,
  );
  assert.equal(e.calls.length, before);
  await client.close();
  assert.equal(e.calls.length, before);
});
for (const annotation of [
  { type: "string", "x-mcp-header": "Bad Header" },
  { type: "array", "x-mcp-header": "Items" },
])
  test(
    "invalid native HTTP contract stays discoverable with a specific call error: " + annotation.type,
    async (t) => {
      const e = await endpoint(t, ({ message, reply }) =>
        reply(
          message.method === "server/discover"
            ? { supportedVersions: ["2026-07-28"] }
            : {
                tools: [
                  {
                    name: "bad",
                    inputSchema: {
                      type: "object",
                      properties: { value: annotation },
                    },
                  },
                  { name: "good", inputSchema: { type: "object" } },
                ],
              },
        ),
      );
      const client = new RemoteMcp(e.url);
      await client.initialize();
      assert.deepEqual(
        (await client.request("tools/list")).tools.map((tool) => tool.name),
        ["bad", "good"],
      );
      await assert.rejects(client.request("tools/call",{name:"bad",arguments:{}}),/Incompatible native HTTP contract/);
      await client.close();
    },
  );
test("duplicate and deeply misplaced header annotations fail closed", () => {
  assert.throws(() =>
    tool_header_fields({ "x-mcp-header": "Top", type: "string" }),
  );
  assert.throws(() =>
    tool_header_fields({
      type: "object",
      properties: {
        a: { type: "string", "x-mcp-header": "Key" },
        b: { type: "string", "x-mcp-header": "key" },
      },
    }),
  );
});
for (const mode of [
  "wrong id",
  "202",
  "204",
  "input_required",
  "closed stream",
])
  test(
    "uncertain mutation is never confirmed or retried: " + mode,
    async (t) => {
      const e = await endpoint(t, ({ res, message, reply }) => {
        if (mode === "wrong id")
          return res
            .writeHead(200, { "Content-Type": "application/json" })
            .end('{"id":9999,"result":{}}');
        if (mode === "202" || mode === "204")
          return res.writeHead(Number(mode)).end();
        if (mode === "input_required")
          return reply({ resultType: "input_required" });
        res
          .writeHead(200, { "Content-Type": "text/event-stream" })
          .end('data: {"method":"notifications/progress","params":{}}\n\n');
      });
      const client = new RemoteMcp(e.url);
      await assert.rejects(
        client.request("tools/call", { name: "write" }),
        /unknown|not confirmed complete/,
      );
      assert.equal(e.calls.length, 1);
    },
  );
test("SSE notifications invalidate tools without losing the complete tool result", async (t) => {
  const e = await endpoint(t, ({ res, message }) =>
    res
      .writeHead(200, { "Content-Type": "text/event-stream" })
      .end(
        'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\ndata: ' +
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [], isError: false },
          }) +
          "\n\n",
      ),
  );
  const client = new RemoteMcp(e.url);
  assert.deepEqual(await client.request("tools/call"), {
    content: [],
    isError: false,
  });
  assert.equal(client.tools_revision, 1);
});
for (const [status, code, expired] of [
  [400, -32600, false],
  [404, -32601, false],
  [404, -32000, true],
  [401, -32000, false],
])
  test(`HTTP ${status}/${code} expiration is classified precisely`, async (t) => {
    const e = await endpoint(t, ({ error }) => error(code, status)),
      client = new RemoteMcp(e.url);
    client.session = "owned";
    await assert.rejects(client.request("tools/list"), (error) =>
      expired
        ? error instanceof RemoteSessionExpired
        : error instanceof RemoteHttpError &&
          !(error instanceof RemoteSessionExpired),
    );
    assert.equal(e.calls.length, 1);
  });
for (const [status, code] of [
  [401, -32601],
  [500, -32601],
  [400, -32020],
  [200, -32021],
  [200, -32022],
])
  test(`negotiation does not hide auth/modern failure ${status}/${code}`, async (t) => {
    const e = await endpoint(t, ({ error }) => error(code, status)),
      client = new RemoteMcp(e.url);
    await assert.rejects(client.initialize());
    assert.equal(e.calls.length, 1);
  });
test("pagination enforces identity, continuation, cursor and item limits", async () => {
  for (const result of [
    { tools: [{ name: "same" }, { name: "same" }] },
    { tools: [], nextCursor: "" },
    { tools: [{ name: null }] },
    { tools: [], nextCursor: "repeat" },
    { tools: Array.from({ length: 2001 }, (_, i) => ({ name: "t" + i })) },
  ])
    await assert.rejects(
      all_pages({ request: async () => result }, "tools/list", "tools"),
    );
  await assert.rejects(
    all_pages(
      {
        request: async (method, params) => {
          if (!params.cursor)
            return { resources: [{ uri: "fixture://a" }], nextCursor: "tail" };
          throw new RemoteRpcError({ code: -32601 });
        },
      },
      "resources/list",
      "resources",
    ),
    /Incomplete.*pagination/,
  );
});
test("lazy relay preserves paginated tools/results, bounded discovery and independent project contracts", async (t) => {
  const f = fixture(t),
    enabled = new Set(),
    e = await endpoint(t, ({ req, res, message, reply, error }) => {
      if (req.method === "DELETE") return res.writeHead(204).end();
      const route = req.url,
        params = message.params || {},
        tool = (name) => ({
          name,
          inputSchema: {
            type: "object",
            properties: { context: { type: "string" } },
          },
        });
      if (message.method === "server/discover") return error(-32601);
      if (message.method === "initialize")
        return reply({
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: true } },
          instructions: "Read corpus " + route,
          serverInfo: { name: route, version: "1" },
        });
      if (message.method.startsWith("notifications/"))
        return res.writeHead(202).end();
      if (message.method === "tools/list")
        return reply(
          params.cursor
            ? { tools: [tool("tail")] }
            : {
                tools: [
                  tool("inspect"),
                  ...(enabled.has(route) ? [tool("activated")] : []),
                ],
                nextCursor: "tail",
              },
        );
      if (message.method === "tools/call") {
        enabled.add(route);
        return reply({
          content: [{ type: "text", text: route }],
          structuredContent: {
            body_truncated: true,
            rows_elided_already_delivered: 3,
            context: params.arguments.context,
          },
        });
      }
      if (message.method === "resources/list")
        return reply({
          resources: [
            { uri: "fixture://a", name: "same" },
            { uri: "fixture://b", name: "same" },
          ],
        });
      return error(-32601);
    });
  f.profile.connections = { edt: { url: e.url }, v8std: { url: e.url } };
  f.save();
  const a = await session(
      t,
      "scripts/lazy_mcp.mjs",
      ["--component", "v8std"],
      f,
    ),
    b = await session(t, "scripts/lazy_mcp.mjs", ["--component", "v8std"], f, {
      EDT_AI_INSTANCE: "second",
      EDT_AI_V8STD_URL: e.url.replace("/mcp", "/other"),
    });
  const names = async (c) =>
    (await c.request("tools/list")).tools.map((tool) => tool.name);
  assert.deepEqual(await names(a), ["core_runtime_status", "core_runtime_tools", "core_runtime_call", "inspect", "tail"]);
  assert.ok((await names(b)).includes("tail"));
  const before = e.calls.filter(
    (x) => x.message.method === "tools/list",
  ).length;
  for (let i = 0; i < 3; i++) {
    const result = await a.call("inspect", { context: "project A" });
    assert.equal(result.structuredContent.rows_elided_already_delivered, 3);
    assert.equal(result.structuredContent.context, "project A");
  }
  assert.equal(
    e.calls.filter((x) => x.message.method === "tools/list").length,
    before,
  );
  assert.ok((await names(a)).includes("activated"));
  assert.ok(!(await names(b)).includes("activated"));
  assert.equal((await a.request("resources/list")).resources.length, 2);
  assert.deepEqual(await a.request("prompts/list"), { prompts: [] });
  const statusA = (await a.call("core_runtime_status", {})).structuredContent,
    statusB = (await b.call("core_runtime_status", {})).structuredContent;
  assert.notEqual(statusA.binding.connectionId, statusB.binding.connectionId);
  assert.match(statusA.serverContract.instructions, /mcp/);
  const token = reconnect_file(f.state, f.root);
  const env = { ...process.env.EDT_AI_INSTANCE }; // token name belongs to this fixture's first instance
  const firstToken = path.join(path.dirname(token), "first.reconnect.json");
  fs.mkdirSync(path.dirname(firstToken), { recursive: true });
  fs.writeFileSync(firstToken, '{"id":"changed"}');
  const rebound = (await a.call("core_runtime_status", {})).structuredContent;
  assert.notEqual(rebound.binding.connectionId, statusA.binding.connectionId);
  assert.equal(
    (await b.call("core_runtime_status", {})).structuredContent.binding
      .connectionId,
    statusB.binding.connectionId,
  );
  fs.writeFileSync(path.join(f.root, ".ai/project.yaml"), "bad");
  assert.equal(
    (await a.call("core_runtime_status", {})).structuredContent.ready,
    false,
  );
  f.save();
  assert.equal(
    (await a.call("core_runtime_status", {})).structuredContent.ready,
    true,
  );
});
test("failed lazy startup retries on the next host request without a config change", async (t) => {
  const f = fixture(t);
  let fail = true;
  const e = await endpoint(t, ({ message, reply, error }) => {
    if (message.method === "server/discover")
      return fail
        ? error(-32000, 503)
        : reply({ supportedVersions: ["2026-07-28"], capabilities: {} });
    return reply({ tools: [{ name: "ready", inputSchema: {} }] });
  });
  f.profile.connections = { edt: { url: e.url } };
  f.save();
  const client = await session(
    t,
    "scripts/lazy_mcp.mjs",
    ["--component", "edt"],
    f,
  );
  assert.equal(
    (await client.call("core_runtime_status", {})).structuredContent.ready,
    false,
  );
  const count = e.calls.length;
  await sleep(700);
  assert.equal(e.calls.length, count);
  fail = false;
  assert.equal(
    (await client.call("core_runtime_status", {})).structuredContent.ready,
    true,
  );
});
