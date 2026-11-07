import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, environment, session, ROOT } from "./helpers.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { dump, load, parse } from "../scripts/common.mjs";
import { profile_history } from "../scripts/profile_history.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { project_directory } from "../scripts/project_paths.mjs";
import { createServer } from "node:http";
import { once } from "node:events";
import { save_readiness, read_component_checks, save_component_checks } from "../scripts/setup_readiness.mjs";
import { project_profile } from "../scripts/profile.mjs";

test("scope metadata includes local YAML leaves without exposing their values", async t => {
  const f=fixture(t),directory=path.join(f.root,".ai");fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory,"project.yaml"),JSON.stringify(f.profile));
  fs.writeFileSync(path.join(directory,"project.local.yaml"),JSON.stringify({project:{purpose:"machine-specific"},testing:{yaxunit:false,commands:[]},connections:{edt:{url:""}},components:{"code-index":{},"bsl-ls":{enabled:false,headers_env:{}}}}));
  const backend=new SettingsBackend(f.state,f.env.EDT_AI_SETTINGS),config={active_project:f.root,mcp:{managed:{"bsl-ls":{java:"java"}}}};
  const result=backend.setting_scope_data(config,{status:"loaded"});
  assert.deepEqual(result.localOverridePaths,[["project","purpose"],["testing","yaxunit"],["testing","commands"],["connections","edt","url"],["components","bsl-ls","enabled"],["components","bsl-ls","headers_env"]]);
  assert.equal(result.layerValues.project_local.bslLsEnabled,false);assert.equal(result.layerValues.project_local.edtUrl,"");
  assert.equal(result.layerValues.global.bslLsJava,"java");
  assert.deepEqual(backend.setting_scope_data(config,{status:"invalid"}),{layerValues:{},localOverridePaths:[]});
  const client=await session(t,"mcp/settings.mjs",[],f),snapshot=(await client.call("settings.read",{})).structuredContent;
  assert.deepEqual(snapshot.localOverridePaths,result.localOverridePaths);
});

test("addressed probes preserve other results, do not prepare services and expire per instance", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const backend = new SettingsBackend(), original = fs.readFileSync(path.join(f.root, ".ai/project.yaml"));
  const seen = new Set();
  for (const component of ["edt", "v8std", "openviking", "code-index", "bsl-ls", "yaxunit", "vanessa"]) {
    const result = await backend.main({ action: "probe", component });
    assert.deepEqual(result.componentChecks.map(item => item.id), [component]);
    assert.ok(Object.keys(result.external).every(id => id === component));
    assert.ok((result.managed || []).every(item => item.name === component));
    assert.notEqual(result.componentChecks[0].state, "ready");
    seen.add(component);
    const current = await backend.main({ action: "read" });
    assert.deepEqual(new Set(current.componentChecks.map(item => item.id)), seen);
    assert.equal(current.readiness.state, "not_checked", "a partial probe cannot assert full setup readiness");
  }
  assert.deepEqual(fs.readFileSync(path.join(f.root, ".ai/project.yaml")), original);
  for (const file of [f.env.EDT_AI_SETTINGS, path.join(f.state, "runtime-lock.json"), path.join(f.state, "runtime")]) assert.equal(fs.existsSync(file), false);
  const before = (await backend.main({ action: "read" })).componentChecks;
  process.env.EDT_AI_INSTANCE = "other";
  assert.deepEqual((await backend.main({ action: "read" })).componentChecks, []);
  process.env.EDT_AI_INSTANCE = f.env.EDT_AI_INSTANCE;
  assert.deepEqual((await backend.main({ action: "read" })).componentChecks, before);
  f.profile.project.id = "changed-profile"; f.save();
  assert.deepEqual((await backend.main({ action: "read" })).componentChecks, before, "renaming the project does not change any component probe inputs");
  await assert.rejects(backend.main({ action: "probe", component: "unknown" }), /компонент/);
  await assert.rejects(backend.main({ action: "probe", component: "edt", connections: { v8std: "" } }), /только выбранного/);
});

test("addressed external probe contacts only its endpoint and preserves a full setup receipt", async t => {
  const f = fixture(t); environment(t, f.env);
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(200).end(); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw); requests.push({ path: req.url, method: message.method });
    if (!Object.hasOwn(message, "id")) { res.writeHead(202).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result:
      message.method === "server/discover" ? { supportedVersions: ["2026-07-28"], serverInfo: { name: "fixture", version: "1" } } : { tools: [{ name: "fixture", inputSchema: { type: "object" } }] } }));
  }); server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  f.profile.connections = { edt: { url: base + "/edt" }, v8std: { url: base + "/v8std" } }; f.save();
  const backend = new SettingsBackend(), config = backend.effective(backend.current());
  const setup = save_readiness(f.state, config, project_profile(f.root), [{ name: "bsl-ls", ready: false, state: "error", detail: "BSL error" }], {});
  const result = await backend.main({ action: "probe", component: "v8std" });
  assert.equal(result.componentChecks[0].state, "ready", JSON.stringify(result));
  assert.ok(requests.length > 0); assert.ok(requests.every(item => item.path === "/v8std"));
  let current = await backend.main({ action: "read" });
  assert.equal(current.readiness.state,setup.state);assert.equal(current.readiness.checkedAt,setup.checkedAt);assert.equal(current.readiness.expiresAt,setup.expiresAt);
  assert.equal(current.componentChecks.find(item=>item.id==="v8std").state, "ready");
  const saved = current.componentChecks.find(item=>item.id==="v8std");
  const draft = await backend.main({ action: "probe", component: "v8std", connections: { v8std: "" } });
  assert.equal(draft.draft, true); assert.equal(draft.componentChecks[0].state, "missing_config");
  current = await backend.main({ action: "read" }); assert.deepEqual(current.componentChecks.find(item=>item.id==="v8std"), saved);
  const old = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  save_component_checks(f.state, config, project_profile(f.root), [{ id: "v8std", state: "ready", checkedAt: old }]);
  assert.equal(read_component_checks(f.state, config, project_profile(f.root)).find(item=>item.id==="v8std").state, "check_stale");
});

test("YaXUnit requires EDT launch evidence and Vanessa requires its runtime profile", async t => {
  const f = fixture(t); environment(t, f.env);
  f.profile.testing.yaxunit = true;
  f.profile.testing.yaxunit_config = { repository_id: "product", runner: "edt", results: "test-results" };
  f.profile.testing.vanessa = true;
  f.profile.testing.vanessa_config = { repository_id: "product", runtime_profile: "vanessa.json", features: "features", results: "ui-results", server_name: "vanessa" };
  f.save(); const backend = new SettingsBackend();
  for (const component of ["yaxunit", "vanessa"]) {
    const result = await backend.main({ action: "probe", component });
    assert.equal(result.componentChecks[0].state, component === "yaxunit" ? "error" : "missing_config");
    if (component === "yaxunit") assert.equal(result.componentChecks[0].reasonCode, "edt_unavailable");
    else assert.match(result.componentChecks[0].detail, /Не найден runtime-профиль/);
    assert.deepEqual(result.external, {});
  }
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS), false);
  const current = await backend.main({ action: "read" });
  assert.deepEqual(current.testing.yaxunit_config, f.profile.testing.yaxunit_config);
  assert.deepEqual(current.testing.vanessa_config, f.profile.testing.vanessa_config);
  assert.equal(current.testing.commands, undefined);
});

test("external managed probes use the existing smoke gate only for the selected service", async t => {
  const f = fixture(t); environment(t, f.env);
  fs.writeFileSync(path.join(f.root, ".project"), "<projectDescription><name>Product</name></projectDescription>");
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(200).end(); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw); requests.push([req.url, message.method]);
    if (!Object.hasOwn(message, "id")) { res.writeHead(202).end(); return; }
    const tools = req.url === "/bsl-ls" ? ["register_workspace_folder", "list_workspace_folders", "unregister_workspace_folder"].map(name => ({ name })).concat([
      { name: "analyzer", inputSchema: { type: "object", properties: { workspaceFolder: { type: "string" } }, required: ["workspaceFolder"] } }]) : [{ name: "health", inputSchema: { type: "object" } }];
    const result = message.method === "server/discover" ? { supportedVersions: ["2026-07-28"], serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list" ? { tools }
      : { structuredContent: { mcp: { status: "ok" }, daemon: { status: "online" }, repos: [{ repo: "product", root_path: f.root, path_status: { status: "ready" }, data_version: { stale: false } }] } };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  }); server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  f.profile.components = Object.fromEntries(["code-index", "bsl-ls"].map(id => [id, { enabled: true, mode: "external", url: base + "/" + id }])); f.save();
  const backend = new SettingsBackend();
  for (const component of ["code-index", "bsl-ls"]) {
    requests.length = 0;
    const result = await backend.main({ action: "probe", component });
    assert.deepEqual(result.componentChecks.map(item => [item.id, item.state]), [[component, "ready"]], JSON.stringify(result));
    assert.ok(requests.length); assert.ok(requests.every(([url]) => url === "/" + component));
    assert.equal((await backend.main({ action: "read" })).componentChecks.find(item => item.id === component).state, "ready");
  }
  assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
});

test("local checks retain successful API evidence and do not treat an old error as current", async t => {
  const f = fixture(t); environment(t, f.env); f.save(); const backend = new SettingsBackend();
  const config = backend.effective(backend.current()), profile = project_profile(f.root);
  for (const state of ["ready", "error"]) {
    const saved = save_component_checks(f.state, config, profile, [{ id: "bsl-ls", state, detail: "Последняя проверка", checkedAt: new Date(Date.now() - 1000).toISOString() }])[0];
    const checked = (await backend.main({ action: "probe", component: "bsl-ls" })).componentChecks[0];
    assert.equal(checked.state, state === "ready" ? "ready" : "not_verified");
    if (state === "ready") { assert.equal(checked.checkedAt, saved.checkedAt); assert.equal(checked.expiresAt, saved.expiresAt); }
  }
  assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
});

test("the app readiness refresh returns a scoped operation and cannot prepare another profile", async t => {
  const f=fixture(t);f.save();const client=await session(t,"mcp/settings.mjs",[],f);
  const catalogue=(await client.request("tools/list",{})).tools;
  assert.deepEqual(catalogue.find(item=>item.name==="settings.refresh_readiness")._meta.ui.visibility,["app"]);
  await assert.rejects(client.call("settings.refresh_readiness",{}),/scope/);
  const other=path.join(f.base,"other");fs.mkdirSync(other);dump(f.profile,path.join(other,".ai/project.yaml"));
  const viewed=(await client.call("settings.select_profile",{projectRoot:other})).structuredContent;assert.equal(viewed.viewOnly,true);
  const denied=(await client.call("settings.refresh_readiness",{scope:other+"#first"})).structuredContent;
  const failure=(await client.call("settings.operation",{operationId:denied.id,waitMs:10000})).structuredContent;
  assert.equal(failure.status,"failed");assert.match(failure.error,/другой папке или экземпляру/);
  const job=(await client.call("settings.refresh_readiness",{scope:f.root+"#first"})).structuredContent;
  const checked=(await client.call("settings.operation",{operationId:job.id,waitMs:10000})).structuredContent;
  assert.equal(checked.status,"completed");assert.equal(checked.action,"refresh_readiness");assert.equal(checked.result.projectRoot,f.root);
  assert.equal(checked.result.managed.find(item=>item.name==="code-index").state,"stopped");
  assert.equal(checked.result.componentChecks.length,7);
  assert.equal((await client.call("settings.read",{})).structuredContent.values.projectRoot,f.root);
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});

test("settings can be saved during background readiness without publishing the old observation", async t => {
  const f=fixture(t);f.save();let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});t.after(()=>release());
  const server=createServer(async(req,res)=>{
    let body="";for await(const part of req)body+=part;
    if(!body){res.writeHead(202).end();return;}const message=JSON.parse(body);
    const reply=result=>res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:message.id,result}));
    if(message.method==="server/discover")return res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"legacy"}}));
    if(message.method==="initialize"){entered();await gate;return reply({protocolVersion:"2025-11-25",serverInfo:{name:"fixture",version:"1"},capabilities:{tools:{}}});}
    if(message.method.startsWith("notifications/"))return res.writeHead(202).end();
    if(message.method==="tools/list")return reply({tools:[{name:"list_projects",inputSchema:{type:"object"}}]});
    if(message.method==="tools/call")return reply({structuredContent:{projects:[{name:"Product",path:f.root,open:true,state:"ready",edtProject:true}]}});
    reply({});
  });server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>{server.closeAllConnections();return new Promise(done=>server.close(done));});
  const client=new McpClient([process.execPath,path.join(ROOT,"mcp/settings.mjs")],ROOT,{...f.env,EDT_AI_PROJECT_ROOT:""},10);f.clients.push(client);client.roots=[];await client.initialize();
  await client.call("settings.select_profile",{projectRoot:f.root});
  await client.call("settings.update",{set:{codeIndexEnabled:false,bslLsEnabled:false,edtUrl:"http://127.0.0.1:"+server.address().port+"/edt",v8stdUrl:""}});
  const job=(await client.call("settings.refresh_readiness",{scope:f.root+"#first"})).structuredContent;await started;
  const saved=(await client.call("settings.update",{set:{edtUrl:""}})).structuredContent;
  assert.equal(saved.values.edtUrl,"");
  const foreground=(await client.call("settings.run_check",{authorization:{scope:f.root+"#first",effects:["launch"],evidence:"user requested setup check"}})).structuredContent;
  assert.equal(foreground.action,"check");
  const finished=(await client.call("settings.operation",{operationId:foreground.id,waitMs:10000})).structuredContent;
  assert.equal(finished.status,"completed");assert.notEqual(finished.result.superseded,true);
  const other=path.join(f.base,"other");fs.mkdirSync(other);dump(f.profile,path.join(other,".ai/project.yaml"));
  const selected=(await client.call("settings.select_profile",{projectRoot:other})).structuredContent;
  assert.equal(selected.viewOnly,false);assert.equal(selected.values.projectRoot,other);
  await client.call("settings.update",{set:{edtUrl:""}});
  assert.equal((await client.call("settings.edit",{layerScope:"profile",format:"yaml"})).isError,undefined);
  release();
  const done=(await client.call("settings.operation",{operationId:job.id,waitMs:10000})).structuredContent;
  assert.equal(done.status,"completed");assert.equal(done.projectRoot,f.root);assert.equal(done.result.projectRoot,f.root);assert.equal(done.result.superseded,true);
  const current=(await client.call("settings.read",{})).structuredContent;assert.equal(current.values.projectRoot,other);assert.equal(current.readiness.state,"not_checked");
});

test("an unavailable managed index does not make the saved check stale or claim readiness", async t => {
  const f=fixture(t);environment(t,f.env);f.save();
  const backend=new SettingsBackend(),config=backend.effective(backend.current());
  const managed=[{name:"code-index",ready:true,state:"ready"},{name:"bsl-ls",ready:true,state:"ready"},{name:"policy",ready:true,state:"ready"}];
  const external={edt:{configured:true,connected:true,ready:true},v8std:{configured:true,connected:true,ready:true}};
  assert.equal(save_readiness(f.state,config,f.profile,managed,external).state,"ready");
  const current=await backend.main({action:"status"});
  assert.equal(current.readiness.state,"blocked");
  assert.equal(current.readiness.checks.find(item=>item.id==="code-index").state,"not_checked");
  assert.equal(current.summary.components.find(item=>item.id==="code-index").status,"not_checked");
});

test("profile status restores both managed checks and expires their scoped evidence", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const backend = new SettingsBackend();
  await backend.main({ action: "update", set: { bslLsEnabled: true } });
  const server = createServer((req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ pid: process.pid, status: "running" })));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  const metadata = path.join(project_directory(f.state, f.root), "code-index/daemon.json");
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.writeFileSync(metadata, JSON.stringify({ pid: process.pid, http_port: server.address().port }));
  const managed = [{ name: "code-index", ready: true, state: "ready", repositories: [{ id: "product", edtProject: "Product", state: "ready" }] }, { name: "bsl-ls", ready: true, state: "ready" }];
  const config = backend.effective(backend.current());
  const saved = save_readiness(f.state, config, project_profile(f.root), managed, { edt: { configured: false, connected: false } });
  assert.equal(saved.state, "blocked");
  for (const action of ["read", "status"]) {
    const current = await backend.main({ action });
    assert.deepEqual(current.readiness.checks.find(item => item.id === "code-index").repositories, managed[0].repositories);
    for (const id of ["code-index", "bsl-ls"]) {
      const item = current.summary.components.find(item => item.id === id);
      assert.equal(item.status, "ready");
      assert.equal(item.checkedAt, saved.checkedAt);
    }
  }
  process.env.EDT_AI_INSTANCE = "another";
  await backend.main({ action: "update", set: { bslLsEnabled: true } });
  assert.equal((await backend.main({ action: "read" })).summary.components.find(item => item.id === "bsl-ls").status, "not_checked");
  process.env.EDT_AI_INSTANCE = f.env.EDT_AI_INSTANCE;
  fs.rmSync(metadata);
  assert.equal((await backend.main({ action: "read" })).summary.components.find(item => item.id === "code-index").status, "not_checked");
  f.profile.project.id = "changed"; f.save();
  assert.equal((await backend.main({ action: "read" })).summary.components.find(item => item.id === "bsl-ls").status, "ready");
  managed[1] = { name: "bsl-ls", ready: false, state: "error", detail: "API unavailable" };
  save_readiness(f.state, config, project_profile(f.root), managed, {});
  const failed = (await backend.main({ action: "read" })).summary.components.find(item => item.id === "bsl-ls");
  assert.equal(failed.status, "error"); assert.equal(failed.detail, "API unavailable");
  assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
});

test("default authorities stay configured while explicit managed opt-outs are preserved", async t => {
  const f = fixture(t); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  const initial = (await client.call("settings.read", {})).structuredContent;
  assert.equal(initial.values.codeIndexEnabled, true);
  assert.equal(initial.values.bslLsEnabled, true);
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, "settings/defaults.json"), "utf8"));
  assert.equal(defaults.mcp.required.edt.mode, "user");
  assert.equal(defaults.mcp.required.v8std.mode, "user");
  assert.equal(defaults.mcp.required.edt.url, "");
  assert.equal(defaults.mcp.required.v8std.url, "");
  await client.call("settings.update", { set: { codeIndexEnabled: false, bslLsEnabled: false } });
  const current = (await client.call("settings.read", {})).structuredContent;
  assert.equal(current.values.codeIndexEnabled, false);
  assert.equal(current.values.bslLsEnabled, false);
  for (const id of ["code-index", "bsl-ls"])
    assert.equal(current.summary.components.find(item => item.id === id).status, "disabled");
  assert.equal(fs.existsSync(path.join(f.state, "runtime")), false);
});

test("loading settings returns fresh service status without a separate status request or preparation", async t => {
  const f = fixture(t); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  const initial = (await client.call("settings.read", {})).structuredContent;
  assert.equal(initial.summary?.components.find(item => item.id === "code-index")?.status, "not_checked");
  assert.equal(initial.values.codeIndexEnabled, true);
  assert.equal(initial.values.bslLsEnabled, true);
  assert.equal(initial.summary.components.find(item => item.id === "bsl-ls").status, "not_checked");
  assert.equal(fs.existsSync(path.join(f.state, "projects")), false);
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ pid: process.pid, status: "running" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  const home = path.join(project_directory(f.state, f.root), "code-index");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ pid: process.pid, http_port: server.address().port }));
  for (const name of ["settings.read", "settings.open", "settings.profile"]) {
    const current = (await client.call(name, {})).structuredContent;
    assert.equal(current.summary.components.find(item => item.id === "code-index").status, "running", name);
    assert.ok(Number.isFinite(Date.parse(current.summary.observedAt)));
    assert.equal(current.readiness.state, "not_checked");
    assert.equal(current.operation.status, "idle");
  }
  await client.call("settings.load", {});
  fs.rmSync(path.join(home, "daemon.json"));
  const reloaded = (await client.call("settings.read", {})).structuredContent;
  assert.equal(reloaded.summary.components.find(item => item.id === "code-index").status, "not_checked");
  assert.deepEqual(requests, ["/health", "/health", "/health"]);
  assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
});

test("unavailable daemon metadata does not prevent loading a valid profile or its settings", async t => {
  const f = fixture(t); f.save();
  const home = path.join(project_directory(f.state, f.root), "code-index"), metadata = path.join(home, "daemon.json");
  fs.mkdirSync(home, { recursive: true });
  const client = await session(t, "mcp/settings.mjs", [], f);
  for (const content of ["{", "null", null]) {
    if (content === null) { fs.rmSync(metadata); fs.mkdirSync(metadata); }
    else fs.writeFileSync(metadata, content);
    for (const name of ["settings.read", "settings.open", "settings.profile", "settings.select_profile"]) {
      const current = (await client.call(name, name === "settings.select_profile" ? { projectRoot: f.root } : {})).structuredContent;
      assert.equal(current.profile.status, "loaded", name);
      assert.notEqual(current.configurationError, true);
      assert.equal(current.values.projectRoot, f.root);
      assert.equal(current.summary?.components.find(item => item.id === "code-index")?.status, "not_checked");
      assert.equal(current.operation.status, "idle");
    }
  }
  assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
});

test("connection probe overrides are transient and validated before contacting services", async t => {
  const f=fixture(t);environment(t,f.env);f.save();const backend=new SettingsBackend();
  const before=await backend.main({action:"read"}), profileBytes=fs.readFileSync(path.join(f.root,".ai/project.yaml"));
  const result=await backend.main({action:"probe",connections:{edt:"",v8std:""}});
  assert.equal(result.external.edt.configured,false);assert.equal(result.external.v8std.configured,false);
  assert.deepEqual((await backend.main({action:"read"})).values,before.values);
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS),false);assert.deepEqual(fs.readFileSync(path.join(f.root,".ai/project.yaml")),profileBytes);
  await assert.rejects(backend.main({action:"probe",connections:{edt:"file:///invalid"}}));
  await assert.rejects(backend.main({action:"probe",connections:{unknown:""}}));
});

test("history persists across sessions, detects damaged and removed profiles, and keeps unavailable directories", async t => {
  const f=fixture(t);environment(t,f.env);f.save();const backend=new SettingsBackend();
  await backend.main({action:"read"});assert.equal(fs.existsSync(path.join(f.state,"projects")),false);
  await backend.main({action:"read",remember:true});
  const other=path.join(f.base,"other");fs.mkdirSync(other);fs.mkdirSync(path.join(other,"src"));
  dump({...f.profile,project:{...f.profile.project,id:"other"}},path.join(other,".ai/project.yaml"));
  process.env.EDT_AI_PROJECT_ROOT=other;
  await backend.main({action:"read",remember:true});
  const entries=profile_history(f.state);assert.equal(entries.length,2);assert.ok(entries.every(item=>item.lastOpened&&item.repositoryCount===1));
  const lastOpened=entries.find(item=>item.projectRoot===other).lastOpened;
  await backend.main({action:"status"});assert.equal(profile_history(f.state).find(item=>item.projectRoot===other).lastOpened,lastOpened);
  fs.writeFileSync(path.join(other,".ai/project.yaml"),"invalid");assert.equal(profile_history(f.state).find(item=>item.projectRoot===other).status,"invalid");
  fs.rmSync(path.join(other,".ai/project.yaml"));assert.equal(profile_history(f.state).find(item=>item.projectRoot===other).status,"missing");
  fs.rmSync(other,{recursive:true});assert.equal(profile_history(f.state).find(item=>item.projectRoot===other).status,"unavailable");
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});

test("history selection previews another project without rebinding the chat or launching services", async t => {
  const f=fixture(t);f.save();const other=path.join(f.base,"other");fs.mkdirSync(path.join(other,"src"),{recursive:true});
  dump({...f.profile,project:{...f.profile.project,id:"other"}},path.join(other,".ai/project.yaml"));
  const sourceFile=path.join(other,".ai/project.yaml");fs.writeFileSync(sourceFile,"# history comment\n"+fs.readFileSync(sourceFile,"utf8"));
  const client=await session(t,"mcp/settings.mjs",[],f);
  const preview=(await client.call("settings.select_profile",{projectRoot:other})).structuredContent;
  assert.equal(preview.viewOnly,true);assert.equal(preview.profile.projectId,"other");
  assert.equal(preview.summary?.components.find(item=>item.id==="code-index")?.status,"not_checked");
  assert.equal(preview.chatProjectRoot,f.root);
  assert.equal((await client.call("settings.read",{})).structuredContent.values.projectRoot,f.root);
  const status=(await client.call("settings.status",{projectRoot:other})).structuredContent;
  assert.equal(status.viewOnly,true);assert.equal(status.values.projectRoot,other);
  assert.equal(status.summary.components.find(item=>item.id==="code-index").status,"not_checked");
  const document=await client.call("settings.document",{projectRoot:other});
  assert.equal(document.structuredContent,undefined);
  assert.equal(parse(document._meta.data.text).project.id,"other");
  assert.equal(document._meta.data.text,fs.readFileSync(sourceFile,"utf8"));assert.equal(document._meta.data.format,"yaml");
  assert.equal((await client.call("settings.read",{})).structuredContent.values.projectRoot,f.root);
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
  assert.equal(fs.existsSync(path.join(other,".ai/project.local.yaml")),false);
  const localFile=path.join(other,".ai/project.local.yaml"),localText="project:\n  purpose: local-only\n";
  fs.writeFileSync(localFile,localText);
  const localDocument=await client.call("settings.document",{projectRoot:other,layerScope:"project_local"});
  assert.equal(localDocument._meta.data.text,localText);
  assert.equal(localDocument._meta.data.layerScope,"project_local");
  assert.equal((await client.call("settings.read",{})).structuredContent.values.projectRoot,f.root);
  assert.equal(fs.readFileSync(localFile,"utf8"),localText);
  await assert.rejects(client.call("settings.update",{set:{projectRoot:other}}),/текущей сессией/);
});

test("removing history entries preserves project files and chat selection across sessions", async t => {
  const f=fixture(t);f.save();const other=path.join(f.base,"other");fs.mkdirSync(path.join(other,"src"),{recursive:true});
  dump({...f.profile,project:{...f.profile.project,id:"other"}},path.join(other,".ai/project.yaml"));
  const client=await session(t,"mcp/settings.mjs",[],f);
  const catalogue=(await client.request("tools/list",{})).tools;
  assert.deepEqual(catalogue.find(item=>item.name==="settings.forget_profile")._meta.ui.visibility,["app"]);
  await client.call("settings.select_profile",{projectRoot:other});
  const profileFile=path.join(other,".ai/project.yaml"), before=fs.readFileSync(profileFile,"utf8");
  const removed=(await client.call("settings.forget_profile",{projectRoot:other})).structuredContent;
  assert.equal(removed.profileHistory.some(item=>item.projectRoot===other),false);
  assert.equal(fs.readFileSync(profileFile,"utf8"),before);
  assert.equal((await client.call("settings.read",{})).structuredContent.values.projectRoot,f.root);
  const next=await session(t,"mcp/settings.mjs",[],f);
  assert.equal((await next.call("settings.read",{})).structuredContent.profileHistory.some(item=>item.projectRoot===other),false);
  await next.call("settings.select_profile",{projectRoot:other});
  assert.equal((await next.call("settings.read",{})).structuredContent.profileHistory.some(item=>item.projectRoot===other),true);
  await next.call("settings.forget_profile",{projectRoot:f.root});
  const current=(await next.call("settings.read",{})).structuredContent;
  assert.equal(current.profileHistoryHidden,true);assert.equal(current.values.projectRoot,f.root);
  assert.equal(fs.existsSync(path.join(f.root,".ai/project.yaml")),true);
  await assert.rejects(next.call("settings.forget_profile",{projectRoot:path.join(f.base,"unknown")}),/не найден/);
});

test("history counts EDT descriptors separately from repositories and refreshes old records", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  fs.writeFileSync(path.join(f.root, ".project"), "<projectDescription><name>Base</name></projectDescription>");
  fs.mkdirSync(path.join(f.root, "extension"));
  fs.writeFileSync(path.join(f.root, "extension/.project"), "<projectDescription><name>Extension</name></projectDescription>");
  const backend = new SettingsBackend();
  const view = await backend.main({ action: "read", remember: true });
  assert.equal(view.directoryContext.edt.projectCount, 2);
  let item = profile_history(f.state)[0];
  assert.equal(item.repositoryCount, 1); assert.equal(item.edtProjectCount, 2);
  const history = path.join(project_directory(f.state, f.root), "profile-history.json");
  const saved = JSON.parse(fs.readFileSync(history, "utf8"));
  assert.equal(saved.edtProjectCount, 2);
  delete saved.edtProjectCount; fs.writeFileSync(history, JSON.stringify(saved));
  assert.equal(profile_history(f.state)[0].edtProjectCount, 2);
  fs.rmSync(path.join(f.root, "extension/.project"));
  item = profile_history(f.state)[0];
  assert.equal(item.repositoryCount, 1); assert.equal(item.edtProjectCount, 1);
});

test("an unbound settings window selects a profile explicitly and remembers it without changing shared configuration", async t => {
  const f=fixture(t);f.save();
  const client=new McpClient([process.execPath,path.join(ROOT,"mcp/settings.mjs")],ROOT,{...f.env,EDT_AI_PROJECT_ROOT:""},10);
  f.clients.push(client);client.roots=[];await client.initialize();
  const selected=(await client.call("settings.select_profile",{projectRoot:f.root})).structuredContent;
  assert.equal(selected.viewOnly,false);assert.equal(selected.values.projectRoot,f.root);
  assert.equal(selected.summary?.components.find(item=>item.id==="code-index")?.status,"not_checked");
  assert.equal((await client.call("settings.read",{})).structuredContent.values.projectRoot,f.root);
  assert.equal(profile_history(f.state).length,1);
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS),false);
});

test("chat profile scope survives an independent app MCP connection and never overrides another locked chat", async t => {
  const f=fixture(t);f.save();
  const make=async()=>{const client=new McpClient([process.execPath,path.join(ROOT,"mcp/settings.mjs")],ROOT,{...f.env,EDT_AI_PROJECT_ROOT:""},10);f.clients.push(client);client.roots=[];await client.initialize();return client;};
  const chat=await make(),opened=(await chat.call("settings.profile",{projectRoot:f.root})).structuredContent;
  assert.equal(opened.values.projectRoot,f.root);assert.equal(opened.navigation,"project");
  const app=await make(),meta={"1c-ai-core/projectRoot":opened.values.projectRoot,"1c-ai-core/navigation":"project"};
  const read=(await app.request("tools/call",{name:"settings.read",arguments:{},_meta:meta})).structuredContent;
  assert.equal(read.profile.status,"loaded");assert.equal(read.values.projectRoot,f.root);assert.equal(read.schema.properties.projectRoot.readOnly,true);
  const other=path.join(f.base,"other");fs.mkdirSync(other);
  const denied=await app.request("tools/call",{name:"settings.read",arguments:{},_meta:{...meta,"1c-ai-core/projectRoot":other}});
  assert.equal(denied.isError,true);assert.equal((await app.call("settings.read",{})).structuredContent.values.projectRoot,f.root);
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS),false);assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});

test("a full settings app restores its scope across connections without locking its profile chooser", async t => {
  const f=fixture(t);f.save();const other=path.join(f.base,"other");fs.mkdirSync(other);
  const app=new McpClient([process.execPath,path.join(ROOT,"mcp/settings.mjs")],ROOT,{...f.env,EDT_AI_PROJECT_ROOT:""},10);f.clients.push(app);app.roots=[];await app.initialize();
  await app.request("tools/call",{name:"settings.read",arguments:{},_meta:{"1c-ai-core/projectRoot":f.root,"1c-ai-core/navigation":"profiles"}});
  const next=(await app.call("settings.select_profile",{projectRoot:other})).structuredContent;
  assert.equal(next.viewOnly,false);assert.equal(next.values.projectRoot,other);
});

test("reset removes the local URL and restores profile inheritance", async t => {
  const f=fixture(t);environment(t,f.env);
  f.profile.connections={edt:{url:"http://localhost:18191/mcp"},v8std:{url:"http://localhost:18192/mcp"}};f.save();
  const backend=new SettingsBackend(),before=fs.readFileSync(path.join(f.root,".ai/project.yaml"));
  await backend.main({action:"update",set:{edtUrl:"http://localhost:18193/mcp",v8stdUrl:"",bslLsEnabled:false}});
  assert.equal((await backend.main({action:"read"})).connectionSources.edt,"project_local");
  await backend.main({action:"reset_connection",connection:"edt"});
  const read=await backend.main({action:"read"});
  assert.equal(read.values.edtUrl,"http://localhost:18191/mcp");assert.equal(read.connectionSources.edt,"profile");
  assert.equal(read.values.v8stdUrl,"");assert.equal(read.values.bslLsEnabled,false);
  assert.deepEqual(fs.readFileSync(path.join(f.root,".ai/project.yaml")),before);
});

test("scoped updates remove overrides atomically and reject ambiguous or out-of-scope removals", async t => {
  const f=fixture(t);environment(t,f.env);
  f.profile.connections={edt:{url:"http://localhost:18191/mcp"}};f.save();
  const backend=new SettingsBackend(),localFile=path.join(f.root,".ai/project.local.yaml");
  await backend.main({action:"update",scope:"project_local",set:{edtUrl:"http://localhost:18192/mcp",bslLsEnabled:false}});
  const before=fs.readFileSync(localFile),current=await backend.main({action:"read"});
  for(const request of [
    {set:{},unset:["edtUrl"]},
    {scope:"project_local",set:{edtUrl:"http://localhost:18193/mcp"},unset:["edtUrl"]},
    {scope:"project_local",set:{},unset:["edtUrl","edtUrl"]},
    {scope:"project_local",set:{},unset:["projectRoot"]},
    {scope:"global",set:{},unset:["edtUrl"]},
    {scope:"project_local",set:{},unset:null},
    {scope:"project_local",set:null,unset:["edtUrl"]},
    {scope:"project_local",set:{},unset:["unknown"]},
    {scope:"project_local",set:{},unset:["edtUrl"],expectedRevision:"outdated"},
    {scope:"project_local",set:{}}
  ]){await assert.rejects(backend.main({action:"update",...request}));assert.deepEqual(fs.readFileSync(localFile),before);}
  await backend.main({action:"update",scope:"project_local",set:{bslLsEnabled:true},unset:["edtUrl"],expectedRevision:current.settingsRevision});
  const restored=await backend.main({action:"read"});
  assert.equal(restored.values.edtUrl,f.profile.connections.edt.url);assert.equal(restored.connectionSources.edt,"profile");
  assert.equal(load(localFile).connections?.edt?.url,undefined);assert.equal(restored.values.bslLsEnabled,true);
  await assert.rejects(backend.main({action:"update",scope:"project_local",set:{},unset:["bslLsEnabled"],expectedRevision:current.settingsRevision}),/изменились/);
});

test("malformed optional history metadata never blocks a valid profile", async t => {
  const f=fixture(t);environment(t,f.env);f.save();const backend=new SettingsBackend();
  await backend.main({action:"read",remember:true});
  const file=path.join(project_directory(f.state,f.root),"profile-history.json");
  for(const value of [null,{root:f.root,lastOpened:42,repositoryCount:-1},{root:f.root,lastOpened:"invalid"}]){
    fs.writeFileSync(file,JSON.stringify(value));const history=profile_history(f.state);
    assert.equal(history[0].status,"loaded");assert.equal(history[0].lastOpened,null);
    assert.equal(history[0].repositoryCount,1);
  }
});
