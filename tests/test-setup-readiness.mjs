import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { edt_fixture as fixture, environment, node_async, session, ROOT, protected_process_skip } from "./helpers.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { setup_assets, save_readiness, read_readiness, save_component_checks, read_component_checks, component_statuses, begin_foreground_readiness, activate_foreground_readiness, release_foreground_readiness, capture_readiness_priority, readiness_priority_current, foreground_readiness_active } from "../scripts/setup_readiness.mjs";
import { instance_directory, project_directory, sha256 } from "../scripts/project_paths.mjs";
import { grant_preparation } from "../scripts/components.mjs";
import { zip } from "../scripts/archives.mjs";
import { alive } from "../scripts/processes.mjs";
import { windows_handle_count } from "../scripts/windows_process.mjs";
import { index_config, installed_runtime, IndexObserver, active_readers, acquire_reader, restart_index } from "../scripts/runtime.mjs";
import { capture_index_snapshot } from "../scripts/index_snapshot.mjs";
import { dump } from "../scripts/common.mjs";
import { project_profile } from "../scripts/profile.mjs";
import { SettingsOperations } from "../mcp/settings-operations.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { open_reader, reader_active } from "../scripts/reader_lease.mjs";
import { read_diagnostic_logs } from "../scripts/diagnostics.mjs";

function testProtected(name, options, body) {
  if (typeof options === "function") return test(name, { skip: protected_process_skip }, options);
  return test(name, { ...options, skip: options.skip || protected_process_skip }, body);
}

async function with_clean_policy_environment(run) {
  const isPolicyInput = name => !["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID"].includes(name.toUpperCase()) &&
    /^(?:NODE_|OPENSSL_|SSL_CERT_|LD_|DYLD_|UV_)/i.test(name);
  const previous = Object.fromEntries(Object.entries(process.env).filter(([name]) => isPolicyInput(name)));
  for (const name of Object.keys(previous)) delete process.env[name];
  try { return await run(); }
  finally {
    for (const name of Object.keys(process.env)) if (isPolicyInput(name)) delete process.env[name];
    Object.assign(process.env, previous);
  }
}

async function ready_fixture(t) {
  const f=fixture(t);environment(t,f.env);f.save();let calls=0,wrongPath=false,noTools=false,indexChecks=0,settling=false,indexFailure=null,projectState="ready",delayV8=0,indexGate=null,indexStarted=null,edtObserved;const paths=[],requests=[];
  const edtDone=new Promise(resolve=>{edtObserved=resolve;});
  const server=createServer(async(req,res)=>{
    let text="";for await(const part of req)text+=part;
    if(!text){res.writeHead(202).end();return;}const message=JSON.parse(text);calls++;paths.push(req.url);requests.push({url:req.url,method:message.method});
    const reply=result=>res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:message.id,result}));
    if(req.url==="/index"&&message.method==="initialize"&&indexGate){const gate=indexGate;indexGate=null;indexStarted();await gate;}
    if (req.url === "/index" && indexFailure) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: indexFailure } }));
    if(message.method==="server/discover")return res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"legacy"}}));
    if(message.method==="initialize")return reply({protocolVersion:"2025-11-25",serverInfo:{name:"fixture",version:"1"},capabilities:{tools:{}}});
    if(message.method.startsWith("notifications/"))return res.writeHead(202).end();
    if(message.method==="tools/list"){
      if(req.url==="/v8std"&&delayV8)await new Promise(done=>setTimeout(done,delayV8));
      if(req.url==="/bsl")return reply({tools:[...(["register_workspace_folder","list_workspace_folders","unregister_workspace_folder"].map(name=>({name,inputSchema:{type:"object"}}))),{name:"analyze",inputSchema:{type:"object",properties:{workspaceFolder:{type:"string"}},required:["workspaceFolder"]}}]});
      if(req.url==="/index")return reply({tools:[{name:"health",inputSchema:{type:"object"}}]});
      if(req.url==="/v8-cross")return reply({tools:[{name:"standards_read",description:"search snippet context diagnostics",inputSchema:{type:"object",properties:{id:{type:"string"},query:{type:"string"},snippet:{type:"string"},context:{type:"string"},codes:{type:"array",items:{type:"string"}}},required:["id"]}}]});
      if(["/v8std","/v8-extra","/v8-limited"].includes(req.url)&&!noTools)return reply({tools:[{name:"standards_search",inputSchema:{type:"object",properties:{query:{type:"string",...(req.url==="/v8-limited"?{pattern:"^$"}:{})},...(req.url==="/v8-extra"?{unknown:{type:"string"}}:{})},required:req.url==="/v8-extra"?["query","unknown"]:["query"]}},{name:"standards_read",inputSchema:{type:"object",properties:{id:{type:"string"}},required:["id"]}},...[["standards_snippet","snippet","string"],["standards_context","context","string"],["standards_diagnostics","codes","array"]].map(([name,field,type])=>({name,inputSchema:{type:"object",properties:{[field]:{type,...(type==="array"?{items:{type:"string"}}:{})}},required:[field]}}))]});
      return reply({tools:noTools&&req.url==="/v8std"?[]:[{name:"list_projects",inputSchema:{type:"object",properties:{format:{enum:["json"]}}}}]});
    }
    if(message.method==="tools/call"&&req.url==="/index")return reply({structuredContent:{mcp:{status:"ok"},daemon:{status:"online"},repos:[{repo:"product",root_path:f.root,path_status:{status:"ready"},data_version:settling&&++indexChecks===1?{}:{stale:false}}]}});
    if(message.method==="tools/call"){reply({content:[{type:"text",text:JSON.stringify({projects:[{name:"Product",path:wrongPath?f.base:f.root,open:true,state:projectState,edtProject:true}]})}]});if(req.url==="/edt")edtObserved();return;}
    reply({});
  });server.listen(0,"127.0.0.1");await once(server,"listening");server.unref();t.after(()=>{server.closeAllConnections();return new Promise(done=>server.close(done));});
  const backend=new SettingsBackend(),url="http://127.0.0.1:"+server.address().port;
  await backend.main({action:"update",set:{codeIndexEnabled:false,bslLsEnabled:false,edtUrl:url+"/edt",v8stdUrl:url+"/v8std"}});
  return {f,backend,url,paths,requests,edtDone,authorization:{scope:f.root+"#first",effects:["launch"],evidence:"user requested setup check"},count:()=>calls,wrong:()=>{wrongPath=true;},noTools:()=>{noTools=true;},settle:()=>{settling=true;},indexChecks:()=>indexChecks,failIndex:message=>{indexFailure=message;},setProjectState:state=>{projectState=state;},delayV8:ms=>{delayV8=ms;},holdIndex:()=>{let release;indexGate=new Promise(done=>{release=done;});const started=new Promise(done=>{indexStarted=done;});return {started,release};}};
}

async function enable_external_index(f, backend, url) {
  const config=backend.current();Object.assign(config.mcp.managed["code-index"],{enabled:true,mode:"external",url:url+"/index"});
  fs.writeFileSync(f.env.EDT_AI_SETTINGS,JSON.stringify(config));
  await backend.main({action:"update",set:{codeIndexEnabled:true}});
  fs.mkdirSync(path.join(f.root,".code-index"),{recursive:true});fs.writeFileSync(path.join(f.root,".code-index/index.db"),"existing");
}

test("two MCP sessions share a matching in-flight component observation", async t => {
  const { f, backend, url, holdIndex, requests } = await ready_fixture(t);
  await enable_external_index(f, backend, url);
  const first = await session(t, "mcp/settings.mjs", [], f), second = await session(t, "mcp/settings.mjs", [], f);
  const gate = holdIndex();
  t.after(() => gate.release());
  const full = (await first.call("settings.refresh_readiness", { scope: f.root + "#first" })).structuredContent;
  await gate.started;
  const addressed = (await second.call("settings.refresh_readiness", { scope: f.root + "#first", component: "code-index" })).structuredContent;
  // Allow the second backend to attach while the first server response is held.
  await new Promise(done => setTimeout(done, 800));
  assert.equal(requests.filter(item => item.url === "/index" && item.method === "initialize").length, 1);
  gate.release();
  const [fullDone, addressedDone] = await Promise.all([first, second].map((client, index) =>
    client.call("settings.operation", { operationId: index ? addressed.id : full.id, waitMs: 10000 })));
  assert.equal(fullDone.structuredContent.status, "completed", JSON.stringify(fullDone.structuredContent));
  assert.equal(addressedDone.structuredContent.status, "completed", JSON.stringify(addressedDone.structuredContent));
  assert.equal(addressedDone.structuredContent.result.superseded, false);
  assert.equal(addressedDone.structuredContent.result.componentChecks[0].state, "ready");
  assert.equal(requests.filter(item => item.url === "/index" && item.method === "initialize").length, 1);
});

test("MCP sessions with different instances never share a component flight", async t => {
  const { f, backend, url, holdIndex, requests } = await ready_fixture(t); await enable_external_index(f, backend, url);
  const first = await session(t, "mcp/settings.mjs", [], f), second = await session(t, "mcp/settings.mjs", [], f, { EDT_AI_INSTANCE: "second" });
  const gate = holdIndex(); t.after(() => gate.release());
  const a = (await first.call("settings.refresh_readiness", { scope: f.root + "#first", component: "code-index" })).structuredContent;
  await gate.started;
  const b = (await second.call("settings.refresh_readiness", { scope: f.root + "#second", component: "code-index" })).structuredContent;
  const doneB = (await second.call("settings.operation", { operationId: b.id, waitMs: 10000 })).structuredContent;
  assert.equal(doneB.status, "completed", JSON.stringify(doneB)); assert.equal(doneB.result.componentChecks[0].state, "ready");
  assert.equal(requests.filter(item => item.url === "/index" && item.method === "initialize").length, 2);
  gate.release();
  assert.equal((await first.call("settings.operation", { operationId: a.id, waitMs: 10000 })).structuredContent.status, "completed");
});

test("joined full refresh preserves external results without repeating the probes", async t => {
  const { f, backend, url, holdIndex, requests } = await ready_fixture(t);
  await enable_external_index(f, backend, url);
  const first = await session(t, "mcp/settings.mjs", [], f), second = await session(t, "mcp/settings.mjs", [], f);
  const gate = holdIndex(); t.after(() => gate.release());
  const full = (await first.call("settings.refresh_readiness", { scope: f.root + "#first" })).structuredContent;
  await gate.started;
  const joined = (await second.call("settings.refresh_readiness", { scope: f.root + "#first" })).structuredContent;
  await new Promise(done => setTimeout(done, 800)); gate.release();
  const [a, b] = await Promise.all([first, second].map((client, index) => client.call("settings.operation", { operationId: index ? joined.id : full.id, waitMs: 10000 })));
  assert.equal(a.structuredContent.status, "completed", JSON.stringify(a.structuredContent)); assert.equal(b.structuredContent.status, "completed", JSON.stringify(b.structuredContent));
  assert.equal(b.structuredContent.result.superseded, false);
  assert.deepEqual(b.structuredContent.result.external, a.structuredContent.result.external);
  for (const url of ["/index", "/edt", "/v8std"]) assert.equal(requests.filter(item => item.url === url && item.method === "initialize").length, 1, url);
});

for (const captureBeforeFlight of [false, true]) {
  test(`a delayed MCP backend joins a flight ${captureBeforeFlight ? "published after" : "running during"} request capture`, { timeout: 30000 }, async t => {
    const { f, backend, url, holdIndex, requests } = await ready_fixture(t);
    await enable_external_index(f, backend, url);
    const gate = holdIndex(); t.after(() => gate.release());
    let startFirst, startSecond;
    const delayFirst = new Promise(resolve => { startFirst = resolve; }), delaySecond = new Promise(resolve => { startSecond = resolve; });
    t.after(() => { startFirst(); startSecond(); });
    const context = { projectRoot: f.root, instance: "first" }, args = { scope: f.root + "#first", component: "code-index" };
    const run = (action, input) => backend.main({ action, ...input });
    const first = new SettingsOperations(async (action, input) => { await delayFirst; return run(action, input); }, () => {}, { stateDirectory: f.state });
    const second = new SettingsOperations(async (action, input) => { await delaySecond; return run(action, input); }, () => {}, { stateDirectory: f.state });
    const a = first.start("refresh_readiness", args, context);
    if (!captureBeforeFlight) { startFirst(); await gate.started; }
    const b = second.start("refresh_readiness", args, context);
    if (captureBeforeFlight) { startFirst(); await gate.started; }
    gate.release(); await a.finished;
    assert.equal(a.status, "completed", JSON.stringify(a));
    startSecond(); await b.finished;
    assert.equal(b.status, "completed", JSON.stringify(b));
    assert.equal(b.result.componentChecks[0].state, "ready");
    assert.equal(requests.filter(item => item.url === "/index" && item.method === "initialize").length, 1);
    const c = second.start("refresh_readiness", args, context); await c.finished;
    assert.equal(c.status, "completed", JSON.stringify(c));
    assert.equal(requests.filter(item => item.url === "/index" && item.method === "initialize").length, 2,
      "a manual request accepted after completion must perform a fresh check");
  });
}

test("offset periodic refreshes reuse a recent verified receipt from another MCP session", async t => {
  const { f, requests } = await ready_fixture(t);
  const first = await session(t, "mcp/settings.mjs", [], f), second = await session(t, "mcp/settings.mjs", [], f);
  const refresh = async (client, automatic = false) => {
    const job = (await client.call("settings.refresh_readiness", { scope: f.root + "#first", ...(automatic ? { automatic } : {}) })).structuredContent;
    return (await client.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  };
  assert.equal((await refresh(first)).status, "completed");
  const count = requests.length, shared = await refresh(second, true);
  assert.equal(shared.status, "completed"); assert.equal(shared.result.superseded, false);
  assert.equal(requests.length, count, "periodic refresh should use the other session's current verified observation");
  await refresh(second);
  assert.ok(requests.length > count, "manual refresh always performs a new observation");
});

test("a joined index check automatically recovers from a crashed flight owner", async t => {
  const { f, backend, url, holdIndex, requests } = await ready_fixture(t);
  await enable_external_index(f, backend, url);
  const gate = holdIndex(), leader = childProcess.spawn(process.execPath, [path.resolve("scripts/settings_backend.mjs")], { env: f.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(() => { gate.release(); if (leader.exitCode === null && leader.signalCode === null) leader.kill(); });
  leader.stdin.end(JSON.stringify({ action: "refresh_readiness", scope: f.root + "#first", component: "code-index" }));
  await gate.started;
  const joined = ["code-index", "code-index", undefined].map(component =>
    backend.main({ action: "refresh_readiness", scope: f.root + "#first", ...(component ? { component } : {}) }));
  await new Promise(done => setTimeout(done, 500));
  const recoveryGate = holdIndex(); t.after(() => recoveryGate.release());
  leader.kill("SIGKILL"); await once(leader, "close");
  await recoveryGate.started;
  await new Promise(done => setTimeout(done, 500));
  recoveryGate.release();
  for (const recovered of await Promise.all(joined)) {
    assert.equal(recovered.superseded, false, JSON.stringify(recovered));
    assert.equal(recovered.componentChecks.find(item => item.id === "code-index").state, "ready");
  }
  gate.release();
  assert.equal(requests.filter(item => item.url === "/index" && item.method === "initialize").length, 2);
});

test("a component observation with changed inputs does not join the older flight", async t => {
  const { f, backend, url, holdIndex, requests } = await ready_fixture(t);
  await enable_external_index(f, backend, url);
  const gate = holdIndex(), previous = backend.main({ action: "refresh_readiness", scope: f.root + "#first", component: "code-index" });
  t.after(() => gate.release());
  await gate.started;
  const config = backend.current(); config.mcp.managed["code-index"].url += "?changed=1";
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(config));
  const changed = await backend.main({ action: "refresh_readiness", scope: f.root + "#first", component: "code-index" });
  gate.release();
  assert.equal(changed.superseded, false);
  assert.equal((await previous).superseded, true);
  assert.ok(requests.some(item => item.url === "/index?changed=1"));
});

test("a collected probe uses the binding captured before an ABA settings change", async t => {
  const { f, backend, url, requests } = await ready_fixture(t), invoke = backend.main.bind(backend);
  const effective = backend.effective.bind(backend); let changed = false;
  backend.effective = (...args) => { const config = effective(...args); if (changed) config.mcp.required.v8std.url = url + "/v8-limited"; return config; };
  backend.main = async (request, progress, context) => {
    if (request.action !== "probe" || request.component !== "v8std") return invoke(request, progress, context);
    changed = true;
    try { return await invoke(request, progress, context); }
    finally { changed = false; }
  };
  const result = await backend.main({ action: "refresh_readiness", scope: f.root + "#first", component: "v8std" });
  assert.equal(result.superseded, false); assert.equal(result.componentChecks[0].state, "ready");
  assert.ok(requests.some(item => item.url === "/v8std"));
  assert.ok(!requests.some(item => item.url === "/v8-limited"));
});

test("a damaged shared flight record never permits a duplicate probe", async t => {
  const { f, backend, count } = await ready_fixture(t);
  const directory = instance_directory(f.state, f.root); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "first.readiness-flights.json"), "{broken");
  const before = count();
  await assert.rejects(backend.main({ action: "refresh_readiness", scope: f.root + "#first" }), /координацию проверок/);
  assert.equal(count(), before);
});

function write_test_bsl_artifact(f) {
  const bytes = zip({ "META-INF/MANIFEST.MF": Buffer.from("fixture") }), hash = sha256(bytes);
  const file = path.join(f.state, "runtime", "bsl-ls", "fixture", hash, "bsl-language-server-exec.jar");
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  fs.writeFileSync(path.join(f.state, "runtime-lock.json"), JSON.stringify({ "bsl-ls": { release: "fixture", sha256: hash, path: path.relative(f.state, file) } }));
  return file;
}

test("a joined local BSL observation shares an unchanged durable receipt", async t => {
  const { f, backend, url, holdIndex } = await ready_fixture(t); await enable_external_index(f, backend, url);
  await backend.main({ action: "update", set: { bslLsEnabled: true, bslLsJava: process.execPath } });
  write_test_bsl_artifact(f);
  const config = backend.effective(backend.current()), saved = save_component_checks(f.state, config, f.profile, [{ id: "bsl-ls", state: "ready", apiEvidenceVersion: 1 }])[0];
  const gate = holdIndex(); t.after(() => gate.release());
  const first = backend.main({ action: "refresh_readiness", scope: f.root + "#first" }); await gate.started;
  const second = backend.main({ action: "refresh_readiness", scope: f.root + "#first", component: "bsl-ls" });
  await new Promise(done => setTimeout(done, 300)); gate.release();
  const [, joined] = await Promise.all([first, second]);
  assert.equal(joined.superseded, false); assert.equal(joined.componentChecks[0].state, "ready");
  assert.equal(joined.componentChecks[0].apiCompatible, true);
  assert.equal(joined.componentChecks[0].checkedAt, saved.checkedAt);
});

test("component evidence expires only when that component's inputs change", async t => {
  const {f,backend}=await ready_fixture(t), config=backend.effective(backend.current()), profile=project_profile(f.root);
  profile.testing.yaxunit=true;profile.testing.yaxunit_config={repository_id:"product",runner:"edt",results:"results"};
  profile.testing.vanessa=true;profile.testing.vanessa_config={repository_id:"product",runtime_profile:"vanessa.json",server_name:"vanessa",features:"features",results:"ui-results"};
  const ids=["edt","v8std","code-index","yaxunit","vanessa"];
  save_component_checks(f.state,config,profile,ids.map(id=>({id,state:"ready"})));
  const states=(settings=config,data=profile)=>Object.fromEntries(read_component_checks(f.state,settings,data).map(item=>[item.id,item.state]));
  const changedBsl=structuredClone(config);changedBsl.mcp.managed["bsl-ls"].java="another-java";
  assert.deepEqual(states(changedBsl),Object.fromEntries(ids.map(id=>[id,"ready"])));
  fs.writeFileSync(path.join(f.root,"AGENTS.md"),"Unrelated project instructions\n");
  assert.deepEqual(states(),Object.fromEntries(ids.map(id=>[id,"ready"])));
  const unrelatedTestPaths=structuredClone(profile);unrelatedTestPaths.testing.yaxunit_config.results="other-results";unrelatedTestPaths.testing.vanessa_config.features="other-features";
  assert.deepEqual(states(config,unrelatedTestPaths),Object.fromEntries(ids.map(id=>[id,"ready"])));
  const changedV8=structuredClone(config);changedV8.mcp.required.v8std.url+="/other";
  assert.deepEqual(states(changedV8),{edt:"ready",v8std:"check_stale","code-index":"ready",yaxunit:"ready",vanessa:"ready"});
  const changedTest=structuredClone(profile);changedTest.testing.yaxunit_config.launch_configuration="other";
  assert.deepEqual(states(config,changedTest),{edt:"ready",v8std:"ready","code-index":"ready",yaxunit:"check_stale",vanessa:"ready"});
  const changedEdt=structuredClone(config);changedEdt.mcp.required.edt.url+="/other";
  assert.deepEqual(states(changedEdt),{edt:"check_stale",v8std:"ready","code-index":"ready",yaxunit:"check_stale",vanessa:"ready"});
});

test("a concurrent change rejects only affected component observations", async t => {
  const { f, backend, url, holdIndex } = await ready_fixture(t);
  await enable_external_index(f, backend, url);
  const gate = holdIndex(), pending = backend.main({ action: "refresh_readiness", scope: f.root + "#first" });
  await gate.started;
  await backend.main({ action: "update", set: { v8stdUrl: url + "/different" } });
  gate.release();
  const result = await pending;
  assert.equal(result.superseded, false);
  assert.deepEqual(result.supersededComponents, ["v8std"]);
  assert.equal(result.componentChecks.find(item => item.id === "code-index").state, "ready");
  assert.equal(result.componentChecks.find(item => item.id === "edt").state, "ready");
  assert.ok(!result.componentChecks.some(item => item.id === "v8std"));
  assert.equal(result.external.v8std, undefined);
  const current = await backend.main({ action: "read" });
  assert.equal(current.componentStatuses.find(item => item.id === "code-index").state, "ready");
  assert.equal(current.componentStatuses.find(item => item.id === "edt").state, "ready");
});

test("a concurrent OpenViking failure invalidates setup without discarding independent components", async t => {
  const { f, backend, url, holdIndex } = await ready_fixture(t);
  await enable_external_index(f, backend, url);
  const config = backend.effective(backend.current()), profile = project_profile(f.root);
  save_component_checks(f.state, config, profile, [{ id: "openviking", state: "ready" }]);
  const file = path.join(instance_directory(f.state, f.root), "first.readiness.json"), receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  receipt.result = { knowledge: { ready: true } }; fs.writeFileSync(file, JSON.stringify(receipt));
  const gate = holdIndex(), pending = backend.main({ action: "refresh_readiness", scope: f.root + "#first" });
  await gate.started;
  save_component_checks(f.state, config, profile, [{ id: "openviking", state: "error", detail: "Публикация недоступна." }]);
  gate.release(); const result = await pending;
  assert.equal(result.superseded, false); assert.ok(result.supersededComponents.includes("openviking"));
  assert.equal(result.componentChecks.find(item => item.id === "edt").state, "ready");
  assert.equal(result.componentChecks.find(item => item.id === "code-index").state, "ready");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).knowledgeInvalidated, true);
});

test("an unreadable project inventory does not suppress independent v8std or Vanessa observations", async t => {
  const { f, backend } = await ready_fixture(t), readDir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (directory, ...args) => {
    if (typeof directory === "string" && path.resolve(directory) === path.resolve(f.root))
      throw Object.assign(new Error("fixture project directory unavailable"), { code: "EACCES" });
    return readDir(directory, ...args);
  });
  const result = await backend.main({ action: "refresh_readiness", scope: f.root + "#first" });
  assert.equal(result.componentChecks.find(item => item.id === "v8std").state, "ready");
  assert.equal(result.componentChecks.find(item => item.id === "vanessa").state, "disabled");
  assert.notEqual(result.componentChecks.find(item => item.id === "edt").state, "ready");
  const current = await backend.main({ action: "read" });
  assert.equal(current.componentStatuses.find(item => item.id === "v8std").state, "ready");
});

test("seven server statuses survive a new backend process without inheriting stale setup", async t => {
  const { f, backend } = await ready_fixture(t), config = backend.effective(backend.current()), profile = project_profile(f.root);
  const ids = ["edt", "v8std", "openviking", "code-index", "bsl-ls", "yaxunit", "vanessa"];
  save_component_checks(f.state, config, profile, ids.map(id => ({ id, state: "error", detail: "fixture: " + id })));
  const result = await node_async("scripts/settings_backend.mjs", [], { env: f.env, input: JSON.stringify({ action: "read" }) });
  assert.equal(result.status, 0, result.stderr);
  const current = JSON.parse(result.stdout).result;
  assert.deepEqual(current.componentStatuses.map(item => item.id), ids);
  assert.equal(current.componentStatuses.find(item => item.id === "edt").detail, "fixture: edt");
  assert.equal(current.componentStatuses.find(item => item.id === "v8std").detail, "fixture: v8std");
  assert.equal(current.componentStatuses.find(item => item.id === "vanessa").state, "disabled");
});

test("legacy unknown observations gain a cause without inventing a reliable observation time", async t => {
  const { f, backend } = await ready_fixture(t), config = backend.effective(backend.current());
  const checkedAt = new Date(Date.now() - 1000).toISOString();
  save_component_checks(f.state, config, f.profile, [{ id: "v8std", state: "not_checked", checkedAt }]);
  let status = (await backend.main({ action: "read" })).componentStatuses.find(item => item.id === "v8std");
  assert.equal(status.state, "not_verified"); assert.match(status.detail, /без данных/); assert.equal(status.lastCheckedAt, undefined);
  await backend.main({ action: "update", set: { v8stdUrl: "" } });
  status = (await backend.main({ action: "read" })).componentStatuses.find(item => item.id === "v8std");
  assert.equal(status.state, "missing_config"); assert.equal(status.lastCheckedAt, undefined);
});

test("a failed observation preserves the time of a previous reliable result", async t => {
  const { f, backend } = await ready_fixture(t), config = backend.effective(backend.current());
  const checkedAt = new Date(Date.now() - 2000).toISOString();
  save_component_checks(f.state, config, f.profile, [{ id: "v8std", state: "ready", checkedAt }]);
  save_component_checks(f.state, config, f.profile, [{ id: "v8std", state: "error", detail: "Сервер не отвечает." }]);
  let status = (await backend.main({ action: "read" })).componentStatuses.find(item => item.id === "v8std");
  assert.equal(status.state, "error"); assert.equal(status.lastCheckedAt, checkedAt);
  await backend.main({ action: "update", set: { v8stdUrl: "" } });
  status = (await backend.main({ action: "read" })).componentStatuses.find(item => item.id === "v8std");
  assert.equal(status.state, "missing_config"); assert.equal(status.lastCheckedAt, checkedAt);
});

test("passive BSL status and repeated refreshes do not hash runtime binaries or start Java", async t => {
  const { f, backend } = await ready_fixture(t);
  await backend.main({ action: "update", set: { bslLsEnabled: true, bslLsJava: process.execPath } });
  const jar = write_test_bsl_artifact(f), config = backend.effective(backend.current());
  save_component_checks(f.state, config, f.profile, [{ id: "bsl-ls", state: "ready", apiEvidenceVersion: 1 }]);
  const open = fs.openSync, binaryReads = [];
  t.mock.method(fs, "openSync", (file, ...args) => {
    if (typeof file === "string" && [jar, process.execPath].some(value => path.resolve(file) === path.resolve(value))) binaryReads.push(file);
    return open(file, ...args);
  });
  const execute = t.mock.method(childProcess, "execFile", () => { throw new Error("Unexpected Java process"); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (let i = 0; i < 2; i++) {
    await backend.main({ action: "status" });
    const result = await backend.main({ action: "refresh_readiness", scope: f.root + "#first", component: "bsl-ls" });
    assert.equal(result.componentChecks[0].state, "ready");
    assert.equal(result.componentChecks[0].apiCompatible, true);
  }
  const failed = save_component_checks(f.state, config, f.profile, [{ id: "bsl-ls", state: "error", detail: "API BSL LS не поддерживает рабочие области." }])[0];
  const refresh = await backend.main({ action: "refresh_readiness", scope: f.root + "#first", component: "bsl-ls" });
  assert.equal(refresh.componentChecks[0].state, "error");
  assert.equal(refresh.componentChecks[0].checkedAt, failed.checkedAt);
  assert.equal(refresh.componentChecks[0].detail, failed.detail);
  assert.equal((await backend.main({ action: "read" })).componentStatuses.find(item => item.id === "bsl-ls").detail, failed.detail);
  assert.deepEqual(binaryReads, []); assert.equal(execute.mock.callCount(), 0);
});

test("v8std must advertise compatible search and read capabilities", async t => {
  const { f, backend, url } = await ready_fixture(t);
  await backend.main({ action: "update", set: { v8stdUrl: url + "/wrong-contract" } });
  const result = await backend.main({ action: "refresh_readiness", scope: f.root + "#first", component: "v8std" });
  assert.equal(result.componentChecks[0].state, "not_verified");
  assert.match(result.componentChecks[0].detail, /инструменты поиска, чтения/);
});

test("an unsupported Code Index architecture reports the platform reason", async t => {
  const { f, backend } = await ready_fixture(t);
  await backend.main({ action: "update", set: { codeIndexEnabled: true } });
  const original = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "arch", { ...original, value: "unsupported-test" });
  t.after(() => Object.defineProperty(process, "arch", original));
  const result = await backend.main({ action: "refresh_readiness", scope: f.root + "#first", component: "code-index" });
  assert.equal(result.componentChecks[0].state, "error");
  assert.match(result.componentChecks[0].detail, /Неподдерживаемая платформа code-index/);
});

for (const [route, expected] of [["/v8-cross", /поиска/], ["/v8-extra", /поиска/], ["/v8-limited", /поиска/]]) test(`v8std ignores unrelated descriptions and unsupported schemas: ${route}`, async t => {
  const { f, backend, url } = await ready_fixture(t);
  await backend.main({ action: "update", set: { v8stdUrl: url + route } });
  const result = await backend.main({ action: "refresh_readiness", scope: f.root + "#first", component: "v8std" });
  assert.equal(result.componentChecks[0].state, "not_verified"); assert.match(result.componentChecks[0].detail, expected);
});

test("remote credential changes invalidate only the observations that used them", async t => {
  const {f,backend}=await ready_fixture(t),config=backend.effective(backend.current()),profile=project_profile(f.root);
  config.mcp.required.edt.headers_env={Authorization:"EDT_REVIEW_TEST_TOKEN"};process.env.EDT_REVIEW_TEST_TOKEN="fixture-edt-token-before-rotation";
  t.after(()=>{delete process.env.EDT_REVIEW_TEST_TOKEN;});
  save_component_checks(f.state,config,profile,[{id:"edt",state:"ready"},{id:"v8std",state:"ready"},{id:"yaxunit",state:"ready"}]);
  process.env.EDT_REVIEW_TEST_TOKEN="fixture-edt-token-after-rotation";
  assert.deepEqual(Object.fromEntries(read_component_checks(f.state,config,profile).map(item=>[item.id,item.state])),
    {edt:"check_stale",v8std:"ready",yaxunit:"check_stale"});
  const receipt=fs.readFileSync(path.join(instance_directory(f.state,f.root),"first.readiness.json"),"utf8");
  assert.doesNotMatch(receipt,/fixture-edt-token-(?:before|after)-rotation/);
});

test("a foreground check invalidates an older background job before delayed backend dispatch", async t => {
  const {f,backend,authorization,count}=await ready_fixture(t);let release;
  const gate=new Promise(done=>{release=done;});
  const operations=new SettingsOperations(async(action,args)=>{if(action==="refresh_readiness")await gate;return backend.main({action,...args});},()=>{},{stateDirectory:f.state});
  const background=operations.start("refresh_readiness",{scope:f.root+"#first"},{});
  const foreground=operations.start("check",{authorization},{});await foreground.finished;
  assert.equal(foreground.status,"completed");assert.equal(foreground.result.superseded,undefined);
  const before=fs.readFileSync(path.join(instance_directory(f.state,f.root),"first.readiness.json"),"utf8");
  const probes=count();
  release();await background.finished;assert.equal(background.result.superseded,true);
  assert.equal(count(),probes,"cancelled background must not start new probes");
  assert.equal(fs.readFileSync(path.join(instance_directory(f.state,f.root),"first.readiness.json"),"utf8"),before);
  assert.equal(fs.existsSync(path.join(f.state,".settings-refresh-cancel",background.id)),false);
});

test("a foreground check in another MCP session takes priority over an older background dispatch", async t => {
  const {f,backend,authorization}=await ready_fixture(t),context={projectRoot:f.root,instance:"first"};let release;
  const gate=new Promise(done=>{release=done;});
  const first=new SettingsOperations(async(action,args)=>{await gate;return backend.main({action,...args});},()=>{},{stateDirectory:f.state});
  const second=new SettingsOperations((action,args)=>backend.main({action,...args}),()=>{},{stateDirectory:f.state});
  const background=first.start("refresh_readiness",{scope:f.root+"#first"},context);
  const foreground=second.start("check",{authorization},context);await foreground.finished;
  assert.equal(foreground.status,"completed");assert.notEqual(foreground.result.superseded,true);
  release();await background.finished;assert.equal(background.status,"completed");assert.equal(background.result.superseded,true);
});

test("an addressed foreground probe supersedes only its own component in an active refresh", async t => {
  const { f, backend, url, holdIndex } = await ready_fixture(t); await enable_external_index(f, backend, url);
  const context = { projectRoot: f.root, instance: "first" }, gate = holdIndex(); t.after(() => gate.release());
  const first = new SettingsOperations((action, args) => backend.main({ action, ...args }), () => {}, { stateDirectory: f.state });
  const second = new SettingsOperations((action, args) => backend.main({ action, ...args }), () => {}, { stateDirectory: f.state });
  const background = first.start("refresh_readiness", { scope: f.root + "#first" }, context); await gate.started;
  const foreground = second.start("probe", { component: "v8std" }, context); await foreground.finished;
  assert.equal(foreground.status, "completed"); assert.notEqual(foreground.result.superseded, true);
  gate.release(); await background.finished;
  assert.equal(background.status, "completed"); assert.equal(background.result.superseded, false);
  assert.deepEqual(background.result.supersededComponents, ["v8std"]);
  assert.equal(background.result.componentChecks.find(item => item.id === "edt").state, "ready");
  assert.equal(background.result.componentChecks.find(item => item.id === "code-index").state, "ready");
  assert.equal(background.result.external.v8std, undefined);
});

test("a later session joins unaffected flights after an addressed foreground probe", async t => {
  const { f, backend, url, holdIndex, requests } = await ready_fixture(t); await enable_external_index(f, backend, url);
  const context = { projectRoot: f.root, instance: "first" }, gate = holdIndex(); t.after(() => gate.release());
  const first = new SettingsOperations((action, args) => backend.main({ action, ...args }), () => {}, { stateDirectory: f.state });
  const second = new SettingsOperations((action, args) => backend.main({ action, ...args }), () => {}, { stateDirectory: f.state });
  const background = first.start("refresh_readiness", { scope: f.root + "#first" }, context); await gate.started;
  const foreground = second.start("probe", { component: "v8std" }, context); await foreground.finished;
  assert.equal(foreground.status, "completed");
  const joined = second.start("refresh_readiness", { scope: f.root + "#first" }, context);
  await new Promise(done => setTimeout(done, 300));
  assert.equal(requests.filter(item => item.url === "/index" && item.method === "initialize").length, 1);
  gate.release(); await Promise.all([background.finished, joined.finished]);
  assert.equal(background.status, "completed"); assert.equal(joined.status, "completed");
  assert.equal(requests.filter(item => item.url === "/index" && item.method === "initialize").length, 1);
});

test("a different MCP session observes transiently while full preparation is running", async t => {
  const {f,backend,authorization,count}=await ready_fixture(t),context={projectRoot:f.root,instance:"first"};let release;
  const gate=new Promise(done=>{release=done;});
  const first=new SettingsOperations(async(action,args)=>{await gate;return backend.main({action,...args});},()=>{},{stateDirectory:f.state});
  const second=new SettingsOperations((action,args)=>backend.main({action,...args}),()=>{},{stateDirectory:f.state});
  const foreground=first.start("check",{authorization},context),background=second.start("refresh_readiness",{scope:f.root+"#first"},context);
  const before=count();await background.finished;assert.equal(background.status,"completed");assert.equal(background.result.componentChecks.length,0,JSON.stringify(background.result));assert.equal(background.result.transient,true);assert.equal(count(),before);
  assert.equal(fs.existsSync(path.join(instance_directory(f.state,f.root),"first.readiness.json")),false);
  release();await foreground.finished;assert.equal(foreground.status,"completed");assert.notEqual(foreground.result.superseded,true);
});

test("readiness priority stays isolated by project and instance", async t => {
  const {f}=await ready_fixture(t),other=path.join(f.base,"other-priority");fs.mkdirSync(other);
  const first=capture_readiness_priority(f.state,f.root,"first"),otherProject=capture_readiness_priority(f.state,other,"first"),otherInstance=capture_readiness_priority(f.state,f.root,"second");
  const id=randomUUID(),marker=begin_foreground_readiness(f.state,f.root,"first",id);
  const owner=await activate_foreground_readiness(f.state,f.root,"first",marker,id);
  assert.equal(readiness_priority_current(f.state,f.root,"first",first),false);
  assert.equal(await foreground_readiness_active(f.state,f.root,"first"),true);
  assert.equal(readiness_priority_current(f.state,other,"first",otherProject),true);
  assert.equal(readiness_priority_current(f.state,f.root,"second",otherInstance),true);
  assert.equal(await foreground_readiness_active(f.state,other,"first"),false);
  assert.equal(await foreground_readiness_active(f.state,f.root,"second"),false);
  await owner.close();release_foreground_readiness(f.state,marker);assert.equal(await foreground_readiness_active(f.state,f.root,"first"),false);
});

test("simultaneous foreground checks share an atomic project reservation", { timeout: 12000 }, async t => {
  const f = fixture(t); f.save();
  let release, entered, started = 0;
  const gate = new Promise(resolve => { release = resolve; }), running = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const run = async () => { started++; entered(); await gate; return { componentChecks: [] }; };
  const first = new SettingsOperations(run, () => {}, { stateDirectory: f.state });
  const second = new SettingsOperations(run, () => {}, { stateDirectory: f.state });
  const scope = { projectRoot: f.root, instance: "first" };
  const jobs = [first.start("probe", { component: "v8std" }, scope), second.start("probe", { component: "v8std" }, scope)];
  await running;
  await Promise.race(jobs.map(job => job.finished));
  assert.equal(started, 1);
  const rejected = jobs.find(job => job.status !== "running");
  assert.equal(rejected.status, "failed"); assert.match(rejected.error, /уже выполнял|уже выполняется|не подтверждено/);
  release(); await Promise.all(jobs.map(job => job.finished));
  assert.deepEqual(jobs.map(job => job.status).sort(), ["completed", "failed"]);
  assert.equal(await foreground_readiness_active(f.state, f.root, "first"), false);
});

test("queued foreground requests do not repeat a check after its leader finishes", { timeout: 15000 }, async t => {
  const f = fixture(t); f.save(); const scope = { projectRoot: f.root, instance: "first" };
  for (let round = 0; round < 5; round++) {
    let runs = 0;
    const run = async () => { runs++; await new Promise(resolve => setTimeout(resolve, 25)); return { componentChecks: [] }; };
    const owners = Array.from({ length: 4 }, () => new SettingsOperations(run, () => {}, { stateDirectory: f.state }));
    const jobs = owners.map(owner => owner.start("probe", { component: "v8std" }, scope));
    await Promise.all(jobs.map(job => job.finished));
    assert.equal(runs, 1, `round ${round}: only one backend should run`);
    assert.equal(jobs.filter(job => job.status === "completed").length, 1);
    assert.equal(jobs.filter(job => job.status === "failed").length, 3);
  }
});

test("a replaced foreground marker is not overwritten during activation", async t => {
  const f = fixture(t), id = randomUUID(), marker = begin_foreground_readiness(f.state, f.root, "first", id);
  const replacement = JSON.stringify({ pid: process.pid, id: randomUUID(), phase: "starting" }); fs.writeFileSync(marker, replacement);
  await assert.rejects(activate_foreground_readiness(f.state, f.root, "first", marker, id), error => error.outcomeUnknown === true && error.markerChanged === true);
  assert.equal(fs.readFileSync(marker, "utf8"), replacement);
  assert.equal(await reader_active(id), false);
});

test("a failed listener start never overwrites a replaced foreground marker", { timeout: 4000 }, async t => {
  const f = fixture(t), id = randomUUID(), marker = begin_foreground_readiness(f.state, f.root, "first", id);
  const replacement = JSON.stringify({ pid: process.pid, id: randomUUID(), phase: "starting" });
  const listen = net.Server.prototype.listen, timer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => timer(callback, ms === 5000 ? 100 : ms, ...args));
  t.mock.method(net.Server.prototype, "listen", function (address, callback) {
    if (String(address).includes(id)) { fs.writeFileSync(marker, replacement); return this; }
    return listen.call(this, address, callback);
  });
  await assert.rejects(activate_foreground_readiness(f.state, f.root, "first", marker, id), error => error.outcomeUnknown === true && error.markerChanged === true);
  assert.equal(fs.readFileSync(marker, "utf8"), replacement);
});

test("a foreground reservation tolerates concurrent removal of an empty marker directory", t => {
  const f = fixture(t), directory = path.join(project_directory(f.state, f.root), "coordination", "first.readiness-active");
  const readdir = fs.readdirSync; let scans = 0;
  t.mock.method(fs, "readdirSync", (file, ...args) => {
    if (file === directory && ++scans === 2) { fs.rmdirSync(directory); throw Object.assign(new Error("removed concurrently"), { code: "ENOENT" }); }
    return readdir(file, ...args);
  });
  const marker = begin_foreground_readiness(f.state, f.root, "first", randomUUID());
  assert.equal(fs.existsSync(marker), true); assert.equal(release_foreground_readiness(f.state, marker), true);
});

test("independent MCP owners cannot run foreground checks concurrently", { timeout: 15000 }, async t => {
  const f = fixture(t); f.save();
  const module = pathToFileURL(path.join(ROOT, "mcp/settings-operations.mjs")).href;
  const code = `import {SettingsOperations} from ${JSON.stringify(module)};let release;const gate=new Promise(resolve=>{release=resolve;});
    const operations=new SettingsOperations(async()=>{process.send({event:'entered'});await gate;return {componentChecks:[]};},()=>{},{stateDirectory:${JSON.stringify(f.state)}});
    process.on('message',async message=>{if(message==='release'){release();return;}if(message!=='start')return;
      try{const job=operations.start('probe',{component:'v8std'},{projectRoot:${JSON.stringify(f.root)},instance:'first'});await job.finished;
        process.send({event:'done',status:job.status,error:job.error},()=>process.disconnect());}
      catch(error){process.send({event:'done',status:'failed',error:error.message},()=>process.disconnect());}});process.send({event:'ready'});`;
  const events = [], workers = Array.from({ length: 2 }, (_, index) => {
    const child = childProcess.spawn(process.execPath, ["--input-type=module", "-e", code],
      { env: f.env, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    const closed = new Promise(resolve => child.once("close", resolve));
    child.on("message", message => events.push({ index, ...message }));
    f.clients.push({ close: async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; } });
    return { child, closed };
  });
  const waitFor = async predicate => {
    for (let i = 0; i < 600 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), JSON.stringify(events));
  };
  await waitFor(() => events.filter(event => event.event === "ready").length === 2);
  workers.forEach(({ child }) => child.send("start"));
  await waitFor(() => events.some(event => event.event === "entered") && events.some(event => event.event === "done" && event.status === "failed"));
  assert.equal(events.filter(event => event.event === "entered").length, 1);
  workers.forEach(({ child }) => { if (child.connected) try { child.send("release", () => {}); } catch {} });
  await Promise.all(workers.map(({ closed }) => closed));
  assert.deepEqual(events.filter(event => event.event === "done").map(event => event.status).sort(), ["completed", "failed"]);
  assert.equal(await foreground_readiness_active(f.state, f.root, "first"), false);
});

test("queued foreground claims in four separate processes cannot run again after a fast leader", { timeout: 30000 }, async t => {
  const f = fixture(t); f.save();
  const module = pathToFileURL(path.join(ROOT, "mcp/settings-operations.mjs")).href;
  for (let round = 0; round < 3; round++) {
    const gate = path.join(f.base, `gate-${round}`), events = [];
    const code = `import fs from 'node:fs';import {SettingsOperations} from ${JSON.stringify(module)};
      const [marker,gate]=process.argv.slice(1),operations=new SettingsOperations(async()=>{
        process.send({event:'entered'});await new Promise(resolve=>setTimeout(resolve,25));return {componentChecks:[]};
      },()=>{},{stateDirectory:${JSON.stringify(f.state)}});
      process.on('message',async message=>{if(message!=='start')return;
        try {const job=operations.start('probe',{component:'v8std'},{projectRoot:${JSON.stringify(f.root)},instance:'first'});
          fs.writeFileSync(marker,'reserved');const limit=Date.now()+10000,wait=new Int32Array(new SharedArrayBuffer(4));
          while(!fs.existsSync(gate)&&Date.now()<limit)Atomics.wait(wait,0,0,5);
          if(!fs.existsSync(gate))throw new Error('gate timed out');await job.finished;
          process.send({event:'done',status:job.status,error:job.error},()=>process.disconnect());
        }catch(error){process.send({event:'done',status:'failed',error:error.message},()=>process.disconnect());}});process.send({event:'ready'});`;
    const workers = Array.from({ length: 4 }, (_, index) => {
      const marker = path.join(f.base, `reserved-${round}-${index}`);
      const child = childProcess.spawn(process.execPath, ["--input-type=module", "-e", code, marker, gate],
        { env: f.env, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
      const closed = new Promise(resolve => child.once("close", resolve));
      child.on("message", message => events.push({ index, ...message }));
      f.clients.push({ close: async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; } });
      return { child, closed, marker };
    });
    const waitFor = async predicate => {
      for (let i = 0; i < 1000 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(predicate(), JSON.stringify(events));
    };
    await waitFor(() => events.filter(event => event.event === "ready").length === 4);
    workers.forEach(({ child }) => child.send("start"));
    await waitFor(() => workers.every(({ marker }) => fs.existsSync(marker)));
    fs.writeFileSync(gate, "go");
    await Promise.all(workers.map(({ closed }) => closed));
    assert.equal(events.filter(event => event.event === "entered").length, 1, JSON.stringify(events));
    assert.deepEqual(events.filter(event => event.event === "done").map(event => event.status).sort(), ["completed", "failed", "failed", "failed"]);
  }
  assert.equal(await foreground_readiness_active(f.state, f.root, "first"), false);
});

for (const persistent of [false, true]) test(`foreground marker reads ${persistent ? "reject persistent changes" : "retry a transient ctime change"}`, t => {
  const f = fixture(t), previous = begin_foreground_readiness(f.state, f.root, "first", randomUUID());
  const open = fs.openSync, fstat = fs.fstatSync; let markerFd, changes = 0, next;
  t.mock.method(fs, "openSync", (file, ...args) => {
    const fd = open(file, ...args);
    if (file === previous) markerFd = fd;
    return fd;
  });
  t.mock.method(fs, "fstatSync", (fd, ...args) => {
    const stat = fstat(fd, ...args);
    if (fd === markerFd && (persistent || changes === 0)) { stat.ctimeNs += 1n; changes++; }
    return stat;
  });
  try {
    if (persistent) assert.throws(() => begin_foreground_readiness(f.state, f.root, "first", randomUUID()), /барьер/i);
    else { next = begin_foreground_readiness(f.state, f.root, "first", randomUUID()); assert.equal(changes, 1); }
  } finally {
    t.mock.restoreAll();
    if (next) assert.equal(release_foreground_readiness(f.state, next), true);
    assert.equal(release_foreground_readiness(f.state, previous), true);
  }
});

test("a failed foreground marker unlink retains the barrier until cleanup succeeds", async t => {
  const {f}=await ready_fixture(t),marker=begin_foreground_readiness(f.state,f.root,"first",randomUUID()),remove=fs.rmSync;let failed=false;
  t.mock.method(fs,"rmSync",(file,options)=>{if(file===marker&&!failed){failed=true;throw Object.assign(new Error("busy"),{code:"EPERM"});}return remove(file,options);});
  assert.equal(release_foreground_readiness(f.state,marker),false);assert.equal(failed,true);
  assert.equal(JSON.parse(fs.readFileSync(marker,"utf8")).phase,"cleanup_unknown");assert.equal(await foreground_readiness_active(f.state,f.root,"first"),true);
  assert.throws(() => begin_foreground_readiness(f.state,f.root,"first",randomUUID()), /не подтверждено/i);
  assert.equal(release_foreground_readiness(f.state,marker),true);assert.equal(fs.existsSync(marker),false);
});

test("legacy cleanup barriers survive MCP reconnect and expose a specific manual recovery path", async t => {
  const { f } = await ready_fixture(t), id = randomUUID();
  const directory = path.join(project_directory(f.state, f.root), "coordination", "first.readiness-active"), marker = path.join(directory, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, id, phase: "cleanup_unknown" }));
  const original = fs.readFileSync(marker);
  for (let i = 0; i < 2; i++) {
    const client = await session(t, "mcp/settings.mjs", [], f);
    await assert.rejects(client.call("settings.refresh_readiness", { scope: f.root + "#first", component: "v8std" }),
      error => error.message.includes(JSON.stringify(marker).slice(1, -1)) && error.message.includes("USAGE.md"));
    await client.close(); assert.deepEqual(fs.readFileSync(marker), original);
  }
  // The record is a synthetic fixture: unlike a real legacy barrier, this test
  // knows that no owned backend or remote session was ever started for it.
  fs.unlinkSync(marker);
  const recovered = await session(t, "mcp/settings.mjs", [], f);
  const job = (await recovered.call("settings.refresh_readiness", { scope: f.root + "#first", component: "v8std" })).structuredContent;
  const done = (await recovered.call("settings.operation", { operationId: job.id, waitMs: 10000 })).structuredContent;
  assert.equal(done.status, "completed", JSON.stringify(done));
});

test("lease cleanup reports persistent write errors without scheduling endless retries", async t => {
  const {f}=await ready_fixture(t),rename=fs.renameSync,remove=fs.rmSync,events=[];let blocked=false,marker,attempts=0;
  t.mock.method(fs,"renameSync",(from,to)=>{if(blocked&&to===marker)throw Object.assign(new Error("busy"),{code:"EPERM"});return rename(from,to);});
  t.mock.method(fs,"rmSync",(file,options)=>{if(blocked&&file===marker){attempts++;throw Object.assign(new Error("busy"),{code:"EBUSY"});}return remove(file,options);});
  const operations=new SettingsOperations(async()=>{blocked=true;return {};},name=>events.push(name),{stateDirectory:f.state});
  const foreground=operations.start("check",{},{projectRoot:f.root,instance:"first"});
  marker=path.join(project_directory(f.state,f.root),"coordination","first.readiness-active",foreground.id);
  await foreground.finished;assert.equal(foreground.status,"outcome_unknown");assert.equal(fs.existsSync(marker),true);
  assert.ok(events.includes("operation_cleanup_failed"));const completedAttempts=attempts;
  await new Promise(done=>setTimeout(done,1200));assert.equal(attempts,completedAttempts);
  blocked=false;assert.equal(release_foreground_readiness(f.state,marker),true);
});

test("a foreground marker that cannot be deleted remains a cleanup barrier", async t => {
  const { f } = await ready_fixture(t), remove = fs.rmSync, events = []; let marker, blocked = false;
  t.mock.method(fs, "rmSync", (file, options) => {
    if (blocked && file === marker) throw Object.assign(new Error("busy"), { code: "EPERM" });
    return remove(file, options);
  });
  const operations = new SettingsOperations(async () => { blocked = true; return {}; }, name => events.push(name), { stateDirectory: f.state });
  const foreground = operations.start("check", {}, { projectRoot: f.root, instance: "first" });
  marker = path.join(project_directory(f.state, f.root), "coordination", "first.readiness-active", foreground.id);
  await foreground.finished;
  assert.equal(foreground.status, "outcome_unknown"); assert.ok(events.includes("operation_cleanup_failed"));
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).phase, "cleanup_unknown");
  assert.equal(await foreground_readiness_active(f.state, f.root, "first"), true);
  blocked = false; assert.equal(release_foreground_readiness(f.state, marker), true);
});

test("an uncertain foreground check does not block an independent index observation", async t => {
  const { f } = await ready_fixture(t), id = randomUUID();
  const marker = path.join(project_directory(f.state, f.root), "coordination", "first.readiness-active", id);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, id, phase: "cleanup_unknown" }));
  const operations = new SettingsOperations(async () => ({ checked: true }), () => {}, { stateDirectory: f.state });
  const context = { projectRoot: f.root, instance: "first" };
  const job = operations.start("refresh_readiness", { scope: f.root + "#first", component: "code-index" }, context);
  await job.finished;
  assert.equal(job.status, "completed"); assert.equal(fs.existsSync(marker), true);
  assert.throws(() => operations.start("check", {}, context), /не подтверждено/i);
});

test("a starting marker with a live listener remains an active foreground barrier", async t => {
  const { f } = await ready_fixture(t), id = randomUUID(), marker = begin_foreground_readiness(f.state, f.root, "first", id);
  const listener = await open_reader(id);
  try { assert.equal(await foreground_readiness_active(f.state, f.root, "first"), true); }
  finally { await listener.close(); }
  assert.equal(await foreground_readiness_active(f.state, f.root, "first"), true);
  assert.equal(release_foreground_readiness(f.state, marker), true);
  assert.equal(await foreground_readiness_active(f.state, f.root, "first"), false);
});

test("a starting foreground marker blocks a background probe before listener binding", async t => {
  const { f, backend, count } = await ready_fixture(t), marker = begin_foreground_readiness(f.state, f.root, "first", randomUUID());
  const operations = new SettingsOperations((action, args) => backend.main({ action, ...args }), () => {}, { stateDirectory: f.state });
  const before = count(), job = operations.start("refresh_readiness", { scope: f.root + "#first" }, { projectRoot: f.root, instance: "first" });
  await job.finished; assert.equal(job.status, "completed"); assert.equal(job.result.transient, true); assert.equal(count(), before);
  assert.equal(release_foreground_readiness(f.state, marker), true);
});

test("failed activation and failed listener cleanup retain a live foreground barrier", async t => {
  const { f } = await ready_fixture(t), id = randomUUID(), marker = begin_foreground_readiness(f.state, f.root, "first", id);
  const rename = fs.renameSync, close = net.Server.prototype.close; let listener;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === marker && JSON.parse(fs.readFileSync(from, "utf8")).phase === "active") throw Object.assign(new Error("fixture activation failure"), { code: "EPERM" });
    return rename(from, to);
  });
  t.mock.method(net.Server.prototype, "close", function (callback) {
    if (String(this.address()).includes(id)) { listener = this; queueMicrotask(() => callback(new Error("fixture cleanup failure"))); return this; }
    return close.call(this, callback);
  });
  try {
    await assert.rejects(activate_foreground_readiness(f.state, f.root, "first", marker, id), error => error.outcomeUnknown === true);
    assert.ok(listener); assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).phase, "cleanup_unknown");
    assert.equal(await foreground_readiness_active(f.state, f.root, "first"), true);
  } finally {
    t.mock.restoreAll();
    if (listener) await new Promise((resolve, reject) => close.call(listener, error => error ? reject(error) : resolve()));
    release_foreground_readiness(f.state, marker);
  }
});

test("reader startup reports an unclosed listener when a second listener fails", async t => {
  const id = randomUUID(), listen = net.Server.prototype.listen, close = net.Server.prototype.close; let first;
  t.mock.method(net.Server.prototype, "listen", function (address, callback) {
    if (String(address).includes(id) && String(address).includes("-observe")) {
      queueMicrotask(() => this.emit("error", new Error("fixture bind failure"))); return this;
    }
    if (String(address).includes(id)) first = this;
    return listen.call(this, address, callback);
  });
  t.mock.method(net.Server.prototype, "close", function (callback) {
    if (this === first) { queueMicrotask(() => callback(new Error("fixture close failure"))); return this; }
    return close.call(this, callback);
  });
  try {
    await assert.rejects(open_reader(id, { binding: "fixture", observe: async () => ({}) }), error => error.outcomeUnknown === true);
    assert.equal(await reader_active(id), true);
  } finally {
    t.mock.restoreAll();
    if (first?.listening) await new Promise((resolve, reject) => close.call(first, error => error ? reject(error) : resolve()));
  }
});

test("reader startup times out and closes a listener that reports success late", { timeout: 4000 }, async t => {
  const id = randomUUID(), listen = net.Server.prototype.listen, originalTimer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => originalTimer(callback, ms === 5000 ? 120 : ms, ...args));
  t.mock.method(net.Server.prototype, "listen", function (address, callback) {
    return String(address).includes(id) ? listen.call(this, address, () => originalTimer(callback, 250)) : listen.call(this, address, callback);
  });
  await assert.rejects(open_reader(id), error => error.outcomeUnknown === true);
  await new Promise(resolve => originalTimer(resolve, 350));
  assert.equal(await reader_active(id), false);
});

test("reader close times out when the server never confirms its callback", { timeout: 4000 }, async t => {
  const id = randomUUID(), lease = await open_reader(id), close = net.Server.prototype.close, originalTimer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => originalTimer(callback, ms === 5000 ? 120 : ms, ...args));
  t.mock.method(net.Server.prototype, "close", function (callback) {
    return String(this.address()).includes(id) ? close.call(this, () => {}) : close.call(this, callback);
  });
  await assert.rejects(lease.close(), error => error.outcomeUnknown === true);
  assert.equal(await reader_active(id), false);
});

test("a foreground marker without its endpoint keeps refresh transient until cleanup is confirmed", async t => {
  const {f,backend}=await ready_fixture(t),id=randomUUID(),marker=begin_foreground_readiness(f.state,f.root,"first",id);
  fs.writeFileSync(marker,JSON.stringify({pid:process.pid,id,phase:"active"}));
  assert.equal(await foreground_readiness_active(f.state,f.root,"first"),true);
  const operations=new SettingsOperations((action,args)=>backend.main({action,...args}),()=>{},{stateDirectory:f.state});
  const background=operations.start("refresh_readiness",{scope:f.root+"#first"},{projectRoot:f.root,instance:"first"});await background.finished;
  assert.equal(background.status,"completed");assert.equal(background.result.transient,true);
  assert.ok(background.result.detail.includes(path.dirname(marker)), background.result.detail); assert.match(background.result.detail, /USAGE\.md/);
  const foreground=operations.start("probe",{component:"v8std"},{projectRoot:f.root,instance:"first"});await foreground.finished;
  assert.equal(foreground.status,"failed");assert.ok(foreground.error.includes(path.dirname(marker)));assert.match(foreground.error,/USAGE\.md/);
  assert.equal(fs.existsSync(path.join(instance_directory(f.state,f.root),"first.readiness.json")),false);
  release_foreground_readiness(f.state,marker);
});

test("an abandoned atomic-write temporary file cannot keep refresh transient", async t => {
  const {f,backend}=await ready_fixture(t),id=randomUUID(),marker=begin_foreground_readiness(f.state,f.root,"first",id);
  fs.rmSync(marker);fs.writeFileSync(path.join(path.dirname(marker),".core-abandoned.tmp"),JSON.stringify({id,pid:process.pid,phase:"active"}));
  assert.equal(await foreground_readiness_active(f.state,f.root,"first"),false);
  const operations=new SettingsOperations((action,args)=>backend.main({action,...args}),()=>{},{stateDirectory:f.state});
  const background=operations.start("refresh_readiness",{scope:f.root+"#first"},{projectRoot:f.root,instance:"first"});await background.finished;
  assert.equal(background.status,"completed");assert.equal(fs.existsSync(path.join(instance_directory(f.state,f.root),"first.readiness.json")),true);
});

test("a damaged foreground marker fails closed rather than claiming cleanup", async t => {
  const {f,backend}=await ready_fixture(t),id=randomUUID(),marker=begin_foreground_readiness(f.state,f.root,"first",id);
  fs.writeFileSync(marker,"");assert.equal(await foreground_readiness_active(f.state,f.root,"first"),true);
  const operations=new SettingsOperations((action,args)=>backend.main({action,...args}),()=>{},{stateDirectory:f.state});
  assert.throws(() => operations.start("refresh_readiness",{scope:f.root+"#first"},{projectRoot:f.root,instance:"first"}), /барьер/i);
  assert.equal(release_foreground_readiness(f.state,marker),false); fs.rmSync(marker);
});

test("a foreground check snapshots the receipt under lock after an older commit", async t => {
  const {f,backend,authorization}=await ready_fixture(t),signal=new Int32Array(new SharedArrayBuffer(8));
  const receipt=path.join(instance_directory(f.state,f.root),"first.readiness.json");let worker;
  const workerSource=`
    import fs from "node:fs";
    import { parentPort, workerData } from "node:worker_threads";
    const signal=new Int32Array(workerData.signal),rename=fs.renameSync;
    fs.renameSync=(from,to)=>{if(String(to)===workerData.receipt&&Atomics.compareExchange(signal,0,0,1)===0){Atomics.notify(signal,0);Atomics.wait(signal,1,0,5000);}return rename(from,to);};
    try { const {SettingsBackend}=await import(workerData.backendUrl);const result=await new SettingsBackend().main({action:"refresh_readiness",...workerData.args});parentPort.postMessage({result}); }
    catch(error){parentPort.postMessage({error:error.stack||error.message});}
  `;
  t.after(async()=>{Atomics.store(signal,1,1);Atomics.notify(signal,1);await worker?.terminate();});
  const operations=new SettingsOperations((action,args)=>{
    if(action==="check")return backend.main({action,...args});
    worker=new Worker(new URL("data:text/javascript,"+encodeURIComponent(workerSource)),{workerData:{signal:signal.buffer,receipt,args,backendUrl:pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)),"../scripts/settings_backend.mjs")).href}});
    return new Promise((resolve,reject)=>{worker.once("message",message=>message.error?reject(new Error(message.error)):resolve(message.result));worker.once("error",reject);});
  },()=>{},{stateDirectory:f.state});
  const background=operations.start("refresh_readiness",{scope:f.root+"#first"},{});
  const deadline=Date.now()+10000;while(!Atomics.load(signal,0)&&Date.now()<deadline)await new Promise(done=>setTimeout(done,10));
  assert.equal(Atomics.load(signal,0),1,"background must pause inside its receipt commit");
  const foreground=operations.start("check",{authorization},{});await new Promise(done=>setTimeout(done,250));
  Atomics.store(signal,1,1);Atomics.notify(signal,1);await Promise.all([background.finished,foreground.finished]);
  assert.equal(background.status,"completed");assert.equal(foreground.status,"completed");assert.notEqual(foreground.result.superseded,true);
});

test("a parallel refresh during full preparation observes without changing the receipt or tickets", async t => {
  const {f,backend,authorization}=await ready_fixture(t);let release;
  const gate=new Promise(done=>{release=done;});
  const operations=new SettingsOperations(async(action,args)=>{if(action==="check")await gate;return backend.main({action,...args});},()=>{},{stateDirectory:f.state});
  const foreground=operations.start("check",{authorization},{}), background=operations.start("refresh_readiness",{scope:f.root+"#first"},{});
  await background.finished;assert.equal(background.status,"completed");assert.equal(background.result.componentChecks.length,0);assert.equal(background.result.transient,true);
  assert.equal(fs.existsSync(path.join(instance_directory(f.state,f.root),"first.readiness.json")),false);
  assert.equal(fs.existsSync(path.join(instance_directory(f.state,f.root),"first.readiness-observations.json")),false);
  assert.equal(operations.status().id,foreground.id);release();await foreground.finished;assert.equal(foreground.result.superseded,undefined);
});

test("a changed EDT project descriptor invalidates an in-flight full check", async t => {
  const {f,backend,url,authorization,holdIndex,edtDone}=await ready_fixture(t);await enable_external_index(f,backend,url);
  const delayed=holdIndex(),pending=backend.main({action:"check",authorization});await Promise.all([delayed.started,edtDone]);
  fs.rmSync(path.join(f.root,".project"));delayed.release();const result=await pending;
  assert.equal(result.superseded,true);assert.equal(result.fullReadiness,"not_verified");
});

test("a full check never renews evidence that expired while another component was running", async t => {
  const {f,backend,url,authorization,holdIndex,edtDone}=await ready_fixture(t);await enable_external_index(f,backend,url);
  const NativeDate=Date;let offset=0;class ClockDate extends NativeDate {constructor(...args){super(...(args.length?args:[NativeDate.now()+offset]));}static now(){return NativeDate.now()+offset;}}
  t.mock.method(globalThis,"Date",ClockDate);
  const delayed=holdIndex(),pending=backend.main({action:"check",authorization});await Promise.all([delayed.started,edtDone]);
  offset=16*60000;delayed.release();const result=await pending;
  assert.equal(result.fullReadiness,"not_ready");assert.equal(result.readiness.checks.find(item=>item.id==="edt").state,"not_verified");
});

test("parallel external checks retain their own observation times", async t => {
  const { f, backend, delayV8 } = await ready_fixture(t); delayV8(300);
  const result = await backend.main({ action: "refresh_readiness", scope: f.root + "#first" });
  const edt = result.componentChecks.find(item => item.id === "edt"), v8 = result.componentChecks.find(item => item.id === "v8std");
  assert.equal(edt.state, "ready"); assert.equal(v8.state, "ready");
  assert.ok(Date.parse(v8.checkedAt) - Date.parse(edt.checkedAt) >= 100);
});

test("fresh component observations update overall setup without extending its lifetime", async t => {
  const { f, backend } = await ready_fixture(t), config = backend.effective(backend.current());
  config.mcp.managed["bsl-ls"].mode = "external";
  const managed = ["code-index", "bsl-ls"].map(name => ({ name, state: "ready", ready: true }));
  const setup = save_readiness(f.state, config, f.profile, managed, { edt: { ready: true }, v8std: { ready: true } });
  const updated = state => save_component_checks(f.state, config, f.profile, [{ id: "v8std", state }]);
  updated("error"); let read = await read_readiness(f.state, config, f.profile);
  assert.equal(read.state, "blocked"); assert.equal(read.checks.find(item => item.id === "v8std").state, "error");
  updated("ready"); read = await read_readiness(f.state, config, f.profile);
  assert.equal(read.state, "blocked"); assert.equal(read.checks.find(item => item.id === "v8std").state, "ready");
  assert.equal(read.checks.find(item => item.id === "bsl-ls").state, "not_verified");
  assert.equal(read.expiresAt, setup.expiresAt); assert.equal(read.checkedAt, setup.checkedAt);
});

test("disabled BSL stays disabled in setup and component status", async t => {
  const { f, backend } = await ready_fixture(t), config = backend.effective(backend.current()), profile = structuredClone(f.profile);
  const managed = [{ name: "code-index", state: "ready", ready: true }, { name: "bsl-ls", state: "disabled", ready: true }];
  const saved = save_readiness(f.state, config, profile, managed, { edt: { ready: true }, v8std: { ready: true } });
  assert.equal(saved.state, "blocked"); assert.equal(saved.checks.find(item => item.id === "bsl-ls").state, "disabled");
  assert.equal((await read_readiness(f.state, config, profile)).checks.find(item => item.id === "bsl-ls").state, "disabled");
  assert.equal(component_statuses(f.state, config, profile).find(item => item.id === "bsl-ls").state, "disabled");
  const inconsistent = save_readiness(f.state, config, profile, [managed[0], { name: "bsl-ls", state: "error", ready: true }], { edt: { ready: true }, v8std: { ready: true } });
  assert.equal(inconsistent.state, "blocked"); assert.equal(inconsistent.checks.find(item => item.id === "bsl-ls").state, "error");
});

for (const mode of ["auto", "external"]) test(`legacy ${mode} BSL ready evidence cannot restore full readiness`, async t => {
  const { f, backend } = await ready_fixture(t), config = backend.effective(backend.current());
  config.mcp.managed["bsl-ls"].mode = mode;
  const managed = [{ name: "code-index", state: "ready", ready: true }, { name: "bsl-ls", state: "ready", ready: true }];
  const ambiguous = save_readiness(f.state, config, f.profile, [managed[0], { name: "bsl-ls", ready: true }], { edt: { ready: true }, v8std: { ready: true } });
  assert.equal(ambiguous.state, "blocked"); assert.equal(ambiguous.checks.find(item => item.id === "bsl-ls").state, "not_verified");
  save_readiness(f.state, config, f.profile, managed, { edt: { ready: true }, v8std: { ready: true } });
  save_component_checks(f.state, config, f.profile, [{ id: "bsl-ls", state: "ready", apiEvidenceVersion: 1 }]);
  const file = path.join(instance_directory(f.state, f.root), "first.readiness.json"), receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  const legacy = receipt.components["bsl-ls"].result; legacy.state = "ready"; delete legacy.apiCompatible; delete legacy.apiEvidenceVersion;
  receipt.result.checks.find(item => item.id === "bsl-ls").state = "ready";
  receipt.result.state = "ready"; receipt.result.mainReadiness.state = "ready";
  fs.writeFileSync(file, JSON.stringify(receipt));
  const check = read_component_checks(f.state, config, f.profile).find(item => item.id === "bsl-ls");
  assert.equal(check.state, "not_verified"); assert.equal(check.apiCompatible, false); assert.match(check.detail, /повторите проверку/i);
  const readiness = await read_readiness(f.state, config, f.profile);
  assert.equal(readiness.state, "blocked"); assert.equal(readiness.checks.find(item => item.id === "bsl-ls").state, "not_verified");
});

test("a newer BSL API observation updates the last verified observation time", async t => {
  const { f, backend } = await ready_fixture(t), config = backend.effective(backend.current());
  config.mcp.managed["bsl-ls"].enabled = true;
  const now = Date.now(), earlier = new Date(now - 2000).toISOString(), later = new Date(now - 1000).toISOString();
  save_component_checks(f.state, config, f.profile, [{ id: "bsl-ls", state: "disabled", checkedAt: earlier }]);
  save_component_checks(f.state, config, f.profile, [{ id: "bsl-ls", state: "not_verified", apiCompatible: true, checkedAt: later }]);
  const status = component_statuses(f.state, config, f.profile).find(item => item.id === "bsl-ls");
  assert.equal(status.state, "not_verified"); assert.equal(status.checkedAt, later); assert.equal(status.lastCheckedAt, later);
});

test("an expired setup remains separate while component refresh observes each endpoint once", async t => {
  const { f, backend, url, requests } = await ready_fixture(t), selected = backend.current();
  for (const id of ["code-index", "bsl-ls"]) Object.assign(selected.mcp.managed[id], { enabled: true, mode: "external", url: url + (id === "code-index" ? "/index" : "/bsl") });
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(selected));
  await backend.main({ action: "update", set: { codeIndexEnabled: true, bslLsEnabled: true } });
  const config = backend.effective(backend.current()), managed = ["code-index", "bsl-ls"].map(name => ({ name, state: "ready", ready: true }));
  save_readiness(f.state, config, f.profile, managed, { edt: { ready: true }, v8std: { ready: true } });
  const file = path.join(instance_directory(f.state, f.root), "first.readiness.json"), receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  receipt.result.checkedAt = new Date(Date.now() - 16 * 60000).toISOString(); receipt.result.expiresAt = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(file, JSON.stringify(receipt)); assert.equal((await backend.main({ action: "read" })).readiness.state, "stale");
  process.env.UNRELATED_COMPONENT_SECRET = "foreign-secret-fixture"; process.env.JAVA_TOOL_OPTIONS = "-Dpassword=java-secret-fixture";
  const spawn = childProcess.spawn, policyLaunches = [];
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    const child = spawn(command, args, options), send = child.send?.bind(child);
    if (send) child.send = (message, ...rest) => {
      if (message.args?.some(value => value.endsWith("policy/read-only-mcp.mjs") || value.endsWith("policy\\read-only-mcp.mjs"))) policyLaunches.push(message);
      return send(message, ...rest);
    };
    return child;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  requests.length = 0;
  // CI's no-shell preload is already installed in this process, but its
  // NODE_OPTIONS must not make this clean-environment scenario fail closed.
  const result = await with_clean_policy_environment(() => backend.main({ action: "refresh_readiness", scope: f.root + "#first" }));
  assert.equal(result.readiness.state, "stale"); assert.equal(result.readiness.workflowReadiness.state, "not_checked");
  for (const urlPath of ["/edt", "/v8std"]) assert.equal(requests.filter(item => item.url === urlPath && item.method === "initialize").length, 1);
  assert.equal(result.componentChecks.length, 7); assert.equal(fs.existsSync(path.join(instance_directory(f.state, f.root), "first.preparation.json")), false);
  assert.equal(policyLaunches.length, 0);
  assert.equal((await backend.main({ action: "read" })).readiness.state, "stale");
});

test("automatic setup never marks a different configured policy Node as verified", async t => {
  const { f, backend } = await ready_fixture(t), selected = backend.current();
  selected.mcp.managed["bsl-ls"].node = path.join(f.base, "missing-custom-node");
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(selected));
  const config = backend.effective(backend.current());
  save_readiness(f.state, config, f.profile, [{ name: "code-index", state: "ready", ready: true }, { name: "bsl-ls", state: "ready", ready: true }], { edt: { ready: true }, v8std: { ready: true } });
  const file = path.join(instance_directory(f.state, f.root), "first.readiness.json"), receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  receipt.result.checkedAt = new Date(Date.now() - 16 * 60000).toISOString(); receipt.result.expiresAt = new Date(Date.now() - 60000).toISOString(); fs.writeFileSync(file, JSON.stringify(receipt));
  const result = await backend.main({ action: "refresh_readiness", scope: f.root + "#first" });
  assert.equal(result.readiness.state, "stale");
});

test("automatic component refresh does not rerun a failed policy setup", async t => {
  const { f, backend, url } = await ready_fixture(t), selected = backend.current();
  for (const id of ["code-index", "bsl-ls"]) Object.assign(selected.mcp.managed[id], { enabled: true, mode: "external", url: url + (id === "code-index" ? "/index" : "/bsl") });
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(selected)); await backend.main({ action: "update", set: { codeIndexEnabled: true, bslLsEnabled: true } });
  const config = backend.effective(backend.current()), managed = ["code-index", "bsl-ls"].map(name => ({ name, state: "ready", ready: true }));
  const setup = save_readiness(f.state, config, f.profile, [...managed, { name: "policy", state: "error", ready: false }], { edt: { ready: true }, v8std: { ready: true } });
  assert.equal(setup.state, "blocked");
  const result = await with_clean_policy_environment(() => backend.main({ action: "refresh_readiness", scope: f.root + "#first" }));
  assert.equal(result.readiness.checks.find(item => item.id === "policy").state, "error"); assert.notEqual(result.readiness.state, "ready");
});

test("automatic setup does not claim policy readiness with unverified Node startup options", async t => {
  const { f, backend } = await ready_fixture(t), config = backend.effective(backend.current());
  save_readiness(f.state, config, f.profile, [{ name: "code-index", state: "ready", ready: true }, { name: "bsl-ls", state: "ready", ready: true }], { edt: { ready: true }, v8std: { ready: true } });
  const file = path.join(instance_directory(f.state, f.root), "first.readiness.json"), receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  receipt.result.checkedAt = new Date(Date.now() - 16 * 60000).toISOString(); receipt.result.expiresAt = new Date(Date.now() - 60000).toISOString(); fs.writeFileSync(file, JSON.stringify(receipt));
  const result = await with_clean_policy_environment(() => {
    process.env.NODE_OPTIONS = "--no-such-flag";
    return backend.main({ action: "refresh_readiness", scope: f.root + "#first" });
  });
  assert.equal(result.readiness.state, "stale");
});

for (const expired of [false, true]) test(`overall setup respects ${expired ? "already expired" : "remaining"} component evidence`, async t => {
  const { f, backend, url } = await ready_fixture(t), selected = backend.current();
  for (const id of ["code-index", "bsl-ls"]) Object.assign(selected.mcp.managed[id], { enabled: true, mode: "external", url: url + (id === "code-index" ? "/index" : "/bsl") });
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(selected));
  await backend.main({ action: "update", set: { codeIndexEnabled: true, bslLsEnabled: true } });
  const config = backend.effective(backend.current()), managed = ["code-index", "bsl-ls"].map(name => ({ name, state: "ready", ready: true }));
  save_readiness(f.state, config, f.profile, managed, { edt: { ready: true }, v8std: { ready: true } });
  const file = path.join(instance_directory(f.state, f.root), "first.readiness.json"), receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  receipt.result.checkedAt = new Date(Date.now() - 16 * 60000).toISOString(); receipt.result.expiresAt = new Date(Date.now() - 60000).toISOString(); fs.writeFileSync(file, JSON.stringify(receipt));
  const expiresAt = new Date(Date.now() + (expired ? 200 : 60000)).toISOString(), observed = new Date(Date.now() - 14 * 60000).toISOString();
  const main = backend.main.bind(backend);
  t.mock.method(backend, "main", async (request, ...args) => {
    if (request.action === "probe" && request.component === "code-index" && request.collectOnly)
      return { componentChecks: [{ id: "code-index", state: "ready", checkedAt: observed, expiresAt }], managed: [], external: {} };
    if (expired && request.action === "probe" && request.component === "bsl-ls" && request.collectOnly) await new Promise(resolve => setTimeout(resolve, 400));
    return main(request, ...args);
  });
  const result = await with_clean_policy_environment(() => main({ action: "refresh_readiness", scope: f.root + "#first" }));
  if (expired) {
    assert.equal(result.componentChecks.find(item => item.id === "code-index").state, "not_verified");
    assert.equal(result.readiness.state, "stale");
  } else {
    assert.equal(result.readiness.state, "stale");
    assert.equal(result.componentChecks.find(item => item.id === "code-index").state, "ready");
  }
});

for (const layer of ["profile", "project_local"]) test(`changing edt_required in ${layer} invalidates dependent readiness within the directory and instance`, async t => {
  const { f, backend } = await ready_fixture(t);
  f.profile.testing.yaxunit=true;f.profile.testing.yaxunit_config={repository_id:"product",runner:"edt",results:"results"};f.save();
  const config = backend.effective(backend.current());
  const target = path.join(f.root, layer === "profile" ? ".ai/project.yaml" : ".ai/project.local.yaml");
  const profile = project_profile(f.root), managed = ["code-index", "bsl-ls"].map(name => ({ name, state: "ready", ready: true, ...(name === "bsl-ls" ? { apiEvidenceVersion: 1 } : {}) }));
  save_readiness(f.state, config, profile, managed, { edt: { ready: true }, v8std: { ready: true } }, [{ id: "yaxunit", state: "ready" }]);
  save_component_checks(f.state, config, profile, [{ id: "edt", state: "ready" }, { id: "yaxunit", state: "ready", target: { projectName: "Product" } }]);
  assert.equal((await read_readiness(f.state, config, profile)).state, "ready");
  const receipt = path.join(instance_directory(f.state, f.root), "first.readiness.json"), before = fs.readFileSync(receipt);
  const repositories = profile.repositories.map(item => ({ ...item, edt_required: false }));
  dump(layer === "profile" ? { ...f.profile, repositories } : { repositories }, target);
  const updated = project_profile(f.root), saved = await read_readiness(f.state, config, updated);
  assert.equal(saved.state, "stale"); assert.equal(saved.mainReadiness.state, "stale");
  const checks = read_component_checks(f.state, config, updated);
  assert.ok(checks.filter(item => ["edt", "yaxunit"].includes(item.id)).every(item => item.state === "check_stale"));
  assert.equal(checks.find(item => item.id === "bsl-ls").state, "ready", "independent verified BSL API evidence remains available");
  assert.equal(checks.find(item => item.id === "yaxunit").target, undefined);
  assert.deepEqual(fs.readFileSync(receipt), before, "invalidation must not rewrite or renew previous observations");
  process.env.EDT_AI_INSTANCE = "other";
  assert.equal((await read_readiness(f.state, config, updated)).state, "not_checked");
  assert.deepEqual(read_component_checks(f.state, config, updated), []);
  process.env.EDT_AI_INSTANCE = "first";
  const other = path.join(f.base, "Other"); fs.mkdirSync(other);
  const otherConfig = { ...config, active_project: other };
  assert.equal((await read_readiness(f.state, otherConfig, updated)).state, "not_checked");
  assert.deepEqual(read_component_checks(f.state, otherConfig, updated), []);
});

test("background component refreshes use the same addressed probes and preserve all other receipts",async t=>{
  const {f,backend,url,paths}=await ready_fixture(t),config=backend.current();
  for(const id of ["code-index","bsl-ls"])Object.assign(config.mcp.managed[id],{enabled:true,mode:"external",url:url+(id==="code-index"?"/index":"/bsl")});
  fs.writeFileSync(f.env.EDT_AI_SETTINGS,JSON.stringify(config));await backend.main({action:"update",set:{codeIndexEnabled:true,bslLsEnabled:true}});
  const profileBefore=fs.readFileSync(path.join(f.root,".ai/project.yaml")),settingsBefore=fs.readFileSync(f.env.EDT_AI_SETTINGS);
  for(const component of ["edt","v8std","openviking","code-index","bsl-ls","yaxunit","vanessa"]){
    const before=(await backend.main({action:"read"})).componentChecks,offset=paths.length;
    const checked=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component});
    assert.deepEqual(checked.componentChecks.map(item=>item.id),[component]);
    const endpoint={edt:"/edt",v8std:"/v8std","code-index":"/index","bsl-ls":"/bsl"}[component];
    assert.ok(paths.slice(offset).every(value=>value===endpoint));if(endpoint)assert.ok(paths.length>offset);
    const after=(await backend.main({action:"read"})).componentChecks;
    assert.deepEqual(after.filter(item=>item.id!==component),before.filter(item=>item.id!==component));
  }
  const all=await backend.main({action:"refresh_readiness",scope:f.root+"#first"});assert.equal(all.componentChecks.length,7);
  assert.equal(all.readiness,undefined);assert.deepEqual(fs.readFileSync(path.join(f.root,".ai/project.yaml")),profileBefore);
  assert.deepEqual(fs.readFileSync(f.env.EDT_AI_SETTINGS),settingsBefore);assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});

test("EDT building and mapping failures remain distinct in saved readiness", async t => {
  const { f, backend, setProjectState, wrong } = await ready_fixture(t);
  const scope = f.root + "#first";
  setProjectState("building");
  const result = await backend.main({ action: "refresh_readiness", scope });
  assert.equal(result.componentChecks.find(item => item.id === "edt").state, "building");
  assert.equal(result.external.edt.repositories[0].matched, true);
  assert.equal(result.external.edt.failure, undefined);
  assert.match(result.external.edt.detail, /product: EDT сообщает о сборке проекта/);
  assert.match(result.external.edt.detail, /повторите проверку готовности/);
  const saved = (await backend.main({ action: "read" })).componentChecks.find(item => item.id === "edt");
  assert.equal(saved.detail, result.external.edt.detail);
  wrong();
  const mismatch = await backend.main({ action: "refresh_readiness", scope });
  assert.equal(mismatch.external.edt.failure.category, "access_scope");
  assert.match(mismatch.external.edt.detail, /имя и путь не сопоставлены/);
  setProjectState("ready");
});

test("managed probe errors omit arbitrary upstream credential encodings before readiness caching", async t => {
  const { f, backend, url, failIndex } = await ready_fixture(t);
  const encoded = [..."private-search-5839"].join("."); failIndex(encoded);
  const config = backend.current();
  Object.assign(config.mcp.managed["code-index"], { mode: "external", url: url + "/index" });
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(config));
  await backend.main({ action: "update", set: { codeIndexEnabled: true } });
  const result = await backend.main({ action: "refresh_readiness", scope: f.root + "#first" });
  assert.match(result.managed.find(item => item.name === "code-index").detail, /RPC -32000.*текст внешней ошибки скрыт/);
  const cache = fs.readFileSync(path.join(instance_directory(f.state, f.root), "first.readiness.json"), "utf8");
  assert.equal((JSON.stringify(result) + cache).includes(encoded), false);
});

test("old readiness receipts cannot reintroduce untrusted diagnostic messages", async t => {
  const { f, backend, authorization } = await ready_fixture(t);
  await backend.main({ action: "check", authorization });
  const file = path.join(instance_directory(f.state, f.root), "first.readiness.json");
  const receipt = JSON.parse(fs.readFileSync(file, "utf8")); assert.equal(receipt.version, 3);
  receipt.result.checks[0].detail = "legacy-untrusted-5731";
  for (const version of [undefined, 2, 99]) {
    receipt.version = version;
    const bytes = JSON.stringify(receipt); fs.writeFileSync(file, bytes);
    const current = await backend.main({ action: "read" });
    assert.equal(current.readiness.state, "not_checked");
    assert.match(current.readiness.reason, /Несовместимая версия/);
    assert.equal(JSON.stringify(current).includes("legacy-untrusted-5731"), false);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
  }
});

test("one readiness check verifies externals, policy and skills, and passive reads reuse scoped evidence",async t=>{
  const {f,backend,authorization,count}=await ready_fixture(t);
  assert.equal((await backend.main({action:"read"})).readiness.state,"not_checked");
  await assert.rejects(backend.main({action:"check"}),/разрешения/);
  const result=await backend.main({action:"check",authorization});assert.equal(result.fullReadiness,"not_ready");assert.equal(result.readiness.state,"blocked");
  for(const id of ["edt","v8std","policy","skills","source-guard","node","profile"])assert.equal(result.readiness.checks.find(check=>check.id===id).state,"ready",id);
  assert.equal(result.readiness.verificationLimits.hostHookTrust,"not_verified");
  assert.equal(result.readiness.verificationLimits.hostHookActivation,"not_verified");
  assert.equal(result.readiness.verificationLimits.deploymentLiveAcceptance,"not_verified");
  assert.equal(result.readiness.checks.find(check=>check.id==="code-index").state,"disabled");
  const contacted=count();assert.equal((await new SettingsBackend().main({action:"status"})).readiness.state,"blocked");assert.equal(count(),contacted);
  process.env.EDT_AI_INSTANCE="another";assert.equal((await backend.main({action:"read"})).readiness.state,"not_checked");process.env.EDT_AI_INSTANCE="first";
  f.profile.repositories[0].edt_project="Changed";f.save();assert.equal((await backend.main({action:"read"})).readiness.state,"stale");
});

test("disabled assigned authorities block readiness and old ready receipts are rejected", async t => {
  const { f, backend } = await ready_fixture(t), config = backend.effective(backend.current());
  config.mcp.managed["bsl-ls"].mode = "external";
  const external = { edt: { ready: true }, v8std: { ready: true } };
  const managed = ["code-index", "bsl-ls"].map(name => ({ name, state: "ready", ready: true }));
  const complete = save_readiness(f.state, config, f.profile, managed, external);
  assert.equal(complete.state, "blocked"); assert.equal(complete.checks.find(item => item.id === "bsl-ls").state, "not_verified");
  assert.equal(complete.checks.find(item => item.id === "knowledge").state, "disabled");
  for (const name of ["code-index", "bsl-ls"]) {
    const checks = managed.map(item => item.name === name ? { ...item, state: "disabled" } : item);
    assert.equal(save_readiness(f.state, config, f.profile, checks, external).state, "blocked", name);
    assert.equal((await read_readiness(f.state, config, f.profile)).state, "blocked", name);
    const file = path.join(instance_directory(f.state, f.root), "first.readiness.json");
    const old = JSON.parse(fs.readFileSync(file, "utf8")); old.result.state = "ready";
    fs.writeFileSync(file, JSON.stringify(old));
    const restored = await read_readiness(f.state, config, f.profile);
    assert.equal(restored.state, "not_checked", name);
    assert.match(restored.reason, /обязательным компонентам/);
  }
});

test("automatic readiness makes fresh probes without new launch grants or reconnecting relays",async t=>{
  const {f,backend,count,wrong}=await ready_fixture(t),scope=f.root+"#first";
  const first=await backend.main({action:"refresh_readiness",scope});assert.equal(first.componentChecks.length,7);
  const calls=count();wrong();
  const second=await backend.main({action:"refresh_readiness",scope});assert.ok(count()>calls);assert.equal(second.componentChecks.find(item=>item.id==="edt").state,"not_verified");
  assert.equal(second.external.edt.ready,false);
  const home=instance_directory(f.state,f.root);
  assert.equal(fs.existsSync(path.join(home,"first.preparation.json")),false);
  assert.equal(fs.existsSync(path.join(home,"first.reconnect.json")),false);
  const before=count();await assert.rejects(backend.main({action:"refresh_readiness",scope:f.root+"#another"}),/другой папке или экземпляру/);assert.equal(count(),before);
});

test("automatic readiness never prepares unapproved components or downloads missing runtimes",async t=>{
  const {f,backend}=await ready_fixture(t),scope=f.root+"#first";
  // Supply a Java probe fixture so Node-only PATH reaches the missing-JAR check.
  const config=backend.current();config.mcp.managed["bsl-ls"].java=process.execPath;
  fs.writeFileSync(f.env.EDT_AI_SETTINGS,JSON.stringify(config));
  const execFile=childProcess.execFile;
  t.mock.method(childProcess,"execFile",(command,args,options,callback)=>command===process.execPath&&args?.[0]==="-version"?queueMicrotask(()=>callback(null,"",'java version "21"')):execFile(command,args,options,callback));
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const download=t.mock.method(globalThis,"fetch",async()=>{throw new Error("Unexpected download");});
  await backend.main({action:"update",set:{codeIndexEnabled:true,bslLsEnabled:true,edtUrl:"",v8stdUrl:""}});
  const unprepared=await backend.main({action:"refresh_readiness",scope});
  for(const component of ["code-index","bsl-ls"]){const item=unprepared.managed.find(item=>item.name===component);assert.equal(item.ready,false);assert.match(item.detail,/недоступен|отсутствует/);}
  grant_preparation(f.state,f.root,["code-index","bsl-ls"]);
  const file=path.join(instance_directory(f.state,f.root),"first.preparation.json"),before=fs.readFileSync(file);
  const missing=await backend.main({action:"refresh_readiness",scope});
  for(const component of ["code-index","bsl-ls"]){const item=missing.managed.find(item=>item.name===component);assert.equal(item.ready,false);assert.match(item.detail,/недоступен|отсутствует|не установлен/);}
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
  process.env.EDT_AI_INSTANCE="another";
  const other=await backend.main({action:"refresh_readiness",scope:f.root+"#another"});assert.equal(other.managed.find(item=>item.name==="code-index").state,"stopped");
  assert.equal(download.mock.callCount(),0);
});

test("status reads and missing prepared artifacts never probe Java or start local services", async t => {
  const {f,backend,count}=await ready_fixture(t);
  const config=backend.current();config.mcp.managed["bsl-ls"].java=process.execPath;
  fs.writeFileSync(f.env.EDT_AI_SETTINGS,JSON.stringify(config));
  await backend.main({action:"update",set:{bslLsEnabled:true}});
  grant_preparation(f.state,f.root,["bsl-ls"]);
  const execute=t.mock.method(childProcess,"execFile",()=>{throw new Error("Unexpected Java probe");});
  const spawn=t.mock.method(childProcess,"spawn",()=>{throw new Error("Unexpected process launch");});
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  await backend.main({action:"status"});
  const calls=count(), result=await backend.main({action:"refresh_readiness",scope:f.root+"#first"});
  assert.ok(count()>calls);assert.equal(result.external.edt.ready,true);
  assert.equal(result.componentChecks.find(item=>item.id==="bsl-ls").state,"missing");
  assert.equal(execute.mock.callCount(),0);assert.equal(spawn.mock.callCount(),0);
});

test("a busy runtime lock does not stall automatic BSL observation", async t => {
  const { f, backend } = await ready_fixture(t);
  await backend.main({ action: "update", set: { bslLsEnabled: true } }); grant_preparation(f.state, f.root, ["bsl-ls"]);
  const lock = path.join(f.state, "operation.lock"); fs.writeFileSync(lock, String(process.pid));
  const started = Date.now();
  await assert.rejects(installed_runtime(f.state, backend.effective(backend.current()), "bsl-ls", false, false, 1), error => error.code === "RUNTIME_BUSY");
  assert.ok(Date.now() - started < 5000); fs.unlinkSync(lock);
  assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
});

test("local BSL compatibility survives setup expiry and unrelated changes without launching Java", async t => {
  const {f,backend,authorization}=await ready_fixture(t);
  await backend.main({action:"update",set:{bslLsEnabled:true,bslLsJava:process.execPath}});
  write_test_bsl_artifact(f);
  const config=backend.effective(backend.current());
  save_readiness(f.state,config,f.profile,[{name:"bsl-ls",state:"ready",ready:true,apiEvidenceVersion:1}],{});
  const saved=read_component_checks(f.state,config,f.profile).find(item=>item.id==="bsl-ls");
  assert.equal(saved.validity,"inputs");assert.equal(saved.expiresAt,null);
  const now=Date.now();t.mock.method(Date,"now",()=>now+20*60000);
  const execute=t.mock.method(childProcess,"execFile",()=>{throw new Error("Unexpected Java probe");});
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  f.profile.project.id="renamed";f.save();fs.writeFileSync(path.join(f.root,"src/Changed.bsl"),"// changed source");
  await backend.main({action:"update",set:{v8stdUrl:""}});
  for(let i=0;i<2;i++){
    const result=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"}),check=result.componentChecks[0];
    assert.equal(check.state,"ready");assert.equal(check.apiCompatible,true);assert.equal(check.checkedAt,saved.checkedAt);assert.equal(check.expiresAt,null);
    const current=await backend.main({action:"read"});assert.equal(current.readiness.state,"stale");
    assert.equal(current.summary.components.find(item=>item.id==="bsl-ls").status,"ready");
  }
  const repeated=await backend.main({action:"check",authorization});
  assert.equal(repeated.managed.find(item=>item.name==="bsl-ls").state,"ready");
  assert.equal(repeated.managed.find(item=>item.name==="bsl-ls").checkedAt,saved.checkedAt);
  assert.equal(execute.mock.callCount(),0);
});

test("malformed explicit BSL JSON is reported without launching Java or revealing its contents", async t => {
  const { f, backend, authorization } = await ready_fixture(t), configuration = path.join(f.root, "bsl-invalid.json");
  fs.writeFileSync(configuration, '{"secret":"synthetic-private-fixture",');
  await backend.main({ action: "update", set: { bslLsEnabled: true, bslLsJava: process.execPath } });
  write_test_bsl_artifact(f);
  const config = backend.current(); config.mcp.managed["bsl-ls"].configuration = configuration;
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(config));
  const spawn = childProcess.spawn; let launches = 0;
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    if (path.basename(args?.[0] || "") === "process_supervisor.mjs" && options.cwd === f.root) launches++;
    return spawn(command, args, options);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const passive = await backend.main({ action: "refresh_readiness", scope: f.root + "#first", component: "bsl-ls" });
  assert.equal(passive.componentChecks[0].state, "error"); assert.match(passive.componentChecks[0].detail, /некорректный JSON/);
  const manual = await backend.main({ action: "check", authorization });
  const result = manual.managed.find(item => item.name === "bsl-ls");
  assert.equal(result.state, "error"); assert.match(result.detail, /некорректный JSON/);
  assert.equal(launches, 0); assert.doesNotMatch(JSON.stringify({ passive, manual }), /synthetic-private-fixture/);
  fs.writeFileSync(configuration, Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}') ]));
  const invalidUtf8 = await backend.main({ action: "refresh_readiness", scope: f.root + "#first", component: "bsl-ls" });
  assert.equal(invalidUtf8.componentChecks[0].state, "error"); assert.match(invalidUtf8.componentChecks[0].detail, /некорректный JSON/);
  assert.equal(launches, 0);
});

testProtected("first BSL preparation accepts its own installation, reuses unchanged API evidence and rejects input races", async t => {
  const {f,backend,authorization}=await ready_fixture(t),configuration=path.join(f.root,"bsl.json");
  fs.writeFileSync(configuration,"{}");
  await backend.main({action:"update",set:{bslLsEnabled:true,bslLsJava:process.execPath}});
  const config=backend.current();Object.assign(config.mcp.managed["bsl-ls"],{node:process.execPath,configuration});
  fs.writeFileSync(f.env.EDT_AI_SETTINGS,JSON.stringify(config));
  const bytes=zip({"META-INF/MANIFEST.MF":Buffer.from("fixture")}),hash=sha256(bytes),fetch=globalThis.fetch;
  t.mock.method(globalThis,"fetch",(url,options)=>{
    if(String(url).startsWith("https://api.github.com/repos/1c-syntax/bsl-language-server/"))return Promise.resolve(new Response(JSON.stringify({tag_name:"v1.1.0",assets:[{
      name:"bsl-language-server-1.1.0-exec.jar",size:bytes.length,digest:"sha256:"+hash,browser_download_url:"https://github.com/1c-syntax/bsl-language-server/releases/download/v1.1.0/server.jar"}]})));
    if(String(url).startsWith("https://github.com/1c-syntax/bsl-language-server/releases/download/"))return Promise.resolve(new Response(bytes));
    return fetch(url,options);
  });
  const originalSpawn=childProcess.spawn,preload=new URL("./fixtures/bsl-smoke-spawn.mjs",import.meta.url).href;
  let launches=0,mutate=false;const pidFiles=[];
  t.mock.method(childProcess,"spawn",(command,args,options)=>{
    if(path.basename(args[0])!=="process_supervisor.mjs" || options.cwd!==f.root)return originalSpawn(command,args,options);
    if(mutate)fs.writeFileSync(configuration,'{"changed":"during-check"}');
    const pidFile=path.join(f.base,"bsl-"+(++launches)+".pid");pidFiles.push(pidFile);
    return originalSpawn(command,["--import",preload,...args],{...options,env:{...options.env,BSL_TEST_PID_FILE:pidFile}});
  });
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
  const first=await backend.main({action:"check",authorization}),bsl=first.managed.find(item=>item.name==="bsl-ls");
  assert.equal(bsl.state,"ready",bsl.detail);assert.equal(bsl.ready,true);assert.equal(bsl.apiCompatible,true);assert.match(bsl.detail,/не подтверждаются/);assert.equal(bsl.expiresAt,null);assert.equal(launches,1);
  const second=await backend.main({action:"check",authorization});assert.equal(second.managed.find(item=>item.name==="bsl-ls").checkedAt,bsl.checkedAt);assert.equal(launches,1);
  fs.writeFileSync(configuration,'{"changed":"before-check"}');mutate=true;
  const changed=await backend.main({action:"check",authorization}),invalid=changed.managed.find(item=>item.name==="bsl-ls");
  assert.equal(invalid.state,"check_stale");assert.equal(invalid.ready,false);assert.equal(launches,2);
  mutate=false;
  const refreshed=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"});
  assert.equal(refreshed.componentChecks[0].state,"not_verified");assert.equal(launches,2,"automatic observation must not start Java");
  const manual=await backend.main({action:"check",authorization});assert.equal(manual.managed.find(item=>item.name==="bsl-ls").state,"ready");assert.equal(launches,3);
  await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"});assert.equal(launches,3,"unchanged inputs must not start another JVM");
  fs.writeFileSync(configuration,'{"changed":"on-disk"}');
  const refreshedAgain=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"});
  assert.equal(refreshedAgain.componentChecks[0].state,"not_verified");assert.equal(launches,3,"changed inputs do not authorize a background JVM");
  const rechecked=await backend.main({action:"check",authorization});assert.equal(rechecked.managed.find(item=>item.name==="bsl-ls").state,"ready");assert.equal(launches,4);
  await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"});assert.equal(launches,4);
  for(const file of pidFiles)assert.equal(fs.readFileSync(file+".closed","utf8"),"closed", "the observed JVM fixture closed its own input");
});

test("local BSL evidence follows its launch inputs and a passive refresh cannot rebase invalid evidence", async t => {
  const {f,backend}=await ready_fixture(t);
  const java=path.join(f.base,process.platform==="win32"?"java.exe":"java"),configuration=path.join(f.root,"bsl.json"),jar=write_test_bsl_artifact(f),jarBytes=fs.readFileSync(jar);
  fs.writeFileSync(java,"java-a",{mode:0o755});fs.writeFileSync(configuration,"{}");
  await backend.main({action:"update",set:{bslLsEnabled:true,bslLsJava:java}});
  const settings=backend.current();settings.mcp.managed["bsl-ls"].configuration=configuration;
  fs.writeFileSync(f.env.EDT_AI_SETTINGS,JSON.stringify(settings));
  const lock=path.join(f.state,"runtime-lock.json"),record=JSON.parse(fs.readFileSync(lock,"utf8"))["bsl-ls"];
  const config=backend.effective(backend.current()),proof=save_component_checks(f.state,config,f.profile,[{id:"bsl-ls",state:"ready"}])[0];
  const state=()=>read_component_checks(f.state,config,f.profile)[0].state;
  for(const [file,changed,original]of [[jar,"jar-b",jarBytes],[java,"java-b","java-a"],[configuration,'{"changed":true}',"{}"]]){
    fs.writeFileSync(file,changed);assert.equal(state(),"check_stale");fs.writeFileSync(file,original);
    save_component_checks(f.state,config,f.profile,[{id:"bsl-ls",state:"ready"}]);assert.equal(state(),"not_verified");
  }
  fs.writeFileSync(lock,JSON.stringify({"bsl-ls":record,"code-index":{release:"changed"}}));assert.equal(state(),"not_verified");
  config.mcp.managed["bsl-ls"].node="missing-node-fixture";assert.equal(state(),"check_stale");config.mcp.managed["bsl-ls"].node=settings.mcp.managed["bsl-ls"].node;
  config.mcp.managed["bsl-ls"].configuration="../outside.json";assert.equal(state(),"check_stale");config.mcp.managed["bsl-ls"].configuration=configuration;
  const oldOptions=process.env.JAVA_TOOL_OPTIONS;process.env.JAVA_TOOL_OPTIONS="-Dfixture=changed";assert.equal(state(),"check_stale");
  if(oldOptions===undefined)delete process.env.JAVA_TOOL_OPTIONS;else process.env.JAVA_TOOL_OPTIONS=oldOptions;
  fs.writeFileSync(configuration,'{"changed":true}');
  const receiptFile=path.join(instance_directory(f.state,f.root),"first.readiness.json"),before=fs.readFileSync(receiptFile,"utf8");
  const result=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component:"bsl-ls"});
  assert.equal(result.componentChecks[0].state,"not_verified");
  assert.equal(result.componentChecks[0].lastCheckedAt,JSON.parse(before).components["bsl-ls"].result.checkedAt);
  fs.writeFileSync(configuration,"{}");assert.equal(state(),"check_stale");
  process.env.EDT_AI_INSTANCE="another";assert.deepEqual(read_component_checks(f.state,config,f.profile),[]);
});

test("external BSL checks keep their time limit and local legacy evidence is not promoted", async t => {
  const {f,backend}=await ready_fixture(t),config=backend.effective(backend.current());
  config.mcp.managed["bsl-ls"].mode="external";
  const saved=save_component_checks(f.state,config,f.profile,[{id:"bsl-ls",state:"ready"}])[0];
  assert.equal(saved.state,"not_verified");assert.equal(saved.apiCompatible,false);assert.ok(saved.expiresAt);assert.equal(saved.validity,undefined);
  const now=Date.now();t.mock.method(Date,"now",()=>now+20*60000);
  assert.equal(read_component_checks(f.state,config,f.profile)[0].state,"check_stale");
  config.mcp.managed["bsl-ls"].mode="auto";
  assert.equal(read_component_checks(f.state,config,f.profile)[0].state,"check_stale");
});

test("stale local and external BSL API evidence never claims ready", async t => {
  const { f, backend } = await ready_fixture(t); write_test_bsl_artifact(f);
  for (const mode of ["auto", "external"]) {
    const config = backend.effective(backend.current());
    Object.assign(config.mcp.managed["bsl-ls"], { enabled: true, mode, java: process.execPath, url: "http://127.0.0.1:31001/mcp" });
    save_component_checks(f.state, config, f.profile, [{ id: "bsl-ls", state: "ready", apiEvidenceVersion: 1 }]);
    assert.equal(read_component_checks(f.state, config, f.profile).find(item => item.id === "bsl-ls").ready, true);
    const changed = structuredClone(config);
    if (mode === "auto") changed.mcp.managed["bsl-ls"].java = "changed-java";
    else changed.mcp.managed["bsl-ls"].url = "http://127.0.0.1:31002/mcp";
    const stale = read_component_checks(f.state, changed, f.profile).find(item => item.id === "bsl-ls");
    assert.equal(stale.state, "check_stale"); assert.equal(stale.ready, false);
  }
});

test("managed refresh does not renew expired index proof or relaunch an unchanged BSL", async t => {
  const {f,backend}=await ready_fixture(t);
  await backend.main({action:"update",set:{codeIndexEnabled:true,bslLsEnabled:true,bslLsJava:process.execPath}});
  write_test_bsl_artifact(f);
  const config=backend.effective(backend.current()),home=path.join(project_directory(f.state,f.root),"code-index");
  fs.mkdirSync(home,{recursive:true});fs.writeFileSync(path.join(home,"daemon.json"),JSON.stringify({pid:process.pid,http_port:45678}));
  const fetch=globalThis.fetch;
  t.mock.method(globalThis,"fetch",(url,options)=>String(url)==="http://127.0.0.1:45678/health"?Promise.resolve(new Response(JSON.stringify({pid:process.pid,status:"running",paths:[]}))):fetch(url,options));
  save_readiness(f.state,config,f.profile,[{name:"code-index",state:"stale",ready:false},{name:"bsl-ls",state:"ready",ready:true,apiEvidenceVersion:1}],{edt:{ready:true},v8std:{ready:true}});
  const file=path.join(instance_directory(f.state,f.root),"first.readiness.json"),receipt=JSON.parse(fs.readFileSync(file,"utf8"));
  const observedAt=Date.now(),checkedAt=new Date(observedAt-16*60000).toISOString(),expiresAt=new Date(observedAt-60000).toISOString();
  receipt.result.checkedAt=checkedAt;receipt.result.expiresAt=expiresAt;fs.writeFileSync(file,JSON.stringify(receipt));
  // Reproduce the old loop: a newer liveness-only observation used to hide
  // the older setup API result as soon as its 15-minute validity expired.
  save_component_checks(f.state,config,f.profile,[{id:"code-index",state:"running"}]);
  const spawn=t.mock.method(childProcess,"spawn",()=>{throw new Error("Unexpected service launch");});syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  for(const component of ["code-index","bsl-ls"]){
    const result=await backend.main({action:"refresh_readiness",scope:f.root+"#first",component}),check=result.componentChecks[0];
    assert.equal(check.state,component==="bsl-ls"?"ready":"running");
    if(component==="code-index"){assert.ok(Date.parse(check.checkedAt)>Date.parse(checkedAt));assert.match(check.detail,/актуальность индекса.*не подтверждена/i);}
    else assert.equal(check.expiresAt,null);
    const saved=(await backend.main({action:"read"})).componentChecks.find(item=>item.id===component);
    assert.equal(saved.state,check.state);
  }
  assert.equal(spawn.mock.callCount(),0);
  process.env.EDT_AI_INSTANCE="another";
  const other=await backend.main({action:"probe",component:"bsl-ls"});assert.equal(other.componentChecks[0].state,"not_verified");
});

async function live_index_fixture(t) {
  const { f, backend } = await ready_fixture(t);
  await backend.main({ action: "update", set: { codeIndexEnabled: true } });
  const home = path.join(project_directory(f.state, f.root), "code-index"), binary = Buffer.from("managed index fixture");
  const exe = path.join(f.state, "runtime/code-index/fixture", sha256(binary), "bsl-indexer.exe");
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, binary);
  fs.mkdirSync(home, { recursive: true }); index_config(home, f.root, f.profile);
  fs.mkdirSync(path.join(f.root, ".code-index")); fs.writeFileSync(path.join(f.root, ".code-index/index.db"), "existing");
  let connections = 0, peakConnections = 0;
  const daemon = createServer((req, res) => {
    assert.equal(req.method, "GET"); assert.equal(req.url, "/health");
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ pid: process.pid, status: "running", started_at: "fixture-daemon-start", paths: [{ path: f.root, status: "ready" }] }));
  });
  daemon.on("connection", socket => { connections++; peakConnections = Math.max(peakConnections, connections); socket.once("close", () => { connections--; }); });
  // This fixture substitutes a Node HTTP server for the native daemon. The
  // kernel process/socket ownership check is exercised separately.
  t.mock.method(IndexObserver.prototype, "verifyDaemon", () => "fixture-process-identity");
  daemon.listen(0, "127.0.0.1"); await once(daemon, "listening"); daemon.unref();
  t.after(() => { daemon.closeAllConnections(); return new Promise(done => daemon.close(done)); });
  fs.writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ pid: process.pid, http_port: daemon.address().port }));
  fs.writeFileSync(path.join(home, "owner.json"), JSON.stringify({ pid: process.pid, project_root: f.root, executable: exe }));
  const spawn = childProcess.spawn, reader = fileURLToPath(new URL("./fixtures/index-reader.mjs", import.meta.url)), starts = []; let onReaderLaunch;
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    if (options.cwd !== home) return spawn(command, args, options);
    assert.equal(path.basename(args[0]), "process_supervisor.mjs", "observation must not launch a daemon");
    const child = spawn(command, args, options), send = child.send.bind(child);
    child.send = (message, ...rest) => {
      if (message.command) {
        onReaderLaunch?.(message, child);
        assert.equal(message.command, exe);
        assert.deepEqual(fs.readFileSync(message.command), binary);
        assert.equal(message.args[0], "serve"); assert.equal(message.args[1], "--config");
        assert.equal(message.args[2], path.join(home, "daemon.toml"));
        assert.equal(message.env.CODE_INDEX_HOME, home);
        assert.deepEqual(fs.readFileSync(message.args[2]), fs.readFileSync(path.join(home, "daemon.toml")));
        starts.push(message);
        message = { ...message, command: process.execPath, args: [reader], env: { ...message.env, CODE_INDEX_FIXTURE_HOME: home } };
      }
      return send(message, ...rest);
    };
    return child;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, options) => {
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:/, "observation must not download or query releases");
    return fetch(url, options);
  });
  const health = (status = "ready", stale = false) => ({ mcp: { status: "ok" }, daemon: { status: "online" },
    repos: [{ repo: "product", root_path: f.root, path_status: { status }, data_version: { stale } }] });
  const setHealth = (...results) => fs.writeFileSync(path.join(home, "health-fixture.json"), JSON.stringify({ results }));
  const refresh = () => backend.main({ action: "refresh_readiness", scope: f.root + "#first", component: "code-index" });
  return { f, backend, home, exe, starts, health, setHealth, refresh, onReaderLaunch: callback => { onReaderLaunch = callback; }, connections: () => ({ active: connections, peak: peakConnections }) };
}

test("a replacement index process cannot inherit the previous process API proof", async t => {
  const {f,backend,home,refresh}=await live_index_fixture(t),config=backend.effective(backend.current());
  save_component_checks(f.state,config,f.profile,[{id:"code-index",state:"ready"}]);
  const unchanged=await refresh();assert.equal(unchanged.componentChecks[0].state,"not_verified","liveness cannot prove that a PID was not reused");
  save_component_checks(f.state,config,f.profile,[{id:"code-index",state:"ready"}]);
  const daemonFile=path.join(home,"daemon.json"),daemon=JSON.parse(fs.readFileSync(daemonFile,"utf8"));
  daemon.pid+=1;fs.writeFileSync(daemonFile,JSON.stringify(daemon));
  const fetch=globalThis.fetch;
  t.mock.method(globalThis,"fetch",(url,options)=>String(url).endsWith("/health")
    ? Promise.resolve(new Response(JSON.stringify({pid:daemon.pid,status:"running",paths:[{path:f.root,status:"ready"}]}),{status:200,headers:{"content-type":"application/json"}}))
    : fetch(url,options));
  const result=await refresh();assert.equal(result.componentChecks[0].state,"not_verified");assert.equal(result.managed[0].ready,false);
});

testProtected("prepared index refresh replaces liveness and cached results with current read-only API evidence", async t => {
  const { f, backend, home, starts, health, setHealth, refresh } = await live_index_fixture(t);
  const config = backend.effective(backend.current()), files = ["daemon.json", "owner.json", "daemon.toml"];
  const before = files.map(file => fs.readFileSync(path.join(home, file)));
  grant_preparation(f.state, f.root, ["code-index"]);
  save_component_checks(f.state, config, f.profile, [{ id: "code-index", state: "running" }]);
  setHealth(health("initial_indexing"), health());
  let result = await refresh();
  assert.equal(result.managed[0].state, "ready", result.managed[0].detail);
  assert.equal(result.managed[0].ready, true); assert.equal(result.componentChecks[0].repositories[0].state, "ready");
  const events = () => fs.readFileSync(path.join(home, "reader-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events().filter(event => event.method === "tools/call").length, 2, "a building index is observed again before reporting readiness");
  for (const [body, expected] of [[health("ready", true), "stale"], [health(), "ready"],
    [{ isError: true, content: [{ type: "text", text: "private external error" }] }, "error"],
    [{ ...health(), repos: [{ ...health().repos[0], root_path: f.base }] }, "mismatch"]]) {
    setHealth(body); result = await refresh();
    assert.equal(result.managed[0].state, expected, result.managed[0].detail);
    const current = await backend.main({ action: "read" });
    assert.equal(current.componentChecks.find(item => item.id === "code-index").state, expected);
    assert.doesNotMatch(JSON.stringify(result), /private external error/);
  }
  for (const event of events()) assert.equal(alive(event.pid), false, "temporary readers must close before the check completes");
  assert.equal(starts.length, 5);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(home, file)), before[i]));
  assert.deepEqual(fs.readdirSync(path.join(home, "readers")), []);
  assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
  assert.equal((await backend.main({ action: "read" })).readiness.state, "not_checked");
});

testProtected("concurrent local index observations share a single native client", async t => {
  const { f, starts, health, setHealth, refresh } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const request = McpClient.prototype.request; let enter, release;
  const entered = new Promise(done => { enter = done; }), gate = new Promise(done => { release = done; });
  t.after(() => release());
  t.mock.method(McpClient.prototype, "request", async function (method, params, options) {
    if (method === "tools/call" && params?.name === "health") { enter(); await gate; }
    return request.call(this, method, params, options);
  });
  const first = refresh(); await entered;
  const second = new SettingsBackend().main({ action: "refresh_readiness", scope: f.root + "#first", component: "code-index" });
  await new Promise(done => setTimeout(done, 300)); assert.equal(starts.length, 1);
  release(); const [a, b] = await Promise.all([first, second]);
  assert.equal(a.superseded, false); assert.equal(b.superseded, false);
  assert.equal(a.componentChecks[0].state, "ready"); assert.equal(b.componentChecks[0].state, "ready");
  assert.equal(starts.length, 1);
});

test("a joined index check accepts the leader's verified daemon startup", async t => {
  const { f, home } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]);
  let entered, release, extraProbes = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const leader = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS, {
    observeIndex: async ({ root, profile }) => {
      entered(); await gate;
      // Simulate the daemon files written by a cold start after both checks
      // have captured the original project binding.
      fs.appendFileSync(path.join(home, "daemon.json"), " ");
      return { index_state: "ready", index: { repositories: [] }, observationSnapshot: capture_index_snapshot(f.state, root, profile) };
    },
  });
  const follower = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS, {
    observeIndex: async () => { extraProbes++; throw new Error("The follower launched a duplicate probe"); },
  });
  const request = { action: "refresh_readiness", scope: f.root + "#first", component: "code-index" };
  const first = leader.main(request); await started;
  const second = follower.main(request);
  await new Promise(resolve => setTimeout(resolve, 300));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.superseded, false, JSON.stringify(a));
  assert.equal(b.superseded, false, JSON.stringify(b));
  assert.equal(b.componentChecks[0].state, "ready");
  assert.equal(extraProbes, 0);
});

test("joined index checks reject a configuration change during daemon startup", async t => {
  const { f, backend, home } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const leader = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS, {
    observeIndex: async ({ root, profile }) => {
      entered(); await gate;
      fs.appendFileSync(path.join(home, "daemon.json"), " ");
      return { index_state: "ready", index: { repositories: [] }, observationSnapshot: capture_index_snapshot(f.state, root, profile) };
    },
  });
  const request = { action: "refresh_readiness", scope: f.root + "#first", component: "code-index" };
  const first = leader.main(request); await started;
  const second = new SettingsBackend().main(request);
  await new Promise(resolve => setTimeout(resolve, 300));
  await backend.main({ action: "update", set: { codeIndexEnabled: false } });
  release();
  for (const result of await Promise.all([first, second])) assert.equal(result.superseded, true, JSON.stringify(result));
});

test("Windows observer cleans up when the source runtime already has a writer", { skip: process.platform !== "win32" }, async t => {
  const { f, backend, home, exe, starts, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const observer = new IndexObserver(f.state), config = backend.effective(backend.current());
  f.clients.push(observer);
  const writer = fs.openSync(exe, "r+");
  try { await assert.rejects(observer.observe(config, f.root, f.profile), /Cannot pin file path/); }
  finally { fs.closeSync(writer); }
  assert.deepEqual(await active_readers(f.state, f.root), []);
  assert.deepEqual(fs.readdirSync(home).filter(name => name.startsWith(".observation-")), []);
  assert.equal(starts.length, 0);
  assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  assert.equal(starts.length, 1);
});

test("Linux rejects a runtime changed during a live index check", { skip: process.platform !== "linux" }, async t => {
  const { f, backend, exe, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const observer = new IndexObserver(f.state), original = fs.readFileSync(exe), request = McpClient.prototype.request;
  f.clients.push(observer);
  let changed = false;
  t.mock.method(McpClient.prototype, "request", function (method, params, options) {
    if (!changed && method === "tools/call" && params?.name === "health") { changed = true; fs.writeFileSync(exe, "changed runtime"); }
    return request.call(this, method, params, options);
  });
  try {
    await assert.rejects(observer.observe(backend.effective(backend.current()), f.root, f.profile), /исполняемый файл|изменилась/);
    assert.equal(changed, true);
  } finally { fs.writeFileSync(exe, original); }
});

test("Linux retries an index observation if its configuration changes and is restored", { skip: process.platform !== "linux" }, async t => {
  const { f, backend, home, starts, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const observer = new IndexObserver(f.state), request = McpClient.prototype.request, file = path.join(home, "daemon.toml");
  const original = fs.readFileSync(file); let changed = false;
  f.clients.push(observer);
  t.mock.method(McpClient.prototype, "request", function (method, params, options) {
    const result = request.call(this, method, params, options);
    if (!changed && method === "tools/call" && params?.name === "health") {
      changed = true; fs.writeFileSync(file, "temporary configuration"); fs.writeFileSync(file, original);
    }
    return result;
  });
  assert.equal((await observer.observe(backend.effective(backend.current()), f.root, f.profile)).index_state, "ready");
  assert.equal(changed, true);
  assert.equal(starts.length, 2, "the observation that used changing inputs must be discarded and repeated");
});

testProtected("a session reuses one verified native reader and rehashes only on a new launch", async t => {
  const { f, backend, home, starts, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const config = backend.effective(backend.current()), observer = new IndexObserver(f.state);
  f.clients.push(observer); t.after(() => observer.close());
  for (let i = 0; i < 3; i++) assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  assert.equal(starts.length, 1);
  const readers = await active_readers(f.state, f.root); assert.equal(readers.length, 1);
  const [reader] = readers;
  assert.equal(reader.snapshotMayExist, undefined);
  const owner = path.join(home, "owner.json"), changed = JSON.parse(fs.readFileSync(owner, "utf8")); changed.generation = randomUUID(); fs.writeFileSync(owner, JSON.stringify(changed));
  assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  assert.equal(starts.length, 2);
  await observer.close(); assert.deepEqual(await active_readers(f.state, f.root), []);
});

testProtected("separate settings sessions keep independent reusable readers", async t => {
  const { f, backend, starts, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const config = backend.effective(backend.current()), first = new IndexObserver(f.state), second = new IndexObserver(f.state);
  f.clients.push(first, second);
  for (let i = 0; i < 8; i++) {
    const observer = i % 2 ? second : first;
    assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
    assert.equal((await active_readers(f.state, f.root)).length, Math.min(i + 1, 2));
  }
  assert.equal(starts.length, 2);
  const otherId = second.entry.lease.id;
  await first.close();
  assert.deepEqual((await active_readers(f.state, f.root)).map(reader => reader.id), [otherId]);
  assert.equal((await second.observe(config, f.root, f.profile)).index_state, "ready");
  assert.equal(starts.length, 2);
  await second.close(); assert.deepEqual(await active_readers(f.state, f.root), []);
});

testProtected("a reusable index reader waits for a short lock and rejects a retained lock", async t => {
  const { f, backend, home, starts, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const config = backend.effective(backend.current()), observer = new IndexObserver(f.state), lock = path.join(home, "operation.lock");
  let release;
  f.clients.push({ close: async () => { clearTimeout(release); fs.rmSync(lock, { force: true }); } }, observer);
  assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
  release = setTimeout(() => fs.rmSync(lock, { force: true }), 150);
  assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  assert.equal(starts.length, 1, "a short coordination lock must not replace the reader");
  fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
  const rejected = assert.rejects(observer.observe(config, f.root, f.profile), error => error.code === "INDEX_BUSY");
  const deadline = Date.now() + 10000;
  while (observer.entry && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
  const retired = observer.entry === null;
  fs.rmSync(lock, { force: true });
  await rejected;
  assert.equal(retired, true, "a retained lock must retire the cached reader");
  assert.equal(starts.length, 1, "a retained lock must not authorize a cached observation");
  assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  assert.equal(starts.length, 2);
});

testProtected("repeated index checks keep daemon connections bounded and release them", { timeout: 25000 }, async t => {
  const { f, backend, starts, health, setHealth, connections } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const observer = new IndexObserver(f.state), config = backend.effective(backend.current());
  f.clients.push(observer); t.after(() => observer.close());
  for (let i = 0; i < 20; i++) assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  assert.equal(starts.length, 1);
  assert.ok(connections().peak <= 4, `daemon connection count grew to ${connections().peak}`);
  await observer.close();
  for (let i = 0; i < 280 && connections().active; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(connections().active, 0, "idle daemon connections must close within the server deadline");
});

testProtected("failed reader cleanup leaves an orphan barrier and does not leave its lease listener active", async t => {
  const { f, backend, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const config = backend.effective(backend.current()), observer = new IndexObserver(f.state);
  assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  const failedClient = observer.entry.client, close = McpClient.prototype.close;
  t.mock.method(McpClient.prototype, "close", async function (...args) {
    await close.apply(this, args);
    if (this === failedClient) throw Object.assign(new Error("termination confirmation failed"), { outcomeUnknown: true });
  });
  const closing = observer.close(); assert.equal(observer.close(), closing);
  await assert.rejects(closing, /termination confirmation failed/);
  await assert.rejects(observer.close(), /termination confirmation failed/);
  const readers = await active_readers(f.state, f.root);
  assert.equal(readers.length, 1); assert.equal(readers[0].orphaned, true);
  const other = new IndexObserver(f.state);
  assert.equal((await other.observe(config, f.root, f.profile)).index_state, "ready");
  await other.close();
});

testProtected("a closing reader does not block a different session", async t => {
  const { f, backend, starts, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const config = backend.effective(backend.current()), first = new IndexObserver(f.state), second = new IndexObserver(f.state);
  f.clients.push(first, second);
  t.after(async () => { await first.close(); await second.close(); });
  assert.equal((await first.observe(config, f.root, f.profile)).index_state, "ready");
  const originalClient = first.entry.client, close = McpClient.prototype.close; let entered, release;
  const blocked = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(McpClient.prototype, "close", async function (...args) {
    if (this === originalClient) { entered(); await gate; }
    return close.apply(this, args);
  });
  const closing = first.close(); await blocked;
  const pending = second.observe(config, f.root, f.profile);
  assert.equal((await pending).index_state, "ready");
  assert.equal(starts.length, 2, "the independent reader can start while the first closes");
  release(); await closing;
});

testProtected("an independent reader starts while another reader's close is delayed", async t => {
  const { f, backend, starts, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const config = backend.effective(backend.current()), first = new IndexObserver(f.state), second = new IndexObserver(f.state);
  f.clients.push(first, second);
  t.after(async () => { await first.close(); await second.close(); });
  assert.equal((await first.observe(config, f.root, f.profile)).index_state, "ready");
  const mark = first.entry.lease.markClosing; let entered, release;
  const blocked = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  first.entry.lease.markClosing = async () => { entered(); await gate; return mark(); };
  const closing = first.close(); await blocked;
  const pending = second.observe(config, f.root, f.profile);
  assert.equal((await pending).index_state, "ready"); assert.equal(starts.length, 2);
  release(); await closing;
});

for (const change of ["disable", "revoke"]) testProtected(`an idle index reader closes when its ${change} input changes`, async t => {
  const { f, backend, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const config = backend.effective(backend.current()), observer = new IndexObserver(f.state);
  f.clients.push(observer); t.after(() => observer.close());
  assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  if (change === "disable") await backend.main({ action: "update", set: { codeIndexEnabled: false } });
  else fs.unlinkSync(path.join(instance_directory(f.state, f.root), "first.preparation.json"));
  for (let i = 0; i < 80 && (await active_readers(f.state, f.root)).length; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(await active_readers(f.state, f.root), []);
});

testProtected("unrelated settings do not restart or rehash an idle index reader", async t => {
  const { f, backend, starts, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const observer = new IndexObserver(f.state);
  f.clients.push(observer); t.after(() => observer.close());
  const first = backend.effective(backend.current());
  assert.equal((await observer.observe(first, f.root, f.profile)).index_state, "ready");
  await backend.main({ action: "update", set: { v8stdUrl: "http://127.0.0.1:19876/other" } });
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal((await active_readers(f.state, f.root)).length, 1);
  assert.equal((await observer.observe(backend.effective(backend.current()), f.root, f.profile)).index_state, "ready");
  assert.equal(starts.length, 1);
});

testProtected("an unrelated BSL runtime update does not restart or rehash the index reader", async t => {
  const { f, backend, starts, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const observer = new IndexObserver(f.state);
  f.clients.push(observer); t.after(() => observer.close());
  const config = backend.effective(backend.current());
  assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  fs.writeFileSync(path.join(f.state, "runtime-lock.json"), JSON.stringify({ "bsl-ls": { release: "fixture" } }));
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  assert.equal(starts.length, 1);
});

testProtected("granting BSL preparation preserves index readiness and its live reader", async t => {
  const { f, backend, starts, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const observer = new IndexObserver(f.state);
  f.clients.push(observer); t.after(() => observer.close());
  const config = backend.effective(backend.current());
  assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  save_component_checks(f.state, config, f.profile, [{ id: "code-index", state: "ready" }]);
  grant_preparation(f.state, f.root, ["bsl-ls"]);
  assert.equal(read_component_checks(f.state, config, f.profile).find(item => item.id === "code-index").state, "ready");
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  assert.equal(starts.length, 1);
});

testProtected("an unrelated grant during an index check discards the result but keeps its reader", async t => {
  const { f, backend, starts, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const observer = new IndexObserver(f.state);
  f.clients.push(observer); t.after(() => observer.close());
  const config = backend.effective(backend.current());
  assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  const request = McpClient.prototype.request; let entered, release, delayed = false;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(McpClient.prototype, "request", async function (method, params, options) {
    if (!delayed && method === "tools/call" && params?.name === "health") { delayed = true; entered(); await gate; }
    return request.call(this, method, params, options);
  });
  const pending = observer.observe(config, f.root, f.profile); await started;
  grant_preparation(f.state, f.root, ["bsl-ls"]); release();
  await assert.rejects(pending, error => error.inputsChanged === true);
  assert.equal((await active_readers(f.state, f.root)).length, 1);
  assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  assert.equal(starts.length, 1);
});

testProtected("a synchronous reader spawn failure does not leave an orphan barrier", async t => {
  const { f, backend, home, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    if (options.cwd === home) throw new Error("simulated spawn failure");
    return spawn(command, args, options);
  });
  syncBuiltinESMExports();
  const observer = new IndexObserver(f.state), config = backend.effective(backend.current());
  f.clients.push(observer); t.after(() => observer.close());
  await assert.rejects(observer.observe(config, f.root, f.profile), /simulated spawn failure/);
  assert.deepEqual(await active_readers(f.state, f.root), []);
});

test("repeated index reader lifecycles do not accumulate process handles or descriptors", { timeout: 30000, skip: process.platform === "darwin" }, async t => {
  const { f, backend, home, starts, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const count = () => process.platform === "win32" ? windows_handle_count() : fs.readdirSync("/proc/self/fd").length;
  const before = count(), config = backend.effective(backend.current());
  for (let i = 0; i < 6; i++) {
    const observer = new IndexObserver(f.state); f.clients.push(observer);
    assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
    await observer.close(); assert.deepEqual(await active_readers(f.state, f.root), []);
  }
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(starts.length, 6);
  assert.ok(count() - before <= 8, "reader handles must be released");
  assert.deepEqual(fs.readdirSync(home).filter(name => name.startsWith(".observation-")), []);
});

testProtected("index maintenance closes an idle cached reader before restarting the daemon", async t => {
  const { f, backend, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const config = backend.effective(backend.current()), observer = new IndexObserver(f.state), calls = [];
  f.clients.push(observer); t.after(() => observer.close());
  assert.equal((await observer.observe(config, f.root, f.profile)).index_state, "ready");
  assert.equal((await active_readers(f.state, f.root)).length, 1);
  await restart_index(f.state, config, f.root, f.profile, { installed: async () => "fixture", stop: async () => calls.push("stop"),
    restart: async () => calls.push("restart"), smoke: async () => ({ index_ready: true }) });
  assert.deepEqual(calls, ["stop", "restart"]); assert.deepEqual(await active_readers(f.state, f.root), []);
});

testProtected("revoking the local index preparation grant invalidates an in-flight observation", async t => {
  const { f, health, setHealth, refresh } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const request = McpClient.prototype.request; let enter, release;
  const entered = new Promise(done => { enter = done; }), gate = new Promise(done => { release = done; });
  t.after(() => release());
  t.mock.method(McpClient.prototype, "request", async function (method, params, options) {
    if (method === "tools/call" && params?.name === "health") { enter(); await gate; }
    return request.call(this, method, params, options);
  });
  const pending = refresh(); await entered;
  fs.unlinkSync(path.join(instance_directory(f.state, f.root), "first.preparation.json")); release();
  assert.equal((await pending).superseded, true);
});

test("a revoked grant cannot be used after daemon health even if its bytes are restored", async t => {
  const { f, backend, starts, health, setHealth } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const file = path.join(instance_directory(f.state, f.root), "first.preparation.json"), grant = fs.readFileSync(file);
  const fetch = globalThis.fetch; let revoked = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (!revoked && String(url).endsWith("/health")) { fs.unlinkSync(file); revoked = true; }
    return response;
  });
  const observer = new IndexObserver(f.state), config = backend.effective(backend.current());
  t.after(async () => { if (fs.existsSync(path.dirname(file)) && !fs.existsSync(file)) fs.writeFileSync(file, grant); await observer.close(); });
  await assert.rejects(observer.observe(config, f.root, f.profile));
  assert.equal(revoked, true); assert.equal(starts.length, 0, "a revoked grant cannot start a native reader");
  fs.writeFileSync(file, grant);
  assert.deepEqual(await active_readers(f.state, f.root), []);
});

testProtected("a grant removed and restored during health dispatch cannot publish ready", async t => {
  const { f, health, setHealth, refresh } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const file = path.join(instance_directory(f.state, f.root), "first.preparation.json"), grant = fs.readFileSync(file);
  const request = McpClient.prototype.request; let changed = false;
  t.mock.method(McpClient.prototype, "request", function (method, params, options) {
    if (!changed && method === "tools/call" && params?.name === "health") {
      changed = true; fs.unlinkSync(file);
      try { return request.call(this, method, params, options); }
      finally { fs.writeFileSync(file, grant); }
    }
    return request.call(this, method, params, options);
  });
  const result = await refresh();
  assert.equal(changed, true);
  assert.equal(result.superseded, true);
  assert.notEqual(result.componentChecks[0]?.state, "ready");
});

test("an index daemon changed and restored before commit cannot prove the original daemon ready", async t => {
  const { f, backend, home, health, setHealth, refresh } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const file = path.join(home, "daemon.json"), reachable = fs.readFileSync(file, "utf8"), unavailable = JSON.parse(reachable);
  unavailable.http_port = 1; const original = JSON.stringify(unavailable); fs.writeFileSync(file, original);
  const invoke = backend.main.bind(backend);
  backend.main = async (request, progress, context) => {
    if (request.action !== "probe" || request.component !== "code-index") return invoke(request, progress, context);
    fs.writeFileSync(file, reachable);
    try { return await invoke(request, progress, context); }
    finally { fs.writeFileSync(file, original); }
  };
  const result = await refresh();
  assert.ok(result.superseded || result.componentChecks[0].state !== "ready", "the captured unreachable daemon cannot yield ready");
  const saved = (await backend.main({ action: "read" })).componentChecks.find(item => item.id === "code-index");
  assert.notEqual(saved?.state, "ready");
});

test("a daemon swapped after probe dispatch cannot prove the original daemon ready", async t => {
  const { f, backend, home, health, setHealth, refresh } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const file = path.join(home, "daemon.json"), reachable = fs.readFileSync(file, "utf8");
  const original = JSON.stringify({ ...JSON.parse(reachable), http_port: 1 }); fs.writeFileSync(file, original);
  const fetch = globalThis.fetch; let swaps = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === "http://127.0.0.1:1/health") {
      swaps++; fs.writeFileSync(file, reachable);
      return new Response(JSON.stringify({ pid: process.pid, status: "running", paths: [{ path: f.root, status: "ready" }] }), { headers: { "Content-Type": "application/json" } });
    }
    return fetch(url, options);
  });
  const invoke = backend.main.bind(backend);
  backend.main = async (request, progress, context) => {
    if (request.action !== "probe" || request.component !== "code-index" || !request.collectOnly) return invoke(request, progress, context);
    try { return await invoke(request, progress, context); }
    finally { fs.writeFileSync(file, original); }
  };
  const result = await refresh(); assert.equal(swaps, 1); assert.equal(result.superseded, true);
  const saved = (await backend.main({ action: "read" })).componentChecks.find(item => item.id === "code-index");
  assert.notEqual(saved?.state, "ready");
});

testProtected("an unconfirmed native client shutdown retains the index reader barrier", async t => {
  const { f, home, health, setHealth, refresh } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  const close = McpClient.prototype.close;
  t.mock.method(McpClient.prototype, "close", async function () {
    await close.call(this);
    throw Object.assign(new Error("Owned process termination is not confirmed"), { outcomeUnknown: true });
  });
  await assert.rejects(refresh(), error => error.outcomeUnknown === true && error.cleanupUnconfirmed === true);
  const directory = path.join(home, "readers"), files = fs.readdirSync(directory).filter(file => file.endsWith(".json"));
  assert.equal(files.length, 1);
  const reader = JSON.parse(fs.readFileSync(path.join(directory, files[0])));
  assert.equal(reader.orphanedBarrier, true);
  if (process.platform === "linux")
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, reader.id + ".done"))), { id: reader.id, completed: true });
});

test("index observation never launches an unapproved, stopped, foreign or modified runtime", async t => {
  const { f, home, exe, starts, health, setHealth, refresh } = await live_index_fixture(t);
  setHealth(health());
  assert.equal((await refresh()).managed[0].state, "running"); assert.equal(starts.length, 0);
  grant_preparation(f.state, f.root, ["code-index"]);
  process.env.EDT_AI_INSTANCE = "another";
  const other = await new SettingsBackend().main({ action: "refresh_readiness", scope: f.root + "#another", component: "code-index" });
  assert.equal(other.managed[0].state, "running"); assert.equal(starts.length, 0);
  process.env.EDT_AI_INSTANCE = "first";
  const ownerFile = path.join(home, "owner.json"), owner = JSON.parse(fs.readFileSync(ownerFile));
  for (const change of [value => value.pid++, value => value.project_root = f.base]) {
    const invalid = structuredClone(owner); change(invalid); fs.writeFileSync(ownerFile, JSON.stringify(invalid));
    const result = await refresh(); assert.equal(result.managed[0].state, "error"); assert.match(result.managed[0].detail, /Владелец/);
  }
  fs.writeFileSync(ownerFile, JSON.stringify(owner)); fs.writeFileSync(exe, "modified artifact");
  assert.match((await refresh()).managed[0].detail, protected_process_skip ? /Безопасное управление деревом/ : /исполняемый файл/);
  assert.equal(starts.length, 0);
  fs.writeFileSync(path.join(home, "daemon.json"), "{}");
  const unavailable = (await refresh()).managed[0];
  assert.equal(unavailable.state, "not_verified"); assert.equal(starts.length, 0);
  assert.match(unavailable.detail, /процесс может работать/);
  assert.doesNotMatch(unavailable.detail, /не запущен|разрешённую подготовку/);
});

testProtected("a temporary invalid index health response does not claim the live daemon is stopped", async t => {
  const { f, starts, health, setHealth, refresh } = await live_index_fixture(t);
  grant_preparation(f.state, f.root, ["code-index"]); setHealth(health());
  assert.equal((await refresh()).managed[0].state, "ready");
  const fetch = globalThis.fetch;
  const broken = t.mock.method(globalThis, "fetch", (url, options) => String(url).endsWith("/health")
    ? Promise.resolve(new Response("not JSON", { status: 200 })) : fetch(url, options));
  const unavailable = (await refresh()).managed[0];
  assert.equal(unavailable.state, "not_verified"); assert.match(unavailable.detail, /процесс может работать/);
  broken.mock.restore();
  assert.equal((await refresh()).managed[0].state, "ready"); assert.equal(starts.length, 2);
});

test("a failed component probe cannot replace other component results", async t => {
  const { f, backend, url } = await ready_fixture(t), config = backend.current();
  for (const id of ["code-index", "bsl-ls"]) Object.assign(config.mcp.managed[id], { enabled: true, mode: "external", url: url + (id === "code-index" ? "/index" : "/bsl") });
  fs.writeFileSync(f.env.EDT_AI_SETTINGS, JSON.stringify(config));
  await backend.main({ action: "update", set: { codeIndexEnabled: true, bslLsEnabled: true } });
  const main = backend.main.bind(backend);
  t.mock.method(backend, "main", (request, ...args) => request.action === "probe" && request.component === "openviking" && request.collectOnly
    ? Promise.reject(new Error("opaque-secret-from-broken-probe")) : main(request, ...args));
  const result = await main({ action: "refresh_readiness", scope: f.root + "#first" });
  assert.equal(result.componentChecks.find(item => item.id === "openviking").state, "not_verified");
  assert.equal(result.componentChecks.find(item => item.id === "code-index").state, "ready");
  assert.equal(result.componentChecks.find(item => item.id === "bsl-ls").state, "ready");
  assert.equal(JSON.stringify(result).includes("opaque-secret-from-broken-probe"), false);
});

test("automatic readiness verifies live managed APIs instead of relying on saved BSL LS evidence",async t=>{
  const {f,backend,url,count,settle,indexChecks}=await ready_fixture(t);
  const config=backend.current();
  for(const component of ["code-index","bsl-ls"])Object.assign(config.mcp.managed[component],{enabled:true,mode:"external",url:url+(component==="bsl-ls"?"/bsl":"/index")});
  fs.writeFileSync(f.env.EDT_AI_SETTINGS,JSON.stringify(config));
  await backend.main({action:"update",set:{codeIndexEnabled:true,bslLsEnabled:true}});
  fs.mkdirSync(path.join(f.root,".code-index"));fs.writeFileSync(path.join(f.root,".code-index/index.db"),"existing");settle();
  assert.equal((await backend.main({action:"read"})).summary.components.find(item=>item.id==="bsl-ls").status,"awaiting_observation");
  const calls=count(),result=await backend.main({action:"refresh_readiness",scope:f.root+"#first"});
  assert.ok(count()>calls);assert.equal(result.readiness,undefined);
  assert.equal(indexChecks(),2,"a startup health response without freshness is observed again before completing the check");
  for(const component of ["code-index","bsl-ls"]){
    assert.equal(result.managed.find(item=>item.name===component).ready,true);
    const current=await backend.main({action:"read"}),saved=current.componentChecks.find(item=>item.id===component);assert.equal(saved.state,"ready");assert.equal(saved.checkedAt,result.componentChecks.find(item=>item.id===component).checkedAt);
    assert.equal(current.summary.components.find(item=>item.id===component).mode,"external");
  }
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});

test("readiness never passes wrong EDT mappings or a connected server without tools",async t=>{
  const {backend,authorization,wrong,noTools}=await ready_fixture(t);wrong();noTools();
  const result=await backend.main({action:"check",authorization});assert.equal(result.readiness.state,"blocked");assert.equal(result.fullReadiness,"not_ready");
  assert.equal(result.external.edt.connected,true);assert.equal(result.external.edt.ready,false);
  assert.equal(result.external.v8std.connected,true);assert.equal(result.external.v8std.ready,false);
  assert.equal(result.readiness.checks.find(check=>check.id==="edt").state,"not_verified");
});

test("readiness includes enabled optional MCP and invalidates changed settings, expired or malformed receipts",async t=>{
  const {f,backend,authorization}=await ready_fixture(t);
  await backend.main({action:"check",authorization});
  const file=path.join(instance_directory(f.state,f.root),"first.readiness.json"),receipt=JSON.parse(fs.readFileSync(file));
  for (const invalid of [value => { value.result.checkedAt="invalid"; }, value => { value.result.checkedAt=new Date(Date.now()+60000).toISOString(); }, value => { delete value.fingerprint; }]) {
    const damaged=structuredClone(receipt);invalid(damaged);fs.writeFileSync(file,JSON.stringify(damaged));
    assert.equal((await backend.main({action:"read"})).readiness.state,"not_checked");
  }
  receipt.result.checkedAt=new Date(Date.now()-16*60*1000).toISOString();fs.writeFileSync(file,JSON.stringify(receipt));
  assert.equal((await backend.main({action:"read"})).readiness.state,"stale");
  fs.writeFileSync(file,'{"version":1,"result":{"state":"ready","checks":[null]}}');assert.equal((await backend.main({action:"read"})).readiness.state,"not_checked");
  await backend.main({action:"update",set:{openvikingEnabled:true,openvikingUrl:"https://knowledge.example/mcp"}});
  const result=await backend.main({action:"check",authorization});assert.equal(result.readiness.state,"blocked");assert.equal(result.external.openviking.ready,false);
  await backend.main({action:"update",set:{v8stdUrl:""}});assert.equal((await backend.main({action:"read"})).readiness.state,"stale");
});

test("missing skill files block local setup assets",t=>{
  const f=fixture(t),plugin=path.join(f.base,"plugin");
  const files={"plugin.json":"{}","mcp.json":"{}","policy/default.json":"{}","policy/read-only-mcp.mjs":"fixture","hooks/guard.mjs":"fixture","hooks/session-start.mjs":"fixture","skills/catalog.yaml":"active: [demo]","skills/demo/SKILL.md":"# Demo","hooks/hooks.json":JSON.stringify({hooks:{SessionStart:[{hooks:[{type:"command",command:"node session-start.mjs"}]}],PreToolUse:[{hooks:[{type:"command",command:"node guard.mjs"}]}]}})};
  for(const [name,text]of Object.entries(files)){const file=path.join(plugin,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
  assert.ok(setup_assets(plugin).checks.every(check=>check.state==="ready"));
  fs.rmSync(path.join(plugin,"skills/demo/SKILL.md"));assert.equal(setup_assets(plugin).checks.find(check=>check.id==="skills").state,"error");
});
