import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, environment, session, ROOT } from "./helpers.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { dump } from "../scripts/common.mjs";
import { profile_history } from "../scripts/profile_history.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { project_directory } from "../scripts/project_paths.mjs";
import { createServer } from "node:http";
import { once } from "node:events";
import { save_readiness } from "../scripts/setup_readiness.mjs";

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
  assert.match(checked.result.managed.find(item=>item.name==="code-index").detail,/не подготовлен/);
  assert.equal((await client.call("settings.read",{})).structuredContent.values.projectRoot,f.root);
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});

test("profile selection stays available during background readiness while writes remain serialized", async t => {
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
  const other=path.join(f.base,"other");fs.mkdirSync(other);dump(f.profile,path.join(other,".ai/project.yaml"));
  const selected=(await client.call("settings.select_profile",{projectRoot:other})).structuredContent;
  assert.equal(selected.viewOnly,false);assert.equal(selected.values.projectRoot,other);
  await assert.rejects(client.call("settings.update",{set:{edtUrl:""}}),/ещё выполняется/);
  assert.equal((await client.call("settings.edit",{})).isError,undefined);
  release();
  const done=(await client.call("settings.operation",{operationId:job.id,waitMs:10000})).structuredContent;
  assert.equal(done.status,"completed");assert.equal(done.projectRoot,f.root);assert.equal(done.result.projectRoot,f.root);
  const current=(await client.call("settings.read",{})).structuredContent;assert.equal(current.values.projectRoot,other);assert.equal(current.readiness.state,"not_checked");
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
  const saved = save_readiness(f.state, config, f.profile, managed, { edt: { configured: false, connected: false } });
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
  assert.equal((await backend.main({ action: "read" })).summary.components.find(item => item.id === "code-index").status, "stopped");
  f.profile.project.id = "changed"; f.save();
  assert.equal((await backend.main({ action: "read" })).summary.components.find(item => item.id === "bsl-ls").status, "check_stale");
  managed[1] = { name: "bsl-ls", ready: false, state: "error", detail: "API unavailable" };
  save_readiness(f.state, config, f.profile, managed, {});
  const failed = (await backend.main({ action: "read" })).summary.components.find(item => item.id === "bsl-ls");
  assert.equal(failed.status, "error"); assert.equal(failed.detail, "API unavailable");
  assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
});

test("loading settings returns fresh service status without a separate status request or preparation", async t => {
  const f = fixture(t); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  const initial = (await client.call("settings.read", {})).structuredContent;
  assert.equal(initial.summary?.components.find(item => item.id === "code-index")?.status, "stopped");
  assert.equal(initial.summary.components.find(item => item.id === "bsl-ls").status, "disabled");
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
  assert.equal(reloaded.summary.components.find(item => item.id === "code-index").status, "stopped");
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
      assert.equal(current.summary?.components.find(item => item.id === "code-index")?.status, content === null ? "stopped" : "not_checked");
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
  const client=await session(t,"mcp/settings.mjs",[],f);
  const preview=(await client.call("settings.select_profile",{projectRoot:other})).structuredContent;
  assert.equal(preview.viewOnly,true);assert.equal(preview.profile.projectId,"other");
  assert.equal(preview.summary?.components.find(item=>item.id==="code-index")?.status,"stopped");
  assert.equal(preview.chatProjectRoot,f.root);
  assert.equal((await client.call("settings.read",{})).structuredContent.values.projectRoot,f.root);
  const status=(await client.call("settings.status",{projectRoot:other})).structuredContent;
  assert.equal(status.viewOnly,true);assert.equal(status.values.projectRoot,other);
  assert.equal(status.summary.components.find(item=>item.id==="code-index").status,"stopped");
  const document=await client.call("settings.document",{projectRoot:other});
  assert.equal(document.structuredContent,undefined);
  assert.equal(JSON.parse(document._meta.data.text).profile.project.id,"other");
  assert.equal((await client.call("settings.read",{})).structuredContent.values.projectRoot,f.root);
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
  assert.equal(fs.existsSync(path.join(other,".ai/project.local.yaml")),false);
  await assert.rejects(client.call("settings.update",{set:{projectRoot:other}}),/текущей сессией/);
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
  assert.equal(selected.summary?.components.find(item=>item.id==="code-index")?.status,"stopped");
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

test("reset removes only this instance's URL and restores profile inheritance", async t => {
  const f=fixture(t);environment(t,f.env);
  f.profile.connections={edt:{url:"http://localhost:18191/mcp"},v8std:{url:"http://localhost:18192/mcp"}};f.save();
  const backend=new SettingsBackend(),before=fs.readFileSync(path.join(f.root,".ai/project.yaml"));
  await backend.main({action:"update",set:{edtUrl:"http://localhost:18193/mcp",v8stdUrl:"",bslLsEnabled:false}});
  assert.equal((await backend.main({action:"read"})).connectionSources.edt,"instance");
  await backend.main({action:"reset_connection",connection:"edt"});
  const read=await backend.main({action:"read"});
  assert.equal(read.values.edtUrl,"http://localhost:18191/mcp");assert.equal(read.connectionSources.edt,"profile");
  assert.equal(read.values.v8stdUrl,"");assert.equal(read.values.bslLsEnabled,false);
  assert.deepEqual(fs.readFileSync(path.join(f.root,".ai/project.yaml")),before);
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
